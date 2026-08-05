/**
 * Сторож автодобора: решает, нужен ли внеплановый сбор.
 *
 * В автоматическом режиме редактор не обязан ничего нажимать - если резерв
 * тает, бот добирает сам. Чтобы не выжечь дневную квоту Gemini, добор
 * ограничен и по условию (мало готовых), и по числу заходов за сутки.
 *
 * Пишет need=true|false в $GITHUB_OUTPUT; при need=true сразу отмечает
 * заход в settings, чтобы параллельный запуск не удвоил расход.
 */
import { appendFileSync } from "node:fs";
import { loadConfig } from "../src/config.js";
import { getDb } from "../src/db.js";
import { loadBoolSetting, loadPublishTimes } from "../src/settings.js";
import { slotsPassed } from "../src/schedule.js";
import { countAvailable, planFromCounts, quotaDay } from "../src/reserve.js";

/** Ниже этого числа готовых кандидатов считаем резерв опасно тонким. */
const MIN_RESERVE = 6;
/** Сколько внеплановых сборов позволяем за сутки (квота Gemini). */
const MAX_PER_DAY = 2;

function say(need: boolean, reason: string, keep = 0) {
  console.log(`${need ? `добираем ${keep}` : "не добираем"}: ${reason}`);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `need=${need}\nkeep=${keep}\n`);
  }
}

async function main() {
  const cfg = loadConfig();
  const db = getDb();
  const now = new Date();
  const tz = cfg.publish.timezone;

  // ручной режим: карточки одобряют глазами, добор не наша забота
  const autoPublish = await loadBoolSetting("auto_publish", cfg.publish.auto_publish);
  if (!autoPublish) return say(false, "автопостинг выключен");

  const available = await countAvailable();

  // сколько слотов сегодня ещё впереди - столько постов и нужно как минимум
  const times = await loadPublishTimes(cfg.publish.times);
  const slotsLeft = Math.max(0, times.length - slotsPassed(now, times, tz));
  const needed = Math.max(MIN_RESERVE, slotsLeft);
  if (available >= needed) {
    return say(false, `готовых ${available}, хватает (нужно ${needed})`);
  }

  // размер партии считаем той же формулой, что и дневной сбор
  const { keep } = planFromCounts(available, times.length, cfg.collect.prefilter_keep);

  // заходы считаем по квотному окну Gemini (сутки от 10:00 МСК), а не по
  // календарю: ночная попытка на выжатой квоте не должна блокировать
  // сбор сразу после сброса
  const ymd = quotaDay(now);
  const { data: mark } = await db
    .from("settings")
    .select("value")
    .eq("key", "topup_runs")
    .maybeSingle();
  const stored = (mark?.value ?? {}) as { ymd?: string; count?: number };
  const doneToday = stored.ymd === ymd ? (stored.count ?? 0) : 0;
  if (doneToday >= MAX_PER_DAY) {
    return say(false, `готовых ${available}, но добор уже был ${doneToday} раза - бережём квоту`);
  }

  await db.from("settings").upsert({
    key: "topup_runs",
    value: { ymd, count: doneToday + 1 },
    updated_at: new Date().toISOString(),
  });
  say(
    true,
    `готовых ${available} при нужных ${needed}, заход ${doneToday + 1} из ${MAX_PER_DAY}`,
    keep,
  );
}

main().catch((err) => {
  console.error("сторож автодобора упал:", err);
  // сбой сторожа не должен запускать лишний сбор
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, "need=false\n");
  }
  process.exit(1);
});
