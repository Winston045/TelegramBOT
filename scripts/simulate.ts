/**
 * Сухой прогон подбора: показывает, ЧТО реально выйдет в ленту и в
 * карточки, ничего не публикуя и не тратя квоту Gemini.
 *
 * Часть 1 - сбор сырья из архивов без анализа: сколько отдал каждый
 * архив и как выглядит очередь «на анализ» после перемешивания.
 * Часть 2 - симуляция ленты: планировщик прогоняется по кругу на
 * текущем резерве, как будто слоты идут один за другим.
 * Часть 3 - симуляция /more: партии карточек через балансир.
 *
 * Запуск: npx tsx scripts/simulate.ts [--no-fetch]
 */
import { loadConfig } from "../src/config.js";
import { getDb } from "../src/db.js";
import { collectRaw, interleaveBySource, lastSourceCounts } from "../src/sources/index.js";
import { byPromise } from "../src/promise.js";
import { buildAnalysisQueue } from "../src/queue.js";
import { memoryCursorStore } from "../src/cursors.js";
import { prefilter } from "../src/prefilter.js";
import { pickBalanced } from "../src/balance.js";
import {
  APPROVED_PRIORITY,
  LONG_QUOTE,
  RECENT_WINDOW,
  RESERVE_TTL_DAYS,
  archiveKey,
  planAuto,
  postNation,
  quoteLength,
  rank,
  weekShares,
  type PlanCandidate,
} from "../src/plan.js";
import { passesGate } from "../src/scoring.js";

type Row = PlanCandidate & {
  tags: {
    subject?: string;
    period?: string;
    military?: boolean;
    action?: boolean;
    rubric?: string;
  } | null;
};

