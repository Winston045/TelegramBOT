/**
 * Аудит отсева: не теряем ли годное из-за модели, а не из-за порога.
 *
 * Берёт кадры, отсеянные на анализе (status rejected, tags.gate), и
 * заново прогоняет их через ПОЛНОЦЕННУЮ модель Gemini. Печатает старую и
 * новую оценку с крючком и итог: сколько прошло бы порог. В базу не
 * пишет - решение о пороге или «втором мнении» принимается по цифрам.
 *
 * Запуск: npx tsx scripts/gate-audit.ts [сколько] [с какой даты YYYY-MM-DD]
 */
import { loadConfig } from "../src/config.js";
import { getDb } from "../src/db.js";
import { ADAPTERS } from "../src/sources/index.js";
import { analyzeImage } from "../src/analyze.js";
import { passesGate } from "../src/scoring.js";
import { rubricOf } from "../src/rubrics.js";
import { lastUsedModel } from "../src/gemini.js";
import type { RawItem } from "../src/sources/types.js";

type Row = {
  id: number;
  source: string;
  source_id: string;
  source_url: string;
  image_url: string;
  raw_title: string | null;
  raw_desc: string | null;
  raw_lang: string | null;
  year: number | null;
  place: string | null;
  license: string | null;
  attribution: string | null;
  score: number | null;
  created_at: string;
  tags: { gate?: string; hook?: string; why?: string; model?: string; rubric?: string } | null;
};

async function main() {
  const cfg = loadConfig();
  const limit = Number(process.argv[2]) || 14;
  const since = process.argv[3] || new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const { data, error } = await getDb()
    .from("candidates")
    .select(
      "id, source, source_id, source_url, image_url, raw_title, raw_desc, raw_lang, year, place, license, attribution, score, created_at, tags",
    )
    .eq("status", "rejected")
    .gte("created_at", since)
    .not("tags->>gate", "is", null)
    .order("score", { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as Row[];
  console.log(`отсеянных на анализе с ${since}: беру ${rows.length} с самой высокой оценкой\n`);

  const minScore = cfg.collect.min_score ?? 45;
  const hookless = cfg.collect.hookless_min_score ?? 85;
  let passed = 0;
  let judged = 0;
  for (const r of rows) {
    const item: RawItem = {
      sourceId: r.source_id,
      sourceUrl: r.source_url,
      imageUrl: r.image_url,
      title: r.raw_title ?? undefined,
      description: r.raw_desc ?? undefined,
      lang: r.raw_lang ?? "en",
      year: r.year ?? undefined,
      place: r.place ?? undefined,
      license: r.license ?? "PD",
      attribution: r.attribution ?? undefined,
      rubric: r.tags?.rubric,
    };
    const was = `было: ${r.score} [${r.tags?.hook ?? "-"}] ${r.tags?.gate}${r.tags?.model ? ` (${r.tags.model})` : ""}`;
    console.log(`#${r.id} [${r.source}] ${(r.raw_title ?? "").slice(0, 80)}`);
    console.log(`  ${was} - ${r.tags?.why ?? ""}`);
    try {
      const res = await fetch(r.image_url, {
        headers: { "user-agent": "story-team-bot/0.1 (Telegram history channel; contact via t.me/Story_Teams)" },
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) throw new Error(`картинка: HTTP ${res.status}`);
      const image = Buffer.from(await res.arrayBuffer());
      const extra = await ADAPTERS[r.source]?.details?.(item).catch(() => undefined);
      const a = await analyzeImage(item, cfg, image, extra, { fullOnly: true });
      const rubric = rubricOf(item.rubric);
      const verdict = passesGate(a, {
        minScore: rubric?.minScore ?? minScore,
        hooklessMinScore: rubric?.hooklessMinScore ?? hookless,
      });
      judged++;
      if (verdict.pass) passed++;
      console.log(
        `  стало: ${a.score} [${a.tags.hook ?? "-"}] (${lastUsedModel() ?? "?"}) ${verdict.pass ? "ПРОШЁЛ БЫ" : `снова мимо (${verdict.reason})`} - ${a.score_why ?? ""}`,
      );
      if (verdict.pass) console.log(`  подпись: ${a.caption}`);
      console.log(`  ${r.source_url}`);
    } catch (err) {
      console.log(`  сбой: ${(err as Error).message}`);
    }
  }
  console.log(`\nитог: полноценная модель пропустила бы ${passed} из ${judged} отсеянных`);
  console.log("аудит завершён: база не тронута");
}

main().catch((err) => {
  console.error("аудит упал:", err);
  process.exit(1);
});
