/**
 * Утренняя сводка в чат редакторов: очередь, план на сегодня, здоровье.
 * Запускается в конце ежедневного воркфлоу, после отправки карточек.
 */
import { loadConfig } from "../src/config.js";
import { getDb } from "../src/db.js";
import { env } from "../src/env.js";
import { sendMessageHtml } from "../src/telegram.js";
import { countPublishedToday, slotsPassed } from "../src/schedule.js";
import { loadPublishTimes } from "../src/settings.js";

function moscow(iso: string | null): string {
  if (!iso) return "давно";
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}

async function count(status: string): Promise<number> {
  const { count } = await getDb()
    .from("candidates")
    .select("id", { count: "exact", head: true })
    .eq("status", status);
  return count ?? 0;
}

async function main() {
  const cfg = loadConfig();
  const db = getDb();
  const now = new Date();
  const tz = cfg.publish.timezone;

  const [shown, queued] = await Promise.all([count("shown"), count("approved")]);

  const twoDaysAgo = new Date(now.getTime() - 48 * 3600 * 1000).toISOString();
  const { data: recent } = await db
    .from("candidates")
    .select("published_at")
    .eq("status", "published")
    .gte("published_at", twoDaysAgo);
  const publishedToday = countPublishedToday(
    (recent ?? []).map((r) => r.published_at),
    now,
    tz,
  );

  const { data: hb } = await db
    .from("heartbeats")
    .select("last_ok, last_error")
    .eq("job", "collector")
    .maybeSingle();

  // какие слоты сегодня ещё впереди (расписание из бота важнее config.yaml)
  const times = await loadPublishTimes(cfg.publish.times);
  const passed = slotsPassed(now, times, tz);
  const slotsLeft = times.slice(passed);
  const willGo = Math.min(queued, slotsLeft.length);

  const lines = [
    "Сводка на утро",
    "",
    `Новых карточек на разбор: ${shown}`,
    `В очереди публикации: ${queued}`,
    willGo > 0
      ? `Сегодня выйдут: ${slotsLeft.slice(0, willGo).join(", ")} (МСК)`
      : queued === 0
        ? "Сегодня публиковать нечего - одобрите карточки"
        : `Слоты на сегодня уже прошли, очередь пойдёт завтра с ${times[0]}`,
    `Уже вышло сегодня: ${publishedToday}`,
    "",
    `Последний сбор: ${moscow(hb?.last_ok ?? null)}${hb?.last_error ? " - была ошибка, смотрите /status" : ""}`,
  ];

  await sendMessageHtml(env.editorsChatId, lines.join("\n"));
  console.log("сводка отправлена");
}

main().catch((err) => {
  console.error("сводка упала:", err);
  process.exit(1);
});
