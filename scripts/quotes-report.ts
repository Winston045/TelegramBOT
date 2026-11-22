/**
 * Цитаты под постами: вышедшие и резерв - текстом, чтобы видеть, о чём
 * изюминки на деле (редакция 22.11: «очевидные факты - скучно»).
 *   npx tsx scripts/quotes-report.ts [сколько вышедших, по умолчанию 40]
 */
import { getDb } from "../src/db.js";
import { banalIn } from "../src/factcheck.js";

const quotesOf = (html: string | null) =>
  [...(html ?? "").matchAll(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/g)].map((m) => (m[1] ?? "").replace(/<[^>]+>/g, "").trim());

async function main() {
  const n = Number(process.argv[2]) || 40;
  const db = getDb();
  for (const [title, q] of [
    ["ВЫШЕДШИЕ", db.from("candidates").select("id, caption_html, channel_msg_id").eq("status", "published").order("published_at", { ascending: false }).limit(n)],
    ["РЕЗЕРВ", db.from("candidates").select("id, caption_html, channel_msg_id").in("status", ["new", "shown", "approved"]).not("caption_html", "is", null).order("id", { ascending: false }).limit(200)],
  ] as const) {
    const { data } = await q;
    console.log(`\n${title}: ${data?.length ?? 0}`);
    let banal = 0;
    for (const r of data ?? []) {
      const qs = quotesOf(r.caption_html).filter((x) => x.length > 60);
      if (!qs.length) continue;
      const hit = qs.map((x) => banalIn(x)).find(Boolean);
      if (hit) banal++;
      console.log(`#${r.id}${r.channel_msg_id ? ` msg ${r.channel_msg_id}` : ""}${hit ? ` [ОБЩЕИЗВЕСТНОЕ: ${hit}]` : ""}\n  » ${qs.join("\n  » ")}`);
    }
    console.log(`с общеизвестным по правилу: ${banal}`);
  }
}

main().catch((err) => {
  console.error("отчёт упал:", err);
  process.exit(1);
});
