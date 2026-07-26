/**
 * Library of Congress — JSON API поверх обычного поиска фотографий.
 * https://www.loc.gov/apis/json-and-yaml/
 *
 * Фотоколлекции LOC (FSA/OWI и др.) — public domain / no known restrictions.
 */
import type { SourceConfig } from "../config.js";
import type { RawItem, SourceAdapter } from "./types.js";

type LocResult = {
  id?: string;
  url?: string;
  title?: string;
  description?: string[] | string;
  date?: string;
  location?: string[];
  image_url?: string[];
  access_restricted?: boolean;
};

export function parseYear(text: string | undefined): number | undefined {
  if (!text) return undefined;
  const m = text.match(/\b(1[89]\d{2}|20\d{2})\b/);
  return m ? Number(m[1]) : undefined;
}

/** image_url в LOC несёт размеры во фрагменте: ...jpg#h=768&w=1024 */
function pickLargestImage(urls: string[]): { url: string; width?: number } | undefined {
  let best: { url: string; width?: number } | undefined;
  for (const raw of urls) {
    const url = raw.startsWith("//") ? `https:${raw}` : raw;
    const width = Number(url.match(/[#&]w=(\d+)/)?.[1]) || undefined;
    if (!best || (width ?? 0) > (best.width ?? 0)) best = { url, width };
  }
  return best;
}

export function mapLocResult(r: LocResult): RawItem | undefined {
  if (r.access_restricted) return undefined;
  if (!r.image_url?.length || !r.id) return undefined;

  const image = pickLargestImage(r.image_url);
  if (!image) return undefined;
  // у коллекций LOC вместо фото — SVG-заглушка вида
  // /static/images/original-format/group-of-images.svg (живой прогон)
  if (image.url.includes("/static/images/") || /\.svg(\?|#|$)/.test(image.url)) {
    return undefined;
  }

  const sourceId = r.id.replace(/^https?:\/\/www\.loc\.gov\/item\//, "").replace(/\/$/, "");
  const description = Array.isArray(r.description) ? r.description.join(" ") : r.description;

  return {
    sourceId,
    sourceUrl: r.url ?? r.id,
    imageUrl: image.url,
    imageWidth: image.width,
    title: r.title,
    description,
    lang: "en",
    year: parseYear(r.date) ?? parseYear(r.title),
    place: r.location?.[0],
    license: "PD",
  };
}

async function fetchQuery(query: string, count: number): Promise<LocResult[]> {
  const url = new URL("https://www.loc.gov/photos/");
  url.searchParams.set("q", query);
  url.searchParams.set("fo", "json");
  url.searchParams.set("c", String(count));
  // без User-Agent loc.gov отдаёт 403 с датацентровых IP (GitHub Actions — Azure)
  const res = await fetch(url, {
    headers: {
      accept: "application/json",
      "user-agent":
        "Mozilla/5.0 (compatible; story-team-bot/0.1; historical photo curation)",
    },
  });
  if (!res.ok) throw new Error(`loc: ${url} → HTTP ${res.status}`);
  const body = (await res.json()) as { results?: LocResult[] };
  return body.results ?? [];
}

export const loc: SourceAdapter = {
  name: "loc",

  async fetch(limit: number, cfg: SourceConfig): Promise<RawItem[]> {
    const queries = cfg.queries?.length ? cfg.queries : [""];
    const perQuery = Math.ceil(limit / queries.length);
    const items: RawItem[] = [];
    for (const q of queries) {
      const results = await fetchQuery(q, perQuery);
      for (const r of results) {
        const item = mapLocResult(r);
        if (item) items.push(item);
      }
    }
    return items.slice(0, limit);
  },
};
