/**
 * Самодиагностика после сбора: бот сам замечает, что сломалось, и пишет
 * об этом в чат человеческими словами - до того, как это станет видно
 * в ленте пустыми слотами.
 *
 * Правило одно: сообщение отправляется, только когда есть что сказать.
 * Молчание = всё в порядке. Иначе предупреждения перестают читать.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AppConfig } from "./config.js";
import { env } from "./env.js";
import { sendMessageHtml } from "./telegram.js";

type RunRow = {
  raw: number;
  prefiltered: number;
  analyzed: number;
  written: number;
  /** кадры, сорванные лимитом Gemini: это не брак фильтров */
  quota_failed?: number | null;
  /** отсев ситом: слабая оценка и отсутствие крючка - это не поломка */
  junk?: number | null;
  hookless?: number | null;
  broken?: number | null;
  /** прогон оборван бюджетом времени: неразобранное возьмёт следующий сбор */
  out_of_time?: boolean | null;
  /** сбои сети и перегрузка Gemini (503, таймауты) - не брак и не квота */
  net_failed?: number | null;
  /** реальная очередь анализа после лимита партии и дедупа */
  queued?: number | null;
  sources: Record<string, number> | null;
};

/** Насколько партия должна просесть против средней, чтобы это считалось бедой. */
const DROP_RATIO = 0.5;
/** Сколько прошлых прогонов берём за норму. */
const HISTORY = 7;

export type HealthProblem = { text: string };

/**
 * Разбор истории прогонов. Чистая функция - её проверяют тесты, база
 * подставляется вызывающим.
 */
