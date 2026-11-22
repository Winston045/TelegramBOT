/**
 * Чистка резерва по вкусу редакции (22.11): эстрада, плакаты, социальная
 * история и любой мирный сюжет - то, что редакция удаляла чаще всего, -
 * снимаются из резерва с пометкой gate=taste. Без --apply - только список.
 */
import { getDb, selectAll } from "../src/db.js";
import { headline } from "../src/plan.js";

const DROP_RUBRICS = new Set(["culture", "poster", "social", "ussr_daily"]);

async function main() {
  const apply = process.argv.includes("--apply");
  const db = getDb();
  type Row = { id: number; status: string; caption_html: string | null; tags: Record<string, unknown> | null };
  const rows = await selectAll<Row>((from, to) =>
    db.from("candidates").select("id, status, caption_html, tags").in("status", ["new", "shown", "approved"]).order("id").range(from, to),
  );
  const drop = rows.filter(
    (r) => DROP_RUBRICS.has(String(r.tags?.rubric ?? "")) || r.tags?.military === false || r.tags?.subject === "culture",
  );
  console.log(`в резерве ${rows.length}, снимается ${drop.length}`);
  for (const r of drop) console.log(`  #${r.id} [${r.status}] ${String(r.tags?.rubric ?? "-")} ${headline(r.caption_html, 90)}`);
  if (!apply) return void console.log("пробный прогон: база не тронута (добавьте apply в маркер)");
  for (const r of drop) {
    const { error } = await db
      .from("candidates")
      .update({ status: "rejected", tags: { ...(r.tags ?? {}), gate: "taste" } })
      .eq("id", r.id)
      .in("status", ["new", "shown", "approved"]);
    if (error) throw new Error(`#${r.id}: ${error.message}`);
  }
  console.log(`снято: ${drop.length}`);
}

main().catch((err) => {
  console.error("чистка упала:", err);
  process.exit(1);
});
