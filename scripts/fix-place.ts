/**
 * Одноразовый лекарь партии 08.08: у коротких постов место и дата уехали
 * в блок цитаты (модель клала их в quote_place, а сборка рендерила его
 * как blockquote). Признак поломки: в подписи есть одиночный
 * <blockquote> БЕЗ expandable - у изюминок цитата всегда expandable.
 *
 * Чинит и резерв (new/shown), и уже вышедшие посты канала
 * (по channel_msg_id, редактированием подписи).
 */
import { getDb } from "../src/db.js";
import { getTelegram } from "../src/telegram.js";
import { env } from "../src/env.js";

/** Переносит содержимое одиночного не-expandable blockquote в тело. */
export function unquotePlace(captionHtml: string): string | null {
  if (/<blockquote expandable>/.test(captionHtml)) return null; // изюминка - не трогаем
  const m = captionHtml.match(/\n?<blockquote>([\s\S]*?)<\/blockquote>/);
  if (!m || m[1] === undefined) return null;
  return captionHtml.replace(m[0], `\n${m[1].trim()}`);
}

async function main() {
  const db = getDb();
  const { data, error } = await db
    .from("candidates")
    .select("id, status, caption_html, channel_msg_id")
    .in("status", ["new", "shown", "approved", "published"])
    .like("caption_html", "%<blockquote>%");
  if (error) throw new Error(error.message);

  let fixedReserve = 0;
  let fixedChannel = 0;
  for (const c of data ?? []) {
    const fixed = unquotePlace(c.caption_html ?? "");
    if (!fixed) continue;

    const { error: updErr } = await db
      .from("candidates")
      .update({ caption_html: fixed })
      .eq("id", c.id);
    if (updErr) throw new Error(`#${c.id}: ${updErr.message}`);

    if (c.status === "published" && c.channel_msg_id) {
      try {
        await getTelegram().editMessageCaption(env.channelId, c.channel_msg_id, {
          caption: fixed,
          parse_mode: "HTML",
        });
        fixedChannel++;
        console.log(`  пост в канале поправлен: #${c.id} (msg ${c.channel_msg_id})`);
      } catch (err) {
        console.warn(`  канал #${c.id} не поправился: ${(err as Error).message}`);
      }
    } else {
      fixedReserve++;
      console.log(`  резерв поправлен: #${c.id}`);
    }
    await new Promise((r) => setTimeout(r, 1200));
  }
  console.log(`итого: резерв ${fixedReserve}, посты канала ${fixedChannel}`);
}

main().catch((err) => {
  console.error("fix-place упал:", err);
  process.exit(1);
});
