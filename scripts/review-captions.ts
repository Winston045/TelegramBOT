/**
 * Проверка подписей глазами: последние кандидаты — исходные метаданные
 * и сгенерированная подпись рядом, чтобы сверить год, топонимы и цитату.
 *
 * npm run review-captions            — последние 5
 * npm run review-captions -- 10      — последние 10
 */
import { getDb } from "../src/db.js";

const limit = Number(process.argv[2]) || 5;

async function main() {
  const { data, error } = await getDb()
    .from("candidates")
    .select(
      "id, source, source_url, raw_title, raw_desc, raw_lang, year, place, score, quote_kind, status, caption_html, tags",
    )
    .order("id", { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  if (!data.length) {
    console.log("кандидатов в базе нет — сначала npm run collect");
    return;
  }

  for (const c of data.reverse()) {
    console.log("═".repeat(70));
    const why = (c.tags as { why?: string } | null)?.why;
    console.log(
      `#${c.id} [${c.source}] status=${c.status} score=${c.score}${why ? ` (${why})` : ""} quote=${c.quote_kind}`,
    );
    console.log(`${c.source_url}`);
    console.log("─ исходные метаданные ".padEnd(70, "─"));
    console.log(`  title (${c.raw_lang}): ${c.raw_title ?? "(нет)"}`);
    console.log(`  desc: ${(c.raw_desc ?? "(нет)").slice(0, 300)}`);
    console.log(`  year: ${c.year ?? "(нет)"}   place: ${c.place ?? "(нет)"}`);
    console.log("─ подпись ".padEnd(70, "─"));
    console.log(c.caption_html ?? "(подписи нет — брак или ещё не сгенерирована)");
    console.log();
  }

  console.log(
    "Сверь глазами: год совпадает с метаданными; топоним в варианте на дату " +
      "снимка; цитата не выдумана (observation — видно на фото, context — из описания).",
  );
}

main().catch((err) => {
  console.error("review-captions упал:", err);
  process.exit(1);
});