/** Распределение значений: «bundesarchiv×3, iwm×2». */
function spread(values: string[]): string {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v || "(нет)", (counts.get(v || "(нет)") ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${k}×${n}`)
    .join(", ");
}

/** Есть ли два одинаковых значения подряд - главный признак «потока». */
function hasRuns(values: string[]): string[] {
  const runs: string[] = [];
  for (let i = 1; i < values.length; i++) {
    if (values[i] && values[i] === values[i - 1]) runs.push(`${i}-${i + 1}: ${values[i]}`);
  }
  return runs;
}

async function simulateCollect(cfg: ReturnType<typeof loadConfig>) {
  console.log("═══ 1. СБОР: кто сколько отдаёт и что доходит до анализа ═══\n");
  // курсоры в памяти: симуляция ничего не публикует и не должна двигать
  // боевые страницы выдачи. С курсорами из базы каждый прогон симуляции
  // молча пролистывал ~150 кадров, и настоящий сбор их уже не видел
  const cursors = memoryCursorStore();
  const raw = await collectRaw(cfg, cfg.collect.raw_limit, cursors);
  console.log("\nпо источникам:", JSON.stringify(lastSourceCounts));
  console.log(`сырых записей: ${raw.length}`);
  console.log("по архивам:", spread(raw.map((r) => archiveKey(r.attribution) || r.source)));

  const { kept } = prefilter(raw, cfg);
  // тот же путь, что у живого сбора: обещание → перемешивание → потолки.
  // Диагностика 04.09 показала расхождение: симуляция строила очередь
  // по-старому и рисовала LOC×7 и три дубля названия, которых живой
  // сбор уже не допускает
  const { queue, cuts } = buildAnalysisQueue(
    interleaveBySource(byPromise(kept)),
    cfg.collect.prefilter_keep,
  );
  console.log(`\nпосле префильтра: ${kept.length}, на анализ пойдут: ${queue.length}`);
  console.log(
    `потолки очереди: дублей названий ${cuts.duplicates}, придержано потолком архива ${cuts.archiveCapped}, ` +
      `ВМВ ${cuts.ww2Capped}, страны ${cuts.nationCapped}, рубрик сверх потолка ${cuts.rubricCapped}`,
  );
  console.log("очередь на анализ по архивам:");
  queue.forEach((item, i) => {
    console.log(`  ${i + 1}. ${archiveKey(item.attribution) || item.source} - ${item.title?.slice(0, 60) ?? "(без названия)"}`);
  });
  const archives = queue.map((q) => archiveKey(q.attribution) || q.source);
  console.log("\nсводка очереди:", spread(archives));
  const runs = hasRuns(archives);
  console.log(runs.length ? `ПОДРЯД ОДИН АРХИВ: ${runs.join("; ")}` : "подряд одинаковых архивов нет");
}

async function simulateFeed(cfg: ReturnType<typeof loadConfig>, steps = 21) {
  console.log("\n═══ 2. ЛЕНТА: что выйдет в канал следующими постами (неделя при трёх в день) ═══\n");
  const db = getDb();
  // пул - ровно как у публикатора: одобренные с подписью (ярус выше) и
  // резерв не старше срока годности. Раньше симуляция брала весь резерв
  // без срока и без яруса - и рисовала ленту, которой не будет
  const ttl = new Date(Date.now() - RESERVE_TTL_DAYS * 24 * 3600 * 1000).toISOString();
  const fields = "id, caption_html, score, tags, attribution, source, status, created_at";
  const [approvedRes, reserveRes] = await Promise.all([
    db.from("candidates").select(fields).eq("status", "approved").not("caption_html", "is", null),
    db
      .from("candidates")
      .select(fields)
      .in("status", ["new", "shown"])
      .not("caption_html", "is", null)
      .gte("created_at", ttl),
  ]);
  if (approvedRes.error) throw new Error(approvedRes.error.message);
  if (reserveRes.error) throw new Error(reserveRes.error.message);
  type Pooled = Row & { status?: string; created_at?: string; source?: string | null };
  const approved = (approvedRes.data ?? []) as Pooled[];
  const reserve = (reserveRes.data ?? []) as Pooled[];
  console.log(`одобренных: ${approved.length}, резерв в сроке годности: ${reserve.length}`);
  const stale = approved.filter((c) => (c.created_at ?? "") < ttl);
  if (stale.length) {
    console.log(
      `  одобренных старше ${RESERVE_TTL_DAYS} дней: ${stale.length} (` +
        stale.map((c) => `#${c.id} от ${c.created_at?.slice(0, 10)}`).join(", ") +
        ")",
    );
  }
  if (!approved.length && !reserve.length) return;

  // старт - настоящие последние посты канала и недельные доли, как у публикатора
  const weekAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  const [{ data: weekPosts }, { data: lastPosts }] = await Promise.all([
    db
      .from("candidates")
      .select("attribution, source, tags, caption_html")
      .eq("status", "published")
      .gte("published_at", weekAgo),
    db
      .from("candidates")
      .select("attribution, source, tags, caption_html")
      .eq("status", "published")
      .order("published_at", { ascending: false })
      .limit(RECENT_WINDOW),
  ]);
  const shares = weekShares((weekPosts ?? []) as Array<Row>);
  const last = (lastPosts ?? []) as Row[];
  const window: Row[] = [...last];

  const pool: Array<Pooled & { priority?: number }> = [
    ...approved.map((c) => ({ ...c, priority: APPROVED_PRIORITY })),
    ...reserve,
  ];
  const feed: Pooled[] = [];
  for (let i = 0; i < steps && pool.length; i++) {
    const w = window.slice(0, RECENT_WINDOW);
    const recent = {
      subjects: w.map((p) => p.tags?.subject ?? "").filter(Boolean),
      periods: w.map((p) => p.tags?.period ?? ""),
      civilian: w.some((p) => p.tags?.military === false),
      statics: w.filter((p) => p.tags?.action === false).length,
      longs: w.filter((p) => quoteLength(p.caption_html ?? null) >= LONG_QUOTE).length,
      archives: w.map((p) => archiveKey(p.attribution) || (p.source ?? "")),
      nations: w.map((p) => postNation(p)),
      rubrics: w.map((p) => p.tags?.rubric ?? ""),
      ...shares,
    };
    const [pick] = planAuto(pool, recent, 1);
    if (!pick) break;
    const row = pool.find((c) => c.id === pick.id)!;
    feed.push(row);
    pool.splice(pool.indexOf(row), 1);
    window.unshift(row);
    if (row.tags?.rubric) shares.rubricWeek[row.tags.rubric] = (shares.rubricWeek[row.tags.rubric] ?? 0) + 1;
  }

  feed.forEach((row, i) => {
    const head = (row.caption_html ?? "").replace(/<[^>]+>/g, "").split("\n")[0]?.slice(0, 52);
    const kind = row.status === "approved" ? "одобр" : "резерв";
    const rubric = row.tags?.rubric ? ` {${row.tags.rubric}}` : "";
    console.log(
      `${String(i + 1).padStart(2)}. #${row.id} ${kind} ${row.score ?? "?"} [${archiveKey(row.attribution) || "?"} · ${postNation(row) || "?"}]` +
        ` ${row.tags?.period ?? "?"}/${row.tags?.subject ?? "?"}${rubric} - ${head}`,
    );
  });

  const nations = feed.map((r) => postNation(r));
  const archives = feed.map((r) => archiveKey(r.attribution));
  const periods = feed.map((r) => r.tags?.period ?? "");
  const subjects = feed.map((r) => r.tags?.subject ?? "");
  console.log("\nстраны постов:", spread(nations));
  console.log("архивы:", spread(archives));
  console.log("эпохи:", spread(periods));
  console.log("темы:", spread(subjects));
  console.log(
    `одобренных в ленте: ${feed.filter((r) => r.status === "approved").length} из ${feed.length}, ` +
      `изюминок: ${feed.filter((r) => quoteLength(r.caption_html ?? null) >= LONG_QUOTE).length}, ` +
      `рубрик: ${feed.filter((r) => r.tags?.rubric).length}`,
  );
  if (feed.length < steps) console.log(`ВНИМАНИЕ: резерва хватило только на ${feed.length} постов из ${steps}`);
  const archRuns = hasRuns(archives);
  const nationRuns = hasRuns(nations.map((n) => n || ""));
  const perRuns = hasRuns(periods);
  console.log(archRuns.length ? `АРХИВ ПОДРЯД: ${archRuns.join("; ")}` : "архивы чередуются - подряд одинаковых нет");
  console.log(nationRuns.length ? `СТРАНА ПОДРЯД: ${nationRuns.join("; ")}` : "страны чередуются - подряд одинаковых нет");
  console.log(
    perRuns.length > 1 ? `эпоха подряд: ${perRuns.join("; ")}` : "эпохи чередуются в норме (допускается две подряд)",
  );
}

