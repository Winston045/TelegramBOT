/**
 * Ночная вычитка резерва (src/proofread.ts): посты, которые выйдут
 * ближайшими, перечитывает полноценная модель - только язык, без фактов.
 * Крон 04:30 МСК (proofread.yml), на остатке суточной квоты Gemini.
 *
 * Запуск: npx tsx scripts/proofread.ts [сколько постов, по умолчанию 12] [--dry]
 */
import { getDb } from "../src/db.js";
import { geminiJson, GeminiQuotaError } from "../src/gemini.js";
import { RESERVE_TTL_DAYS } from "../src/plan.js";
import { applyFixes, buildProofreadPrompt, rejectFix, textSegments } from "../src/proofread.js";
import { validateCaption } from "../src/validate.js";

const LIMIT = Number(process.argv.find((a) => /^\d+$/.test(a))) || 12;
const DRY = process.argv.includes("--dry");

type Row = {
  id: number;
  caption_html: string;
  tags: Record<string, unknown> | null;
  scheduled_at: string | null;
  score: number | null;
  title: string | null;
  description: string | null;
  year: number | null;
  place: string | null;
};

async function main() {
  const db = getDb();
  const since = new Date(Date.now() - RESERVE_TTL_DAYS * 86_400_000).toISOString();
  const { data, error } = await db
    .from("candidates")
    .select("id, caption_html, tags, scheduled_at, score, title:raw_title, description:raw_desc, year, place")
    .in("status", ["new", "shown", "approved"])
    .not("caption_html", "is", null)
    .gte("created_at", since)
    .order("score", { ascending: false });
  if (error) throw new Error(error.message);
  // сначала посты на время (они выйдут точно), потом лучшие по оценке -
  // их планировщик возьмёт раньше
  const todo = ((data ?? []) as Row[])
    .filter((r) => !r.tags?.proofread)
    .sort((a, b) => Number(Boolean(b.scheduled_at)) - Number(Boolean(a.scheduled_at)))
    .slice(0, LIMIT);
  console.log(`к вычитке: ${todo.length} (не вычитанных в резерве: ${(data ?? []).filter((r) => !(r as Row).tags?.proofread).length})`);

  let fixedPosts = 0;
  let checked = 0;

  const proofreadRow = async (row: Row): Promise<"done" | "retry" | "stop"> => {
    const segments = textSegments(row.caption_html);
    if (!segments.length) return "done";
    let answer: { segments?: unknown };
    try {
      answer = await geminiJson<{ segments?: unknown }>(
        [{ text: buildProofreadPrompt(segments.map((s) => s.text)) }],
        { fullOnly: true, temperature: 0 },
      );
    } catch (err) {
      // полноценных моделей не осталось - вычитка подождёт следующей ночи;
      // облегчённой корректуру не доверяем
      const msg = (err as Error).message;
      if (err instanceof GeminiQuotaError || /полноценной модели|квот/i.test(msg)) {
        console.warn(`квота полноценных моделей кончилась - остальное вычитаем следующей ночью (${msg})`);
        return "stop";
      }
      console.warn(`  #${row.id}: корректор не ответил - ${msg}`);
      return "retry";
    }
    checked++;
    const out = Array.isArray(answer.segments) ? answer.segments : [];
    if (out.length !== segments.length) {
      console.warn(`  #${row.id}: корректор вернул ${out.length} кусков из ${segments.length} - правки отброшены`);
      return "done";
    }
    const fixes: Array<{ raw: string; text: string }> = [];
    segments.forEach((seg, i) => {
      const after = String(out[i] ?? "").trim();
      if (after === seg.text) return;
      const why = rejectFix(seg.text, after);
      if (why) {
        console.log(`  #${row.id}: правка отклонена (${why}): «${seg.text.slice(0, 80)}»`);
        return;
      }
      console.log(`  #${row.id}: «${seg.text}»\n        → «${after}»`);
      fixes.push({ raw: seg.raw, text: after });
    });

    let caption = row.caption_html;
    if (fixes.length) {
      caption = applyFixes(row.caption_html, fixes);
      // вычитанная подпись проходит тот же валидатор, что и при сборе.
      // Справок сбора здесь нет, поэтому сравниваем с исходной подписью:
      // правка не должна сделать хуже то, что валидатор пропускал
      const meta = {
        title: row.title ?? undefined,
        description: row.description ?? undefined,
        year: row.year ?? undefined,
        place: row.place ?? undefined,
      };
      const check = validateCaption(caption, meta);
      if (!check.ok && validateCaption(row.caption_html, meta).ok) {
        console.warn(`  #${row.id}: после правки валидатор против (${check.reason}) - подпись не тронута`);
        caption = row.caption_html;
        fixes.length = 0;
      }
    }
    if (fixes.length) fixedPosts++;
    if (DRY) return "done";
    const { error: upErr } = await db
      .from("candidates")
      .update({
        caption_html: caption,
        tags: { ...(row.tags ?? {}), proofread: new Date().toISOString().slice(0, 10), proofread_fixes: fixes.length },
      })
      .eq("id", row.id)
      // пост мог уйти в канал, пока шла вычитка - тогда не трогаем
      .in("status", ["new", "shown", "approved"]);
    if (upErr) console.warn(`  #${row.id}: не записал - ${upErr.message}`);
    return "done";
  };

  // корректор не ответил из-за перегрузки - пост пробуем ещё раз в конце,
  // после минутной паузы: пробная вычитка 15.11 потеряла так два из двенадцати
  const retry: Row[] = [];
  let stopped = false;
  for (const row of todo) {
    const r = await proofreadRow(row);
    if (r === "stop") {
      stopped = true;
      break;
    }
    if (r === "retry") retry.push(row);
  }
  if (!stopped && retry.length) {
    console.log(`повторный заход по ${retry.length} отложенным, пауза 60 с`);
    await new Promise((r) => setTimeout(r, 60_000));
    for (const row of retry) {
      if ((await proofreadRow(row)) === "stop") break;
    }
  }
  console.log(`вычитано: ${checked}, с правками: ${fixedPosts}${DRY ? " (dry - база не тронута)" : ""}`);
}

main().catch((err) => {
  console.error("вычитка упала:", err);
  process.exit(1);
});
