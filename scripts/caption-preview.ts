/**
 * Предпросмотр подписей на новых промптах - «было → стало» по готовым
 * кадрам из базы, без записи в базу и без публикации.
 *
 * Правка промптов меняет то, что уйдёт в канал, поэтому сначала её видно
 * на живых кадрах: картинка заново скачивается, проходит анализ, справку
 * о предмете в кадре и редактора цитаты - ровно как в сборе.
 *
 * Запуск: npx tsx scripts/caption-preview.ts 445,419,446
 * (без номеров - шесть свежих кадров резерва с подписью).
 */
import { loadConfig } from "../src/config.js";
import { getDb } from "../src/db.js";
import { ADAPTERS } from "../src/sources/index.js";
import { analyzeImage } from "../src/analyze.js";
import { reviewQuote } from "../src/critic.js";
import { assembleCaptionHtml } from "../src/caption.js";
import { validateCaption } from "../src/validate.js";
import { subjectReference } from "../src/wiki.js";
import type { RawItem } from "../src/sources/types.js";

type Row = {
  id: number;
  source: string;
  source_id: string;
  source_url: string;
  image_url: string;
  raw_title: string | null;
  raw_desc: string | null;
  raw_lang: string | null;
  year: number | null;
  place: string | null;
  license: string | null;
  attribution: string | null;
  caption_html: string | null;
  tags: { rubric?: string } | null;
};

/** Подпись без футера канала, цитаты - строками «» с отступом. */
const plain = (html: string | null) => {
  const raw = html ?? "";
  // футер - последний блок после пустой строки со ссылкой канала; режем
  // его ДО разметки цитат, иначе перенос перед цитатой съедал и их
  const cut = raw.lastIndexOf("\n\n");
  const body = cut !== -1 && raw.slice(cut).includes("<a href=") ? raw.slice(0, cut) : raw;
  return body
    .replace(/\n?<blockquote[^>]*>/g, "\n  » ")
    .replace(/<[^>]+>/g, "")
    .trim();
};

async function main() {
  const cfg = loadConfig();
  const db = getDb();
  const ids = (process.argv[2] ?? "")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
  const query = db
    .from("candidates")
    .select(
      "id, source, source_id, source_url, image_url, raw_title, raw_desc, raw_lang, year, place, license, attribution, caption_html, tags",
    )
    .not("caption_html", "is", null);
  const { data, error } = ids.length
    ? await query.in("id", ids)
    : await query.in("status", ["new", "shown", "approved"]).order("id", { ascending: false }).limit(6);
  if (error) throw new Error(error.message);

  for (const r of (data ?? []) as Row[]) {
    const item: RawItem = {
      sourceId: r.source_id,
      sourceUrl: r.source_url,
      imageUrl: r.image_url,
      title: r.raw_title ?? undefined,
      description: r.raw_desc ?? undefined,
      lang: r.raw_lang ?? "en",
      year: r.year ?? undefined,
      place: r.place ?? undefined,
      license: r.license ?? "PD",
      attribution: r.attribution ?? undefined,
      rubric: r.tags?.rubric,
    };
    console.log("═".repeat(72));
    console.log(`#${r.id} [${r.source}] ${(r.raw_title ?? "").slice(0, 80)}`);
    console.log(`БЫЛО:\n  ${plain(r.caption_html)}`);
    try {
      const res = await fetch(r.image_url, {
        headers: { "user-agent": "story-team-bot/0.1 (Telegram history channel; contact via t.me/Story_Teams)" },
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) throw new Error(`картинка: HTTP ${res.status}`);
      const image = Buffer.from(await res.arrayBuffer());
      const extra = await ADAPTERS[r.source]?.details?.(item).catch(() => undefined);
      const a = await analyzeImage(item, cfg, image, extra);
      const subject = a.subject_wiki ? await subjectReference(a.subject_wiki) : undefined;
      console.log(`предмет: ${a.subject_wiki ?? "-"}${subject ? " (справка найдена)" : a.subject_wiki ? " (справки нет)" : ""}`);
      const reviewed = await reviewQuote(item, cfg, a, extra, subject);
      const html = assembleCaptionHtml(reviewed.caption, item, cfg.channel);
      const context = [extra, subject].filter(Boolean).join("\n");
      const check = validateCaption(html, { ...item, context: context || undefined });
      console.log(`СТАЛО${reviewed.rewritten ? " (редактор переписал)" : ""}:\n  ${plain(html)}`);
      if (!check.ok) console.log(`  ! валидатор не пропустил бы: ${check.reason}`);
    } catch (err) {
      console.log(`  сбой: ${(err as Error).message}`);
    }
  }
  console.log("\nпредпросмотр завершён: база не тронута, в канал ничего не ушло");
}

main().catch((err) => {
  console.error("предпросмотр упал:", err);
  process.exit(1);
});
