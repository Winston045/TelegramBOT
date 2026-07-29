/**
 * Разовая чистка: убрать строку атрибуции из подписей кандидатов в базе
 * (резерв и очередь), чтобы она не всплыла при публикации старых карточек.
 * Опубликованные посты не трогаем.
 */
import { getDb } from "../src/db.js";

// строка вида "Bundesarchiv, Koch / CC BY-SA 3.0 de" (иногда в <i>),
// стоящая отдельной строкой прямо перед подписью канала
const ATTR_LINE = /(<i>)?[^<\n]*\/ CC[- ]BY[^<\n]*(<\/i>)?\n(?=<a href)/i;

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
    if (!ATTR_LINE.test(html)) continue;
    const { error: updErr } = await db
      .from("candidates")
      .update({ caption_html: html.replace(ATTR_LINE, "") })
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
