/**
 * Лекарь оформления коротких постов (08.08): место и дата должны жить
 * в теле поста, а не в блоке цитаты.
 *
 * Чинит два вида поломки:
 *  - одиночный не-expandable blockquote (quote_place без цитаты);
 *  - одиночная expandable-цитата, целиком состоящая из места и даты
 *    (старый «вариант б» - теперь такие посты выходят короткими).
 * Обрабатывает резерв и свежие посты канала; канал синхронизируется
 * с базой через editMessageCaption, «message is not modified» - норма.
 */
import { getDb } from "../src/db.js";
import { getTelegram } from "../src/telegram.js";
import { env } from "../src/env.js";

/** Похоже ли содержимое цитаты на голые место и дату («Италия, 1943 год.»). */
export function isBarePlaceDate(text: string): boolean {
  const t = text.trim();
  if (t.length === 0 || t.length > 60) return false;
  if (!/(18|19|20)\d{2}/.test(t)) return false;
  // у справки есть глагол или длинное повествование; место-дата - обрывок
  // без точки в середине («Район Арраса, Франция. 19 июля 1918 года.» - ок)
  const sentences = t.split(/\.\s+/).filter(Boolean);
  return sentences.length <= 2;
}

/** Переносит одинокую цитату места и даты в тело. null - чинить нечего. */
export function unquotePlace(captionHtml: string): string | null {
  const blocks = [...captionHtml.matchAll(/<blockquote( expandable)?>([\s\S]*?)<\/blockquote>/g)];
  if (blocks.length !== 1) return null; // изюминка с quote_place или чистый пост
  const m = blocks[0];
  if (!m || m[2] === undefined) return null;
  const inner = m[2].trim();
  // не-expandable - это quote_place, переносим всегда;
  // expandable переносим только если это голые место и дата
  if (m[1] && !isBarePlaceDate(inner)) return null;
  // перенос строки перед блоком уже стоит в подписи - блок заменяем голым текстом
  return captionHtml.replace(m[0], inner);
}

async function main() {
  const db = getDb();
  const { data, error } = await db
    .from("candidates")
    .select("id, status, caption_html, channel_msg_id, published_at")
    .or(
      "status.in.(new,shown,approved),and(status.eq.published,published_at.gte.2026-08-05)",
    );
  if (error) throw new Error(error.message);

  let fixedReserve = 0;
  let fixedChannel = 0;
  for (const c of data ?? []) {
    const fixed = unquotePlace(c.caption_html ?? "");
    if (!fixed) continue;

    if (c.status === "published" && c.channel_msg_id) {
      try {
        await getTelegram().editMessageCaption(env.channelId, c.channel_msg_id, {
          caption: fixed,
          parse_mode: "HTML",
        });
        fixedChannel++;
        console.log(`  пост в канале поправлен: #${c.id} (msg ${c.channel_msg_id})`);
      } catch (err) {
        const msg = (err as Error).message;
        if (/message is not modified/i.test(msg)) {
          console.log(`  #${c.id}: канал уже в порядке`);
        } else {
          console.warn(`  канал #${c.id} не поправился: ${msg}`);
          continue; // базу не трогаем, чтобы не разъехаться с каналом
        }
      }
      await new Promise((r) => setTimeout(r, 1200));
    } else {
      fixedReserve++;
      console.log(`  резерв поправлен: #${c.id}`);
    }

    const { error: updErr } = await db
      .from("candidates")
      .update({ caption_html: fixed })
      .eq("id", c.id);
    if (updErr) throw new Error(`#${c.id}: ${updErr.message}`);
  }
  console.log(`итого: резерв ${fixedReserve}, посты канала ${fixedChannel}`);
}

main().catch((err) => {
  console.error("fix-place упал:", err);
  process.exit(1);
});