export function findProblems(last: RunRow, history: RunRow[]): HealthProblem[] {
  const problems: HealthProblem[] = [];

  // источник молчит или падает - это чинится, но только если знать
  for (const [name, count] of Object.entries(last.sources ?? {})) {
    if (count < 0) {
      problems.push({ text: `Источник ${name} не отвечает - партия собрана без него.` });
    } else if (count === 0) {
      problems.push({ text: `Источник ${name} не дал ни одной записи.` });
    }
  }

  if (last.raw > 0 && last.prefiltered === 0) {
    problems.push({
      text: "Из архивов пришли записи, но ни одна не прошла базовую проверку (год, размер, описание).",
    });
  }

  const quotaFailed = last.quota_failed ?? 0;
  if (last.analyzed > 0 && last.written === 0 && quotaFailed > 0) {
    // диагноз должен называть настоящую причину: 13.08 квота кончилась в
    // середине сбора, а бот отчитался про брак подписей - и поиски пошли
    // не туда
    problems.push({
      text:
        `Партия сорвана лимитом Gemini: ${quotaFailed} кадров не дошли до анализа, в резерв не попало ничего. ` +
        "Квота сбрасывается в 10:00 МСК.",
    });
  } else if (last.analyzed > 0 && last.written === 0) {
    // называем состав отсева поимённо. 16.08 бот написал «все отсеяны как
    // брак», хотя брака не было вовсе: четыре слабых кадра, один без
    // крючка и один сорванный сбоем Gemini - то есть сито отработало как
    // задумано, а сообщение выглядело как поломка
    const parts: string[] = [];
    if (last.junk) parts.push(`${last.junk} слабых по оценке`);
    if (last.hookless) parts.push(`${last.hookless} без крючка`);
    if (last.broken) parts.push(`${last.broken} с браком подписи`);
    if (last.net_failed) parts.push(`${last.net_failed} сорваны сбоями Gemini или сети`);
    const details = parts.length ? `: ${parts.join(", ")}` : "";
    // «сито виновато», если им отсеяно большинство партии: остаток могли
    // унести единичные сбои сети, и это не повод бить тревогу
    const bySieve = (last.junk ?? 0) + (last.hookless ?? 0);
    const allFiltered = bySieve * 2 >= last.analyzed;
    problems.push({
      text: allFiltered
        ? `Партия целиком отсеяна ситом${details}. Это не поломка - материал попался слабый; ` +
          "если так повторится подряд, стоит смотреть на источники, а не на фильтры."
        : `Ни один кадр партии не дошёл до резерва${details}.`,
    });
  } else if (last.analyzed >= 4 && last.written <= last.analyzed / 4) {
    // Низкий выход сам по себе больше не тревога: сито по крючку режет
    // две трети партии, и это норма. Жалуемся, только если потери НЕ
    // объяснены отсевом - тогда пропало непонятно куда.
    //
    // До 17.08 здесь стояла догадка «похоже, кончилась квота» с советом
    // добавить второй ключ. Догадка была неверной (квота считается
    // отдельно и была цела), а совет - устаревшим: ключ давно добавлен.
    const explained =
      (last.junk ?? 0) + (last.hookless ?? 0) + (last.broken ?? 0) + quotaFailed +
      (last.net_failed ?? 0);
    const lost = last.analyzed - last.written - explained;
    if (quotaFailed > 0) {
      problems.push({
        text:
          `До резерва дошло ${last.written} из ${last.analyzed}: ${quotaFailed} кадров сорвал лимит Gemini. ` +
          "Квота сбрасывается в 10:00 МСК.",
      });
    } else if (lost > 0) {
      problems.push({
        text:
          `До резерва дошло ${last.written} из ${last.analyzed}, и ${lost} кадров пропали без объяснения - ` +
          "это не отсев ситом. Стоит посмотреть лог сбора.",
      });
    }
  }

  // обрыв по бюджету времени - причина известна, гадать не надо. Живой
  // случай 24.08: вечерняя партия разобрала 3 из 29 (Gemini перегружен,
  // каждый запрос висел до таймаута), а сводка предложила «посмотреть,
  // какой источник просел» - хотя источники отдали полную партию
  if (last.out_of_time) {
    // считаем от реальной очереди анализа: 25.08 сводка написала «~62
    // кадров не дождались», взяв весь префильтр вместо очереди из 30
    const queue = last.queued ?? last.prefiltered;
    const left = Math.max(0, queue - last.analyzed);
    problems.push({
      text:
        `Прогон упёрся в бюджет времени: разобрано ${last.analyzed}, в резерв ${last.written}` +
        (left > 0 ? `, ещё ~${left} кадров не дождались очереди - их возьмёт следующий сбор.` : ".") +
        " Так бывает, когда Gemini или архивы отвечают медленно; квота при этом цела.",
    });
  }

  // резкое падение против недели - обычно значит, что архив поменял
  // выдачу. Но не когда прогон оборван бюджетом: там причина уже названа
  const prev = history.filter((r) => r.written > 0);
  if (prev.length >= 3 && !last.out_of_time) {
    const avg = prev.reduce((s, r) => s + r.written, 0) / prev.length;
    if (last.written > 0 && last.written < avg * DROP_RATIO) {
      // прежде чем гадать про источники, смотрим на собственный отсев
      // прогона. Живой случай 31.08: сито отсеяло 6 скучных из 8, брак
      // подписи забрал седьмого - а сводка предложила «посмотреть, какой
      // источник просел», хотя источники отдали полную партию
      const bySieve = (last.junk ?? 0) + (last.hookless ?? 0) + (last.broken ?? 0);
      const byNet = (last.net_failed ?? 0) + quotaFailed;
      if (last.analyzed > 0 && bySieve * 2 >= last.analyzed) {
        problems.push({
          text:
            `Партия мала (${last.written} против ~${Math.round(avg)} за последние дни), но источники ` +
            `отдали её полной: ${bySieve} из ${last.analyzed} отсеяло сито. Материал попался слабый - ` +
            "если так повторится подряд, стоит смотреть запросы к архивам.",
        });
      } else if (last.analyzed > 0 && byNet * 2 >= last.analyzed) {
        problems.push({
          text:
            `Партия мала (${last.written} против ~${Math.round(avg)} за последние дни): ` +
            `${byNet} кадров сорвали сбои Gemini или сети. Источники ни при чём.`,
        });
      } else {
        problems.push({
          text:
            `Партия вдвое меньше обычной: ${last.written} против ~${Math.round(avg)} ` +
            "за последние дни. Стоит посмотреть, какой источник просел.",
        });
      }
    }
  }

  return problems;
}

/** Читает историю, ищет проблемы и пишет в чат, только если они есть. */
export async function reportHealth(db: SupabaseClient, _cfg: AppConfig): Promise<void> {
  const { data, error } = await db
    .from("collect_runs")
    .select(
      "raw, prefiltered, analyzed, written, quota_failed, junk, hookless, broken, out_of_time, net_failed, queued, sources",
    )
    .order("started_at", { ascending: false })
    .limit(HISTORY + 1);
  if (error || !data?.length) return;

  const [last, ...history] = data as RunRow[];
  if (!last) return;
  const problems = findProblems(last, history);
  if (!problems.length) return;

  const lines = [
    "Сбор прошёл, но есть на что посмотреть:",
    "",
    ...problems.map((p) => `- ${p.text}`),
  ];
  try {
    await sendMessageHtml(env.editorsChatId, lines.join("\n"));
  } catch (err) {
    console.warn(`не отправил health-сводку: ${(err as Error).message}`);
  }
}
