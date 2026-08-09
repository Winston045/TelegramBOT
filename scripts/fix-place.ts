/**
 * Лекарь оформления: канонический вид обычного поста - описание,
 * а место и год КОРОТКОЙ ЦИТАТОЙ («Австрия, 1946 год»).
 *
 * Чинит посты, где дата оказалась в теле (последняя строка описания -
 * голые место и год, а цитаты нет): строка переезжает в blockquote.
 * Изюминки (пост с настоящей цитатой-справкой) не трогаются - у них
 * дата в теле и есть, это их формат. Обрабатывает резерв и посты
 * канала с 01.08; канал правится через editMessageCaption,
 * «message is not modified» - штатный ответ здорового поста.
 */
import { getDb } from "../src/db.js";
import { getTelegram } from "../src/telegram.js";
import { env } from "../src/env.js";

/** Похоже ли содержимое на голые место и дату («Италия, 1943 год.»). */
export function isBarePlaceDate(text: string): boolean {
  const t = text.trim();
  if (t.length === 0 || t.length > 60) return false;
  if (!/(18|19|20)\d{2}/.test(t)) return false;
  const sentences = t.split(/\.\s+/).filter(Boolean);
  return sentences.length <= 2;
}

/**
 * Переносит голые место и дату из последней строки тела в цитату.
 * null - чинить нечего (есть цитата или дата не в теле).
 */
export function placeToQuote(captionHtml: string): string | null {
  if (/<blockquote/.test(captionHtml)) return null; // цитата уже есть
  const m = captionHtml.match(/^([\s\S]*?)\n([^\n<>]+)\n\n(<a href[\s\S]*)$/);
  if (!m || !m[1] || !m[2] || !m[3]) return null;
  const line = m[2].trim();
  if (!isBarePlaceDate(line)) return null;
  return `${m[1]}\n<blockquote expandable>${line}</blockquote>\n\n${m[3]}`;
}

async function main() {
  const db = getDb();
  // два простых запроса надёжнее одного or-фильтра: комбинированный
  // синтаксис PostgREST однажды молча не вернул резерв
  const reserveRes = await db
    .from("candidates")
    .select("id, status, caption_html, channel_msg_id, published_at")
    .in("status", ["new", "shown", "approved"]);
  if (reserveRes.error) throw new Error(reserveRes.error.message);
  const publishedRes = await db
    .from("candidates")
    .select("id, status, caption_html, channel_msg_id, published_at")
    .eq("status", "published")
    .gte("published_at", "2026-08-01");
  if (publishedRes.error) throw new Error(publishedRes.error.message);
  const data = [...(reserveRes.data ?? []), ...(publishedRes.data ?? [])];

  let fixedReserve = 0;
  let fixedChannel = 0;
  for (const c of data ?? []) {
    const fixed = placeToQuote(c.caption_html ?? "");
    // свежий пост канала синхронизируем безусловно - подпись могла
    // разъехаться с базой
    const target = fixed ?? c.caption_html;
    if (!target) continue;

    if (c.status === "published" && c.channel_msg_id) {
      try {
        await getTelegram().editMessageCaption(env.channelId, c.channel_msg_id, {
          caption: target,
          parse_mode: "HTML",
        });
        fixedChannel++;
        console.log(`  пост в канале поправлен: #${c.id} (msg ${c.channel_msg_id})`);
      } catch (err) {
        const msg = (err as Error).message;
        if (/message is not modified/i.test(msg)) {
          if (fixed) console.log(`  #${c.id}: канал уже в порядке`);
        } else {
          console.warn(`  канал #${c.id} не поправился: ${msg}`);
          continue; // базу не трогаем, чтобы не разъехаться с каналом
        }
      }
      await new Promise((r) => setTimeout(r, 1200));
    } else if (fixed) {
      fixedReserve++;
      console.log(`  резерв поправлен: #${c.id}`);
    }

    if (fixed) {
      const { error: updErr } = await db
        .from("candidates")
        .update({ caption_html: fixed })
        .eq("id", c.id);
      if (updErr) throw new Error(`#${c.id}: ${updErr.message}`);
    }
  }
  console.log(`итого: резерв ${fixedReserve}, посты канала ${fixedChannel}`);
}

// main только при прямом запуске: тесты импортируют placeToQuote,
// и побочный запуск валил CI (нет секретов базы - process.exit(1))
import { pathToFileURL } from "node:url";
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error("fix-place упал:", err);
    process.exit(1);
  });
}
