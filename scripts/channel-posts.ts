/**
 * Выгрузка текстов последних постов канала с t.me/s - чтобы вшить
 * настоящие посты в промпт как образцы стиля (few-shot).
 *
 * npx tsx scripts/channel-posts.ts 30   - последние ~30 постов с текстом
 */
import { loadConfig } from "../src/config.js";
import { channelSlug } from "../src/tme.js";

const WANT = Number(process.argv[2]) || 20;

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/** HTML текста поста -> читаемый плейнтекст, цитаты помечаем >>. */
function textFromHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<blockquote[^>]*>/gi, "\n>> ")
    .replace(/<\/blockquote>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const MESSAGE_SPLIT = /data-post="[^"/]+\/(\d+)"/g;
const TEXT_BLOCK =
  /tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/;

async function fetchPage(slug: string, before?: number): Promise<string> {
  const url = `https://t.me/s/${slug}${before ? `?before=${before}` : ""}`;
  const res = await fetch(url, {
    headers: { "user-agent": "Mozilla/5.0 (story-team-bot style)" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.text();
}

async function main() {
  const slug = channelSlug(loadConfig().channel.id);
  const found: Array<{ id: number; text: string }> = [];
  let before: number | undefined;

  for (let page = 0; page < 15 && found.length < WANT; page++) {
    const html = await fetchPage(slug, before);
    const markers = [...html.matchAll(MESSAGE_SPLIT)].map((m) => ({
      id: Number(m[1]),
      start: m.index,
    }));
    if (!markers.length) break;

    for (let i = 0; i < markers.length; i++) {
      const end = i + 1 < markers.length ? markers[i + 1]!.start : html.length;
      const chunk = html.slice(markers[i]!.start, end);
      const m = chunk.match(TEXT_BLOCK);
      if (!m) continue;
      const text = textFromHtml(m[1]!);
      if (text.length > 60) found.push({ id: markers[i]!.id, text });
    }

    before = Math.min(...markers.map((m) => m.id));
    if (before <= 1) break;
    await sleep(700);
  }

  // от свежих к старым, без дублей
  const seen = new Set<number>();
  const unique = found.filter((p) => !seen.has(p.id) && seen.add(p.id));
  unique.sort((a, b) => b.id - a.id);

  for (const p of unique.slice(0, WANT)) {
    console.log(`\n══════════ пост #${p.id} ══════════`);
    console.log(p.text);
  }
  console.log(`\nвсего с текстом: ${unique.length}`);
}

main().catch((err) => {
  console.error("выгрузка упала:", err);
  process.exit(1);
});
