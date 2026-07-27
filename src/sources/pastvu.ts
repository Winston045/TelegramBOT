/**
 * PastVu — краудсорсинговый архив старых фотографий (много российских
 * и советских). Открытый JSON API без ключа.
 *
 * Список: /api2?method=photos.give&params={"year","year2","limit","skip"}
 * Детали: /api2?method=photo.giveForPage&params={"cid"} — описание, адрес, автор.
 */
import type { SourceConfig } from "../config.js";
import type { RawItem, SourceAdapter } from "./types.js";
import type { CursorStore } from "../cursors.js";

const API = "https://pastvu.com/api2";

type PastvuListPhoto = {
  cid: number;
  file: string;
  title?: string;
  year?: number;
  year2?: number;
};

type PastvuDetails = {
  desc?: string;
  address?: string;
  author?: string;
  regions?: Array<{ title_local?: string }>;
  y?: string;
};

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function call<T>(method: string, params: object): Promise<T> {
  const url = `${API}?method=${method}&params=${encodeURIComponent(JSON.stringify(params))}`;
  const res = await fetch(url, {
    headers: { "user-agent": "story-team-bot/0.1 (contentbot)" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`pastvu: ${method} → HTTP ${res.status}`);
  const body = (await res.json()) as { result?: T };
  if (!body.result) throw new Error(`pastvu: ${method} — пустой result`);
  return body.result;
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

export const pastvu: SourceAdapter = {
  name: "pastvu",

  async fetch(limit, cfg: SourceConfig, cursors: CursorStore): Promise<RawItem[]> {
    const yearFrom = cfg.years?.[0] ?? 1900;
    const yearTo = cfg.years?.[1] ?? 1965;
    const key = `${yearFrom}-${yearTo}`;

    const skip = await cursors.get("pastvu", key);
    const { photos } = await call<{ photos: PastvuListPhoto[] }>("photos.give", {
      year: yearFrom,
      year2: yearTo,
      limit: Math.min(limit, 30),
      skip,
    });
    await cursors.set("pastvu", key, photos.length < Math.min(limit, 30) ? 0 : skip + photos.length);

    const items: RawItem[] = [];
    for (const p of photos) {
      try {
        const { photo } = await call<{ photo: PastvuDetails }>("photo.giveForPage", {
          cid: p.cid,
        });
        const place =
          photo.address ||
          photo.regions?.map((r) => r.title_local).filter(Boolean).join(", ") ||
          undefined;
        items.push({
          sourceId: String(p.cid),
          sourceUrl: `https://pastvu.com/${p.cid}`,
          imageUrl: `https://pastvu.com/_p/d/${p.file}`,
          title: p.title,
          description: photo.desc ? stripHtml(photo.desc) : undefined,
          lang: "ru",
          year: p.year,
          place,
          license: "PastVu",
          attribution: photo.author ? `PastVu / ${stripHtml(photo.author)}` : undefined,
        });
      } catch (err) {
        console.warn(`  pastvu: детали ${p.cid} не получены — ${(err as Error).message}`);
      }
      await sleep(150);
    }
    return items;
  },
};
