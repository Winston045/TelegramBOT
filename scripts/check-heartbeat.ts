/**
 * Этап 8 — сторож. Если коллектор не отчитывался сутки (или публикатор
 * два часа) — сообщение в чат редакторов с текстом последней ошибки.
 *
 * Чтобы не спамить каждые 6 часов, отметка о последнем алерте хранится
 * в той же таблице heartbeats строкой job='watchdog'.
 */
import { getDb } from "../src/db.js";
import { env } from "../src/env.js";
import { sendMessageHtml } from "../src/telegram.js";

const COLLECTOR_MAX_AGE_H = 26; // суточный крон + запас на опоздания
const PUBLISHER_MAX_AGE_H = 2;  // крон каждые 15 минут
const ALERT_THROTTLE_H = 20;    // не чаще одного алерта в ~сутки

function hoursSince(iso: string | null): number {
  if (!iso) return Infinity;
  return (Date.now() - new Date(iso).getTime()) / 3_600_000;
}

async function main() {
  const db = getDb();
  const { data, error } = await db.from("heartbeats").select("job, last_ok, last_error");
  if (error) throw new Error(`чтение heartbeats: ${error.message}`);

  const byJob = new Map(data.map((r) => [r.job as string, r]));
  const problems: string[] = [];

  for (const [job, maxAge] of [
    ["collector", COLLECTOR_MAX_AGE_H],
    ["publisher", PUBLISHER_MAX_AGE_H],
  ] as const) {
    const row = byJob.get(job);
    const age = hoursSince(row?.last_ok ?? null);
    if (age > maxAge) {
      const ageText = age === Infinity ? "никогда" : `${Math.round(age)} ч назад`;
      problems.push(
        `Сбой: ${job} — последний успех ${ageText}.` +
          (row?.last_error ? `\nОшибка: ${row.last_error}` : ""),
      );
    }
  }

  if (problems.length === 0) {
    console.log("все процессы живы");
    return;
  }
  console.log(problems.join("\n"));

  if (hoursSince(byJob.get("watchdog")?.last_ok ?? null) < ALERT_THROTTLE_H) {
    console.log("алерт уже отправлялся недавно — молчим");
    return;
  }

  await sendMessageHtml(env.editorsChatId, problems.join("\n\n"));
  const { error: updErr } = await db
    .from("heartbeats")
    .upsert({ job: "watchdog", last_ok: new Date().toISOString() });
  if (updErr) throw new Error(`отметка watchdog: ${updErr.message}`);
}

main().catch((err) => {
  console.error("проверка heartbeat упала:", err);
  process.exit(1);
});
