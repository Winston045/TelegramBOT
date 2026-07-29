/**
 * Разовая чистка: длинные тире в подписях неопубликованных кандидатов
 * заменяются на обычный дефис - как пишут люди, а не нейросети.
 */
import { getDb } from "../src/db.js";

async function main() {
  const db = getDb();
  const { data, error } = await db
    .from("candidates")
    .select("id, caption_html")
    .in("status", ["new", "shown", "approved"])
    .not("caption_html", "is", null);
  if (error) throw new Error(error.message);

  let cleaned = 0;
  for (const row of data) {
    const html = row.caption_html as string;
    if (!/[—–]/.test(html)) continue;
    const { error: updErr } = await db
      .from("candidates")
      .update({ caption_html: html.replace(/[—–]/g, "-") })
      .eq("id", row.id);
    if (updErr) throw new Error(`#${row.id}: ${updErr.message}`);
    cleaned++;
    console.log(`очищен #${row.id}`);
  }
  console.log(`готово: очищено ${cleaned} из ${data.length}`);
}

main().catch((err) => {
  console.error("чистка упала:", err);
  process.exit(1);
});
