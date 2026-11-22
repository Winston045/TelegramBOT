/**
 * Сетка рубрик на живых данных, ничего не публикуя: какие посты и почему
 * она поставила бы в ближайшие слоты из текущего резерва, рядом - выбор
 * старого планировщика. По нему решаем, переключать ли feed_mode в on.
 *
 *   npx tsx scripts/feed-sim.ts [слотов, по умолчанию 12]
 */
import { loadConfig } from "../src/config.js";
import { getDb } from "../src/db.js";
import { loadPublishTimes } from "../src/settings.js";
import {
  EVENT_MEMORY_DAYS,
  HOME_NATION,
  RESERVE_TTL_DAYS,
  approvedPriority,
  archiveKey,
  eventKeys,
  headline,
  planAuto,
  postNation,
  weekShares,
  recentEvents,
  type PlanCandidate,
} from "../src/plan.js";
import { feedHistory, feedLabel, feedOf, markBlocked, marksOf, planGrid, type GridReason } from "../src/feed.js";

async function main() {
  const n = Number(process.argv[2]) || 12;
  const cfg = loadConfig();
  const db = getDb();
  const now = new Date();
  const times = await loadPublishTimes(cfg.publish.times);
  const fresh = new Date(now.getTime() - RESERVE_TTL_DAYS * 86_400_000).toISOString();
  const { data: reserve } = await db
    .from("candidates")
    .select("id, caption_html, score, tags, attribution, source, status, created_at")
    .in("status", ["new", "shown", "approved"])
    .is("scheduled_at", null)
    .not("caption_html", "is", null)
    .gte("created_at", fresh)
    .order("score", { ascending: false })
    .limit(60);
  const { data: memory } = await db
    .from("candidates")
    .select("attribution, source, tags, caption_html, published_at")
    .eq("status", "published")
    .gte("published_at", new Date(now.getTime() - EVENT_MEMORY_DAYS * 86_400_000).toISOString());
  const pool = ((reserve ?? []) as Array<PlanCandidate & { status: string }>).map((c) => ({
    ...c,
    priority: c.status === "approved" ? approvedPriority(c.created_at, now) : 0,
  }));
  const rows = (memory ?? []) as Array<{ tags?: never; caption_html?: string | null; published_at?: string | null; attribution?: string | null; source?: string | null }>;
  const history = feedHistory(
    rows,
    (r) => postNation(r),
    (r) => eventKeys(r),
    (r) => archiveKey(r.attribution) || (r.source ?? ""),
  );

  console.log(`резерв: ${pool.length}, история 14 дней: ${history.length}, постов в неделю: ${times.length * 7}`);
  const byFeed = new Map<string, number>();
  for (const c of pool) byFeed.set(feedOf(c), (byFeed.get(feedOf(c)) ?? 0) + 1);
  console.log(`резерв по рубрикам: ${[...byFeed].map(([k, v]) => `${feedLabel(k)} ${v}`).join(", ")}`);
  const marked = pool.filter((c) => marksOf(c).length);
  if (marked.length) console.log(`с метками: ${marked.map((c) => `#${c.id} ${marksOf(c).join("+")}`).join(", ")}`);

  const reasons: GridReason[] = [];
  let fallbacks = 0;
  const grid = planGrid(
    pool,
    history,
    n,
    {
      now,
      nationOf: (c) => postNation(c),
      eventsOf: (c) => eventKeys(c),
      homeNation: HOME_NATION,
      postsPerWeek: times.length * 7,
      onFallback: () => fallbacks++,
      archiveOf: (c) => archiveKey(c.attribution) || (c.source ?? ""),
    },
    reasons,
  );
  console.log(`\nСЕТКА: ${grid.length} из ${n} слотов${fallbacks ? `, мягкие правила снимались ${fallbacks} раз` : ""}`);
  grid.forEach((c, i) => {
    const r = reasons.find((x) => x.id === c.id);
    console.log(
      `  ${String(i + 1).padStart(2)}. #${c.id} [${feedLabel(feedOf(c))}] ${postNation(c) || "-"}${marksOf(c).length ? ` {${marksOf(c).join(",")}}` : ""} ${c.score} - ${headline(c.caption_html, 70)}`,
    );
    if (r) console.log(`      ${r.why}`);
  });

  // кого сетка не взяла и почему: событие и метки - жёсткие лимиты
  const taken = new Set(grid.map((c) => c.id));
  const histEvents = new Set(history.flatMap((p) => p.events));
  const rest = pool.filter((c) => !taken.has(c.id));
  if (rest.length) console.log("\nне взяты:");
  for (const c of rest) {
    const why: string[] = [];
    const ev = eventKeys(c).filter((k) => histEvents.has(k));
    if (ev.length) why.push(`событие уже было за 14 дней: ${ev.join(", ")}`);
    const blocked = marksOf(c).filter((m) => markBlocked(m, history, now));
    if (blocked.length) why.push(`лимит метки: ${blocked.join(", ")}`);
    if (!why.length) why.push("слотов не хватило или событие совпало с выбранным в этом же плане");
    console.log(`  #${c.id} [${feedLabel(feedOf(c))}] ${headline(c.caption_html, 60)} - ${why.join("; ")}`);
  }

  const weekAgo = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const recent = {
    subjects: [],
    civilian: false,
    ...weekShares((memory ?? []).filter((r) => (r.published_at ?? "") >= weekAgo) as never),
    weekEvents: recentEvents(rows as never),
  };
  const old = planAuto(pool, recent as never, n);
  console.log(`\nСТАРЫЙ ПЛАНИРОВЩИК (упрощённый контекст): ${old.length} из ${n}`);
  old.forEach((c, i) =>
    console.log(`  ${String(i + 1).padStart(2)}. #${c.id} [${feedLabel(feedOf(c))}]${marksOf(c).length ? ` {${marksOf(c).join(",")}}` : ""} ${c.score} - ${headline(c.caption_html, 70)}`),
  );
}

main().catch((err) => {
  console.error("симуляция сетки упала:", err);
  process.exit(1);
});
