/**
 * Общеизвестное в цитатах уже существующих постов (редакция 22.11:
 * «исправь это и в существующих постах»). В каждой изюминке вырезаются
 * предложения из учебника (src/factcheck.ts: banalIn); живой остаток
 * остаётся, пустой - цитата убирается целиком, строка места и даты
 * остаётся. Резерв правится в базе, вышедшее - ещё и в канале
 * (editMessageCaption). Gemini не нужен.
 *
 *   npx tsx scripts/fix-banal.ts [--days 30] [--apply]
 */
import { getDb } from "../src/db.js";
import { env } from "../src/env.js";
import { getTelegram } from "../src/telegram.js";
import { banalIn, stripBanal } from "../src/factcheck.js";

export function fixCaption(html: string): string {
  return html.replace(/\n?(<blockquote[^>]*>)([\s\S]*?)(<\/blockquote>)/g, (whole, open: string, inner: string, close: string) => {
    if (inner.replace(/<[^>]+>/g, "").trim().length <= 60 || !banalIn(inner)) return whole;
    const rest = stripBanal(inner);
    const lead = whole.startsWith("\n") ? "\n" : "";
    return rest ? `${lead}${open}${rest}${close}` : "";
  });
}

async function main() {
  const apply = process.argv.includes("--apply");
  const di = process.argv.indexOf("--days");
  const days = di !== -1 ? Number(process.argv[di + 1]) || 30 : 30;
  const db = getDb();
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const [pub, res] = await Promise.all([
    db.from("candidates").select("id, caption_html, channel_msg_id, status").eq("status", "published").not("channel_msg_id", "is", null).gte("published_at", since),
    db.from("candidates").select("id, caption_html, channel_msg_id, status").in("status", ["new", "shown", "approved"]).not("caption_html", "is", null),
  ]);
  const rows = [...(pub.data ?? []), ...(res.data ?? [])];
  let changed = 0;
  let edited = 0;
  for (const r of rows) {
    const before = r.caption_html ?? "";
    const after = fixCaption(before);
    if (after === before) continue;
    changed++;
    const plain = (h: string) => h.replace(/<blockquote[^>]*>/g, "\n  » ").replace(/<[^>]+>/g, "").replace(/\n\n[^\n]*$/, "").trim();
    console.log(`#${r.id} [${r.status}${r.channel_msg_id ? `, пост ${r.channel_msg_id}` : ""}]\n БЫЛО:\n  ${plain(before)}\n СТАЛО:\n  ${plain(after)}\n`);
    if (!apply) continue;
    const { error } = await db.from("candidates").update({ caption_html: after }).eq("id", r.id);
    if (error) {
      console.log(`  ! база: ${error.message}`);
      continue;
    }
    if (r.status === "published" && r.channel_msg_id) {
      try {
        await getTelegram().editMessageCaption(env.channelId, r.channel_msg_id, { caption: after, parse_mode: "HTML" });
        edited++;
      } catch (err) {
        const m = (err as Error).message;
        if (!/not modified/i.test(m)) console.log(`  ! канал: ${m}`);
      }
      await new Promise((ok) => setTimeout(ok, 1500));
    }
  }
  console.log(`постов с общеизвестным: ${changed} из ${rows.length}` + (apply ? `; в канале исправлено: ${edited}` : "; пробный прогон: ничего не тронуто (добавьте apply)"));
}

if (process.argv[1]?.endsWith("fix-banal.ts")) {
  main().catch((err) => {
    console.error("правка упала:", err);
    process.exit(1);
  });
}
