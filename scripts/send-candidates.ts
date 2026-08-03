/**
 * Этап 5 - раз в сутки отдать свежих кандидатов редакторам.
 *
 * Берёт из candidates status='new' по убыванию score, прогоняет через
 * балансир тегов, шлёт карточки в групповой чат и помечает shown.
 */
import { loadConfig } from "../src/config.js";
import { getDb } from "../src/db.js";
import { env } from "../src/env.js";
import { pickBalanced } from "../src/balance.js";
import { rank, type PlanCandidate } from "../src/plan.js";
import { buildServiceLine } from "../src/service_line.js";
import { sendMessageHtml, sendPhotoHtml } from "../src/telegram.js";
import { visibleLength, CAPTION_LIMIT } from "../src/validate.js";
import { heartbeatError, heartbeatOk } from "../src/heartbeat.js";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/** --limit 3 - переопределить число карточек (по умолчанию daily_candidates). */
function limitArg(): number | undefined {
  const i = process.argv.indexOf("--limit");
  if (i === -1) return undefined;
  const n = Number(process.argv[i + 1]);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

async function recentSubjectCounts(): Promise<Map<string, number>> {
  const weekAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  const { data, error } = await getDb()
    .from("candidates")
    .select("tags")
    .gte("shown_at", weekAgo);
  if (error) throw new Error(`чтение недавних тегов: ${error.message}`);

  const counts = new Map<string, number>();
  for (const row of data) {
    const subject = (row.tags as { subject?: string } | null)?.subject;
    if (subject) counts.set(subject, (counts.get(subject) ?? 0) + 1);
  }
  return counts;
}

async function main() {
  const cfg = loadConfig();
  const db = getDb();

  const { data: fresh, error } = await db
    .from("candidates")
    .select("id, source, image_url, caption_html, quote_kind, tags, score")
    .eq("status", "new")
    .not("caption_html", "is", null)
    .order("score", { ascending: false });
  if (error) throw new Error(`чтение кандидатов: ${error.message}`);

  // карточки сортируем тем же рангом, что и очередь публикации: скидка
  // старым эпохам и статике, фора цвету - иначе чат видит другой отбор
  const ordered = [...fresh].sort(
    (a, b) => rank(b as PlanCandidate) - rank(a as PlanCandidate),
  );
  const picked = pickBalanced(
    ordered,
    await recentSubjectCounts(),
    limitArg() ?? cfg.collect.daily_candidates,
    cfg.balance.max_same_tag_per_week,
  );
  console.log(`кандидатов new: ${fresh.length}, после балансира: ${picked.length}`);

  let sent = 0;
  for (const c of picked) {
    const serviceLine = buildServiceLine(c);
    const withService = `${c.caption_html}\n\n${serviceLine}`;
    const buttons = {
      inline_keyboard: [
        [
          { text: "Одобрить", callback_data: `ok:${c.id}` },
          { text: "Мимо", callback_data: `skip:${c.id}` },
        ],
      ],
    };

    try {
      // служебная строка едет в той же подписи; если вдруг не влезает -
      // отдельным ответом на карточку
      if (visibleLength(withService) <= CAPTION_LIMIT) {
        await sendPhotoHtml(env.editorsChatId, c.image_url, withService, buttons);
      } else {
        await sendPhotoHtml(env.editorsChatId, c.image_url, c.caption_html, buttons);
        await sendMessageHtml(env.editorsChatId, serviceLine);
      }
    } catch (err) {
      console.warn(`  карточка #${c.id} не отправилась: ${(err as Error).message}`);
      continue;
    }

    const { error: updErr } = await db
      .from("candidates")
      .update({ status: "shown", shown_at: new Date().toISOString() })
      .eq("id", c.id);
    if (updErr) throw new Error(`пометка shown #${c.id}: ${updErr.message}`);

    sent++;
    await sleep(1500); // бережём лимиты бота
  }

  console.log(`отправлено карточек: ${sent}`);
  await heartbeatOk("collector");
}

main().catch(async (err) => {
  console.error("отправка редакторам упала:", err);
  try {
    await heartbeatError("collector", String(err));
  } catch {
    // база недоступна - heartbeat-проверка увидит устаревший last_ok
  }
  process.exit(1);
});
