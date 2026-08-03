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

  if (last.analyzed > 0 && last.written === 0) {
    problems.push({
      text: "Ни один кадр партии не дошёл до резерва: либо все отсеяны как брак, либо не сгенерировались подписи.",
    });
  } else if (last.analyzed >= 4 && last.written <= last.analyzed / 4) {
    // источники дали материал, а анализ почти весь пропал - это почерк
    // кончившейся квоты, а не просевшего архива (живой прогон 03.08)
    problems.push({
      text:
        `До резерва дошло ${last.written} из ${last.analyzed} проанализированных - ` +
        "похоже, в середине сбора кончилась квота Gemini. Сброс в 10:00 МСК; " +
        "второй ключ в GEMINI_API_KEYS снял бы это совсем.",
    });
  }

  // резкое падение против недели - обычно значит, что архив поменял выдачу
  const prev = history.filter((r) => r.written > 0);
  if (prev.length >= 3) {
    const avg = prev.reduce((s, r) => s + r.written, 0) / prev.length;
    if (last.written > 0 && last.written < avg * DROP_RATIO) {
      problems.push({
        text:
          `Партия вдвое меньше обычной: ${last.written} против ~${Math.round(avg)} ` +
          "за последние дни. Стоит посмотреть, какой источник просел.",
      });
    }
  }

  return problems;
}

/** Читает историю, ищет проблемы и пишет в чат, только если они есть. */
export async function reportHealth(db: SupabaseClient, _cfg: AppConfig): Promise<void> {
  const { data, error } = await db
    .from("collect_runs")
    .select("raw, prefiltered, analyzed, written, sources")
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
