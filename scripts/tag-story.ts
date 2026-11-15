/**
 * Дозаполнение типа сюжета (src/story.ts) у постов, разобранных до
 * разметки: вышедшие за последние недели и резерв. Модель читает текст
 * подписи (без картинки - сюжет поста в тексте) по десять постов за запрос.
 *
 * Запуск: npx tsx scripts/tag-story.ts [дней назад для вышедших, по умолчанию 21] [--dry]
 */
import { getDb } from "../src/db.js";
import { geminiJson } from "../src/gemini.js";
import { RESERVE_TTL_DAYS } from "../src/plan.js";
import { normalizeStory, storyGuide } from "../src/story.js";

const DAYS = Number(process.argv.find((a) => /^\d+$/.test(a))) || 21;
const DRY = process.argv.includes("--dry");
const BATCH = 10;

type Row = { id: number; caption_html: string | null; tags: Record<string, unknown> | null };

function plainText(html: string | null): string {
  return (html ?? "")
    .replace(/<a [^>]*>[\s\S]*?<\/a>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 700);
}

async function main() {
  const db = getDb();
  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();
  const fresh = new Date(Date.now() - RESERVE_TTL_DAYS * 86_400_000).toISOString();
  const [pub, res] = await Promise.all([
    db.from("candidates").select("id, caption_html, tags").eq("status", "published").gte("published_at", since),
    db
      .from("candidates")
      .select("id, caption_html, tags")
      .in("status", ["new", "shown", "approved"])
      .not("caption_html", "is", null)
      .gte("created_at", fresh),
  ]);
  if (pub.error) throw new Error(pub.error.message);
  if (res.error) throw new Error(res.error.message);
  const todo = ([...(pub.data ?? []), ...(res.data ?? [])] as Row[]).filter(
    (r) => r.caption_html && !normalizeStory(r.tags?.story),
  );
  console.log(`без типа сюжета: ${todo.length} (вышедшие за ${DAYS} дн. и резерв)`);

  let tagged = 0;
  for (let i = 0; i < todo.length; i += BATCH) {
    const batch = todo.slice(i, i + BATCH);
    const prompt = `Определи тип сюжета каждого поста исторического Telegram-канала - про что пост для читателя (подпись и изюминка вместе), а не что за техника в кадре. Ровно один тип:
${storyGuide()}
Обычные солдаты, техника и учения без отдельной истории - честно "service".

Посты:
${batch.map((r) => `#${r.id}: ${plainText(r.caption_html)}`).join("\n")}

Ответь JSON: {"items": [{"id": <номер>, "story": "<тип>"}]}`;
    let items: Array<{ id?: unknown; story?: unknown }> = [];
    try {
      const out = await geminiJson<{ items?: Array<{ id?: unknown; story?: unknown }> }>([{ text: prompt }], {
        temperature: 0,
      });
      items = Array.isArray(out.items) ? out.items : [];
    } catch (err) {
      console.warn(`  пачка ${i / BATCH + 1}: модель не ответила - ${(err as Error).message}`);
      continue;
    }
    for (const it of items) {
      const row = batch.find((r) => r.id === Number(it.id));
      const story = normalizeStory(it.story);
      if (!row || !story) continue;
      console.log(`  #${row.id} ${story}: ${plainText(row.caption_html).slice(0, 70)}`);
      tagged++;
      if (DRY) continue;
      const { error } = await db
        .from("candidates")
        .update({ tags: { ...(row.tags ?? {}), story, story_src: "text" } })
        .eq("id", row.id);
      if (error) console.warn(`  #${row.id}: не записал - ${error.message}`);
    }
  }
  console.log(`размечено: ${tagged} из ${todo.length}${DRY ? " (dry - база не тронута)" : ""}`);
}

main().catch((err) => {
  console.error("разметка упала:", err);
  process.exit(1);
});
