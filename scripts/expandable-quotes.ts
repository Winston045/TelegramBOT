/**
 * Одноразовое обновление готовых карточек: обычные цитаты становятся
 * свёрнутыми (blockquote expandable) - как в новых подписях с 30.07.2026.
 * Опубликованные посты не трогаем, только то, что ещё выйдет.
 */
import { getDb } from "../src/db.js";

async function main() {
  const db = getDb();
  const { data, error } = await db
    .from("candidates")
    .select("id, caption_html")
    .in("status", ["new", "shown", "approved"])
    .like("caption_html", "%<blockquote>%");
  if (error) throw new Error(error.message);

  let updated = 0;
  for (const c of data ?? []) {
    const next = (c.caption_html as string).replaceAll(
      "<blockquote>",
      "<blockquote expandable>",
    );
    const { error: updErr } = await db
      .from("candidates")
      .update({ caption_html: next })
      .eq("id", c.id);
    if (updErr) throw new Error(`#${c.id}: ${updErr.message}`);
    updated++;
  }
  console.log(`цитаты свёрнуты у ${updated} карточек`);
}

main().catch((err) => {
  console.error("expandable-quotes упал:", err);
  process.exit(1);
});
