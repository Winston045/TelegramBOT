/**
 * Выгрузка текстов последних постов канала с t.me/s - чтобы вшить
 * настоящие посты в промпт как образцы стиля (few-shot).
 *
 * npx tsx scripts/channel-posts.ts 30   - последние ~30 постов с текстом
 */
import { loadConfig } from "../src/config.js";
import { channelSlug } from "../src/tme.js";

const WANT = Number(process.argv[2]) || 20;

/** --before 5000 - начать с постов старше этого id (нырнуть в архив). */
function beforeArg(): number | undefined {
  const i = process.argv.indexOf("--before");
  const n = Number(process.argv[i + 1]);
  return i !== -1 && Number.isFinite(n) && n > 1 ? n : undefined;
}

/** --month 2024-12 - выгрузить ВСЕ посты конкретного месяца (листает сам). */
function monthArg(): string | undefined {
  const i = process.argv.indexOf("--month");
  const v = process.argv[i + 1];
  return i !== -1 && v && /^\d{4}-\d{2}$/.test(v) ? v : undefined;
}

/**
 * --from 2024-11 --to 2025-03 - выгрузить целый отрезок архива, а не один
 * месяц. Нужен, чтобы разобрать РУЧНУЮ редактуру канала: что живые люди
 * считали интересным, прежде чем отбор доверили боту.
 */
function rangeArgs(): { from: string; to: string } | undefined {
  const gi = process.argv.indexOf("--from");
  const li = process.argv.indexOf("--to");
  const from = process.argv[gi + 1];
  const to = process.argv[li + 1];
  if (gi === -1 || li === -1 || !from || !to) return undefined;
  if (!/^\d{4}-\d{2}$/.test(from) || !/^\d{4}-\d{2}$/.test(to)) return undefined;
  return { from, to };
}

/** --brief - одна строка на пост: на большом отрезке иначе не прочитать. */
const brief = process.argv.includes("--brief");

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
  const month = monthArg();
  const range = rangeArgs();
  const found: Array<{ id: number; date: string; text: string }> = [];
  let before = beforeArg();

  // в месячном режиме листаем, пока не пройдём месяц насквозь: страниц
  // может быть много (архив в тысячи постов), потолок - защита от зацикла
  const maxPages = month || range ? 400 : 15;
  for (let page = 0; page < maxPages; page++) {
    if (!month && !range && found.length >= WANT) break;
    const html = await fetchPage(slug, before);
    const markers = [...html.matchAll(MESSAGE_SPLIT)].map((m) => ({
      id: Number(m[1]),
      start: m.index,
    }));
    if (!markers.length) break;

    let oldestDate = "9999-99";
    for (let i = 0; i < markers.length; i++) {
      const end = i + 1 < markers.length ? markers[i + 1]!.start : html.length;
      const chunk = html.slice(markers[i]!.start, end);
      const date = chunk.match(/datetime="(\d{4}-\d{2}-\d{2})/)?.[1] ?? "?";
      if (date !== "?" && date.slice(0, 7) < oldestDate) oldestDate = date.slice(0, 7);
      const m = chunk.match(TEXT_BLOCK);
      if (!m) continue;
      const text = textFromHtml(m[1]!);
      if (text.length <= 60) continue;
      if (month && date.slice(0, 7) !== month) continue;
      if (range && (date.slice(0, 7) < range.from || date.slice(0, 7) > range.to)) continue;
      found.push({ id: markers[i]!.id, date, text });
    }

    // страница целиком старше искомого месяца - дальше листать незачем
    if (month && oldestDate !== "9999-99" && oldestDate < month) break;
    if (range && oldestDate !== "9999-99" && oldestDate < range.from) break;

    before = Math.min(...markers.map((m) => m.id));
    if (before <= 1) break;
    await sleep(700);
  }

  // от свежих к старым, без дублей
  const seen = new Set<number>();
  const unique = found.filter((p) => !seen.has(p.id) && seen.add(p.id));
  unique.sort((a, b) => b.id - a.id);

  const show = month || range ? unique : unique.slice(0, WANT);
  for (const p of show) {
    if (brief) {
      // одна строка на пост: сюжет виден по первой фразе, а отрезок в
      // сотни постов иначе не прочитать целиком
      const first = p.text.split("\n")[0]?.replace(/\s+/g, " ").slice(0, 110) ?? "";
      console.log(`${p.date} #${p.id}  ${first}`);
      continue;
    }
    console.log(`\n══════════ пост #${p.id} (${p.date}) ══════════`);
    console.log(p.text);
  }
  const scope = month ? ` за ${month}` : range ? ` за ${range.from}..${range.to}` : "";
  console.log(`\nвсего с текстом: ${unique.length}${scope}`);
}

main().catch((err) => {
  console.error("выгрузка упала:", err);
  process.exit(1);
});
