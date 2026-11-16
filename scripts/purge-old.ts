/**
 * Чистка старого резерва (редакция 16.11: «много старых постов, которые
 * не соответствуют новым требованиям - удалим, оставим сегодняшний запас»).
 * Всё неопубликованное (new, shown, approved), собранное раньше границы,
 * уходит в rejected с пометкой gate=old_reserve. Статус меняется, строки
 * не удаляются: при ошибке их можно вернуть. Без --apply - только список.
 *
 *   npx tsx scripts/purge-old.ts --before 2026-11-15T21:00:00Z [--apply]
 */
import { getDb, selectAll } from "../src/db.js";

const LIVE = ["new", "shown", "approved"];

async function main() {
  const apply = process.argv.includes("--apply");
  const i = process.argv.indexOf("--before");
  const before = i !== -1 ? process.argv[i + 1] : undefined;
  if (!before || Number.isNaN(Date.parse(before))) throw new Error("нужна граница: --before <ISO-время>");
  const db = getDb();
  type Row = { id: number; status: string; created_at: string; caption_html: string | null; tags: Record<string, unknown> | null };
  const rows = await selectAll<Row>((from, to) =>
    db
      .from("candidates")
      .select("id, status, created_at, caption_html, tags")
      .in("status", LIVE)
      .order("created_at")
      .range(from, to),
  );
  const drop = rows.filter((r) => r.created_at < new Date(before).toISOString());
  const keep = rows.filter((r) => !drop.includes(r));
  const byDay = (list: Row[]) => {
    const m = new Map<string, number>();
    for (const r of list) m.set(r.created_at.slice(0, 10), (m.get(r.created_at.slice(0, 10)) ?? 0) + 1);
    return [...m].map(([d, n]) => `${d}: ${n}`).join(", ");
  };
  const line = (r: Row) =>
    `  #${r.id} [${r.status}] ${r.created_at.slice(0, 16)} ${(r.caption_html ?? "").replace(/<[^>]+>/g, "").split("\n")[0]?.slice(0, 90)}`;
  console.log(`граница: ${before}`);
  console.log(`в резерве: ${rows.length}; снимается ${drop.length}, остаётся ${keep.length}`);
  console.log(`снимается по дням: ${byDay(drop) || "-"}`);
  console.log(`остаётся по дням: ${byDay(keep) || "-"}\n`);
  console.log("ОСТАЁТСЯ:");
  keep.forEach((r) => console.log(line(r)));
  console.log("\nСНИМАЕТСЯ:");
  drop.forEach((r) => console.log(line(r)));
  if (!apply) {
    console.log("\nпробный прогон: база не тронута (добавьте apply в маркер)");
    return;
  }
  for (const r of drop) {
    const { error } = await db
      .from("candidates")
      .update({ status: "rejected", tags: { ...(r.tags ?? {}), gate: "old_reserve" } })
      .eq("id", r.id)
      .in("status", LIVE);
    if (error) throw new Error(`#${r.id}: ${error.message}`);
  }
  console.log(`\nснято из резерва: ${drop.length}`);
}

main().catch((err) => {
  console.error("чистка упала:", err);
  process.exit(1);
});