async function simulateCards(cfg: ReturnType<typeof loadConfig>, batches = 3) {
  console.log("\n═══ 3. КАРТОЧКИ /more: партии по 2 ═══\n");
  const db = getDb();
  const { data } = await db
    .from("candidates")
    .select("id, caption_html, score, tags, attribution")
    .eq("status", "new")
    .not("caption_html", "is", null)
    .order("score", { ascending: false });
  const fresh = (data ?? []) as Row[];
  if (!fresh.length) {
    console.log("непоказанных кандидатов нет - партию не из чего собрать");
    return;
  }
  const pool = [...fresh].sort((a, b) => rank(b) - rank(a));
  for (let b = 0; b < batches && pool.length; b++) {
    const picked = pickBalanced(pool, new Map(), 2, cfg.balance.max_same_tag_per_week);
    if (!picked.length) break;
    console.log(
      `партия ${b + 1}: ` +
        picked
          .map((c) => `[${archiveKey(c.attribution) || "?"}] ${c.tags?.subject ?? "?"}`)
          .join("  |  "),
    );
    for (const c of picked) pool.splice(pool.indexOf(c), 1);
  }
}

/**
 * Сито отбора на живых данных: у каждого кандидата резерва берём оценку
 * и крючок и прогоняем через то же правило, что стоит в сборщике.
 * Gemini не зовём - теги уже проставлены при сборе.
 */
async function simulateGate(cfg: ReturnType<typeof loadConfig>) {
  console.log("\n═══ 4. СИТО: кто прошёл бы в резерв по новому правилу ═══\n");
  const limits = {
    minScore: cfg.collect.min_score ?? 45,
    hooklessMinScore: cfg.collect.hookless_min_score ?? 85,
  };
  console.log(`пороги: общий ${limits.minScore}, без крючка ${limits.hooklessMinScore}`);
  const db = getDb();
  const { data, error } = await db
    .from("candidates")
    .select("id, score, tags, caption_html")
    .in("status", ["new", "shown", "approved"]);
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as Array<{ id: number; score: number; tags: { hook?: string } | null; caption_html: string | null }>;
  if (!rows.length) {
    console.log("резерв пуст - проверять нечего");
    return;
  }

  let passed = 0;
  const reasons = new Map<string, number>();
  const dropped: string[] = [];
  for (const r of rows) {
    const verdict = passesGate({ score: r.score, tags: r.tags ?? {} }, limits);
    if (verdict.pass) {
      passed++;
      continue;
    }
    reasons.set(verdict.reason, (reasons.get(verdict.reason) ?? 0) + 1);
    const head = (r.caption_html ?? "").replace(/<[^>]+>/g, "").split("\n")[0]?.slice(0, 52) ?? "";
    dropped.push(`  #${r.id} score ${r.score} (${verdict.reason}) - ${head}`);
  }
  console.log(`прошло бы: ${passed} из ${rows.length}`);
  console.log("отсев:", [...reasons.entries()].map(([k, n]) => `${k}×${n}`).join(", ") || "нет");
  console.log("крючки резерва:", spread(rows.map((r) => r.tags?.hook ?? "(тега нет)")));
  if (dropped.length) {
    console.log("кого бы не пустили:");
    dropped.slice(0, 12).forEach((line) => console.log(line));
  }
  const untagged = rows.filter((r) => !r.tags?.hook).length;
  if (untagged) {
    console.log(
      `\nВНИМАНИЕ: у ${untagged} кандидатов тега крючка нет вовсе - они собраны ДО правила.` +
        " Новое сито к ним не применялось, оно работает со следующего сбора.",
    );
  }
}

async function main() {
  const cfg = loadConfig();
  if (!process.argv.includes("--no-fetch")) {
    try {
      await simulateCollect(cfg);
    } catch (err) {
      console.warn(`сбор пропущен: ${(err as Error).message}`);
    }
  }
  await simulateFeed(cfg);
  await simulateCards(cfg);
  await simulateGate(cfg);
  console.log("\nсимуляция завершена: ничего не опубликовано, Gemini не вызывался");
}

main().catch((err) => {
  console.error("симуляция упала:", err);
  process.exit(1);
});
