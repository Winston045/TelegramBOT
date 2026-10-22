/**
 * Чистка резерва рубрики «культура» от местной эстрады (редакция 22.10:
 * «каких-то нн певиц и музыкантов»). Кадры рубрики, в метаданных которых
 * архив не назвал звезду мировой величины (CULTURE_STARS), снимаются из
 * резерва статусом rejected с пометкой gate=no_star. Опубликованное не
 * трогаем. Без слова apply в маркере - только список, база не меняется.
 */
import { getDb, selectAll } from "../src/db.js";
import { RUBRICS } from "../src/rubrics.js";

async function main() {
  const apply = process.argv.includes("--apply");
  const db = getDb();
  const must = RUBRICS.culture?.metaMust;
  if (!must) throw new Error("у рубрики culture нет списка звёзд");
  type Row = { id: number; status: string; raw_title: string | null; raw_desc: string | null; tags: Record<string, unknown> | null };
  const rows = await selectAll<Row>((from, to) =>
    db
      .from("candidates")
      .select("id, status, raw_title, raw_desc, tags")
      .in("status", ["new", "shown", "approved"])
      .eq("tags->>rubric", "culture")
      .order("id")
      .range(from, to),
  );
  const drop = rows.filter((r) => !must.test(`${r.raw_title ?? ""} ${r.raw_desc ?? ""}`));
  const keep = rows.filter((r) => !drop.includes(r));
  console.log(`культура в резерве: ${rows.length}; со звездой ${keep.length}, без звезды ${drop.length}\n`);
  for (const r of keep) console.log(`  остаётся #${r.id} [${r.status}] ${(r.raw_title ?? "").slice(0, 90)}`);
  for (const r of drop) console.log(`  снимается #${r.id} [${r.status}] ${(r.raw_title ?? "").slice(0, 90)}`);
  if (!apply) {
    console.log("\nпробный прогон: база не тронута (добавьте apply в маркер)");
    return;
  }
  for (const r of drop) {
    const { error } = await db
      .from("candidates")
      .update({ status: "rejected", tags: { ...(r.tags ?? {}), gate: "no_star" } })
      .eq("id", r.id)
      .in("status", ["new", "shown", "approved"]);
    if (error) throw new Error(`#${r.id}: ${error.message}`);
  }
  console.log(`\nснято из резерва: ${drop.length}`);
}

main().catch((err) => {
  console.error("чистка упала:", err);
  process.exit(1);
});
