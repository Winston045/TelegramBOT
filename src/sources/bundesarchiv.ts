/**
 * Бундесархив — через Wikimedia Commons API: снимки Федерального архива Германии
 * выложены на Commons под CC-BY-SA 3.0 de (категория
 * "Images from the German Federal Archive").
 *
 * Ищем внутри категории по строке из config (обычно год), метаданные берём
 * из extmetadata: описание, дата, лицензия, автор.
 */
import type { SourceConfig } from "../config.js";
import type { RawItem, SourceAdapter } from "./types.js";
import { parseYear } from "./loc.js";

const API = "https://commons.wikimedia.org/w/api.php";
const CATEGORY = "Images from the German Federal Archive";

type ExtValue = { value: string } | undefined;

type CommonsPage = {
  pageid: number;
  title: string;             // "File:Bundesarchiv Bild 101I-..., Ort, Sujet.jpg"
  imageinfo?: Array<{
    url: string;
    descriptionurl: string;
    width: number;
    height: number;
    extmetadata?: {
      ImageDescription?: ExtValue;
      DateTimeOriginal?: ExtValue;
      LicenseShortName?: ExtValue;
      Artist?: ExtValue;
      Credit?: ExtValue;
    };
  }>;
};

export function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Названия файлов Бундесархива: "Bundesarchiv Bild 183-..., <место>, <сюжет>.jpg".
 * Второй элемент через запятую — чаще всего место съёмки. Для файлов без
 * стандартного заголовка Бундесархива место не угадываем (живой прогон
 * показал: туда попадают годы и куски описаний) — такие записи отсеет
 * префильтр как no_place.
 */
export function placeFromTitle(title: string): string | undefined {
  const clean = title.replace(/^File:/, "").replace(/\.\w+$/, "");
  if (!/^Bundesarchiv\b/.test(clean)) return undefined;
  const parts = clean.split(",").map((s) => s.trim());
  const place = parts.length >= 2 ? parts[1] : undefined;
  // числа и куски вроде "30.12.1939" местом не считаем
  if (!place || /^[\d.\s-]+$/.test(place)) return undefined;
  return place;
}

export function mapCommonsPage(page: CommonsPage): RawItem | undefined {
  const info = page.imageinfo?.[0];
  if (!info) return undefined;

  const meta = info.extmetadata ?? {};
  const description = meta.ImageDescription?.value
    ? stripHtml(meta.ImageDescription.value)
    : undefined;
  const artist = meta.Artist?.value ? stripHtml(meta.Artist.value) : undefined;
  const license = meta.LicenseShortName?.value ?? "CC BY-SA 3.0 de";

  return {
    sourceId: String(page.pageid),
    sourceUrl: info.descriptionurl,
    imageUrl: info.url,
    imageWidth: info.width,
    title: page.title.replace(/^File:/, "").replace(/\.\w+$/, ""),
    description,
    lang: "de",
    year:
      parseYear(meta.DateTimeOriginal?.value) ??
      parseYear(page.title) ??
      parseYear(description),
    place: placeFromTitle(page.title),
    license,
    attribution: `Bundesarchiv${artist ? `, ${artist}` : ""} / ${license}`,
  };
}

async function search(term: string, limit: number, offset: number): Promise<CommonsPage[]> {
  const url = new URL(API);
  url.searchParams.set("action", "query");
  url.searchParams.set("format", "json");
  url.searchParams.set("formatversion", "2");
  url.searchParams.set("generator", "search");
  url.searchParams.set("gsrsearch", `incategory:"${CATEGORY}" ${term}`);
  url.searchParams.set("gsrnamespace", "6"); // File:
  url.searchParams.set("gsrlimit", String(Math.min(limit, 50)));
  url.searchParams.set("gsroffset", String(offset)); // пагинация: смещение
  url.searchParams.set("prop", "imageinfo");
  url.searchParams.set("iiprop", "url|size|extmetadata");
  url.searchParams.set(
    "iiextmetadatafilter",
    "ImageDescription|DateTimeOriginal|LicenseShortName|Artist|Credit",
  );

  const res = await fetch(url, {
    headers: { "user-agent": "story-team-bot/0.1 (contentbot)" },
  });
  if (!res.ok) throw new Error(`bundesarchiv: ${url} → HTTP ${res.status}`);
  const body = (await res.json()) as { query?: { pages?: CommonsPage[] } };
  return body.query?.pages ?? [];
}

export const bundesarchiv: SourceAdapter = {
  name: "bundesarchiv",

  async fetch(limit, cfg, cursors): Promise<RawItem[]> {
    const terms = cfg.categories?.length ? cfg.categories : [""];
    const perTerm = Math.ceil(limit / terms.length);
    const items: RawItem[] = [];
    for (const term of terms) {
      const offset = await cursors.get("bundesarchiv", term);
      const pages = await search(term, perTerm, offset);
      for (const page of pages) {
        const item = mapCommonsPage(page);
        if (item) items.push(item);
      }
      // выдача кончилась — заворачиваем на начало
      await cursors.set(
        "bundesarchiv",
        term,
        pages.length < perTerm ? 0 : offset + pages.length,
      );
    }
    return items.slice(0, limit);
  },
};
