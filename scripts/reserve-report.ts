/**
 * Быстрая сводка резерва: счётчики по статусам и список готовых к
 * автопостингу (new/shown) - когда собран, оценка, первая строка подписи.
 * Нужна, чтобы сверять состояние базы, не заходя в Supabase.
 */
import { getDb } from "../src/db.js";
import { loadConfig } from "../src/config.js";
import { loadBoolSetting, loadPublishTimes } from "../src/settings.js";
import { countPublishedToday, slotsPassed } from "../src/schedule.js";

const STYLE_CUTOFF = "2026-07-29T15:10:00Z";

async function main() {
  const db = getDb();

  // почему публикатор молчит: расписание, тумблер, счётчик слотов
  const cfg = loadConfig();
  const now = new Date();
  const tz = cfg.publish.timezone;
  const times = await loadPublishTimes(cfg.publish.times);
  const autoPublish = await loadBoolSetting("auto_publish", cfg.publish.auto_publish);
  const { data: pub } = await db
    .from("candidates")
    .select("published_at")
    .eq("status", "published")
    .gte("published_at", new Date(now.getTime() - 48 * 3600 * 1000).toISOString());
  const publishedToday = countPublishedToday(
    (pub ?? []).map((r) => r.published_at),
    now,
    tz,
  );
  const passed = slotsPassed(now, times, tz);
  console.log(
    `расписание (${tz}): ${times.join(", ") || "(пусто!)"}\n` +
      `автопостинг: ${autoPublish ? "включён" : "выключен"}; ` +
      `слотов прошло сегодня: ${passed}; опубликовано: ${publishedToday}; ` +
      `публикатор ${publishedToday < passed ? "должен публиковать" : "ждёт слота"}\n`,
  );

  const { data: all, error } = await db
    .from("candidates")
    .select("id, status, score, created_at, caption_html")
    .order("id", { ascending: true });
  if (error) throw new Error(error.message);

  const byStatus = new Map<string, number>();
  for (const c of all ?? []) byStatus.set(c.status, (byStatus.get(c.status) ?? 0) + 1);
  console.log("по статусам:", [...byStatus.entries()].map(([s, n]) => `${s}=${n}`).join(", "));

  const ready = (all ?? []).filter(
    (c) => (c.status === "new" || c.status === "shown") && c.caption_html,
  );
  console.log(`\nготовы к автопостингу (new/shown с подписью): ${ready.length}`);
  for (const c of ready) {
    const firstLine = c.caption_html.replace(/<[^>]+>/g, "").split("\n")[0]?.slice(0, 80);
    const style = c.created_at < STYLE_CUTOFF ? "СТАРЫЙ СТИЛЬ!" : "новый стиль";
    console.log(`  #${c.id} score=${c.score} собран=${c.created_at} [${style}]`);
    console.log(`     ${firstLine}`);
  }

  const approved = (all ?? []).filter((c) => c.status === "approved");
  console.log(`\nв очереди одобренных: ${approved.length}`);
  for (const c of approved) {
    const firstLine = (c.caption_html ?? "").replace(/<[^>]+>/g, "").split("\n")[0]?.slice(0, 80);
    const style = c.created_at < STYLE_CUTOFF ? "СТАРЫЙ СТИЛЬ!" : "новый стиль";
    console.log(`  #${c.id} score=${c.score} собран=${c.created_at} [${style}]`);
    console.log(`     ${firstLine}`);
  }
}

main().catch((err) => {
  console.error("reserve-report упал:", err);
  process.exit(1);
});
