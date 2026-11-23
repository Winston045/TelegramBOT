/**
 * Будапешт-1956 из резерва (вкус редакции 22.11: удаляла шесть раз; запрос
 * Europeana «1956 revolution» снят, Fortepan режет его на сборе).
 */
import { getDb } from "../src/db.js";
import { headline } from "../src/plan.js";

async function main() {
  const db = getDb();
  const { data } = await db.from("candidates").select("id, caption_html, tags").in("status", ["new", "shown", "approved"]);
  const drop = (data ?? []).filter((r) => /Будапешт[^<]{0,80}1956|1956[^<]{0,40}Будапешт|венгерск\S* (?:событи|восстани|революци)/i.test(r.caption_html ?? ""));
  for (const r of drop) {
    console.log(`  снимается #${r.id} ${headline(r.caption_html, 90)}`);
    await db.from("candidates").update({ status: "rejected", tags: { ...(r.tags ?? {}), gate: "taste" } }).eq("id", r.id);
  }
  console.log(`снято: ${drop.length}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
