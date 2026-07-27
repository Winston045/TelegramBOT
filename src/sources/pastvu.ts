/**
 * PastVu — краудсорсинговый архив старых фотографий (много российских
 * и советских). Открытый JSON API без ключа.
 *
 * Контракт проверен вживую (tg-diag, июль 2026): метода photos.give нет,
 * рабочие методы — photo.giveNearestPhotos (геопоиск с фильтром по годам
 * и пагинацией skip) и photo.giveForPage (полная карточка: описание,
 * автор, регионы, размеры). Поэтому собираем по пулу точек в городах,
 * богатых историей 1914-1960, ротируя города и сдвигая skip через курсоры.
 */
import type { SourceConfig } from "../config.js";
import type { RawItem, SourceAdapter } from "./types.js";
import type { CursorStore } from "../cursors.js";

const API = "https://pastvu.com/api2";

/** Точки геопоиска: город + координаты центра. */
const GEO_POOL: Array<{ name: string; geo: [number, number] }> = [
  { name: "Москва", geo: [55.751, 37.617] },
  { name: "Санкт-Петербург", geo: [59.939, 30.316] },
  { name: "Волгоград", geo: [48.708, 44.514] },
  { name: "Севастополь", geo: [44.617, 33.525] },
  { name: "Киев", geo: [50.45, 30.523] },
  { name: "Минск", geo: [53.902, 27.562] },
  { name: "Берлин", geo: [52.52, 13.405] },
  { name: "Варшава", geo: [52.23, 21.011] },
  { name: "Курск", geo: [51.73, 36.193] },
  { name: "Смоленск", geo: [54.782, 32.045] },
  { name: "Одесса", geo: [46.485, 30.733] },
  { name: "Брест", geo: [52.097, 23.734] },
  { name: "Калининград", geo: [54.71, 20.452] },
  { name: "Новороссийск", geo: [44.724, 37.768] },
  { name: "Мурманск", geo: [68.97, 33.075] },
  { name: "Вена", geo: [48.208, 16.373] },
];

/** Городов за один сбор — для разнообразия внутри партии. */
const CITIES_PER_FETCH = 3;

type PastvuListPhoto = {
  cid: number;
  file: string;
  title?: string;
  year?: number;
};

type PastvuPagePhoto = {
  desc?: string;
  address?: string;
  author?: string;
  regions?: Array<{ title_local?: string }>;
  year?: number;
  year2?: number;
  w?: number;
  /** 1 — фотография, 2 — живопись (её пропускаем) */
  type?: number;
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
  const body = (await res.json()) as { result?: T; message?: string };
  if (!body.result) throw new Error(`pastvu: ${method} — ${body.message ?? "пустой result"}`);
  return body.result;
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

async function fetchDetails(cid: number): Promise<PastvuPagePhoto> {
  const { photo } = await call<{ photo: PastvuPagePhoto }>("photo.giveForPage", { cid });
  return photo;
}

function buildItem(p: PastvuListPhoto, city: string, photo: PastvuPagePhoto): RawItem {
  const place =
    photo.address ||
    photo.regions?.map((r) => r.title_local).filter(Boolean).join(", ") ||
    city;
  let description = photo.desc ? stripHtml(photo.desc) : undefined;
  // Если датировка — диапазон, упоминаем обе границы: валидатор подписи
  // разрешает только годы, встречающиеся в метаданных.
  if (photo.year2 && photo.year && photo.year2 !== photo.year) {
    const range = `Датировка: ${photo.year}-${photo.year2}.`;
    description = description ? `${description} ${range}` : range;
  }
  return {
    sourceId: String(p.cid),
    sourceUrl: `https://pastvu.com/${p.cid}`,
    imageUrl: `https://pastvu.com/_p/d/${p.file}`,
    title: p.title,
    description,
    lang: "ru",
    year: photo.year ?? p.year,
    place,
    license: "PastVu",
    attribution: photo.author ? `PastVu / ${stripHtml(photo.author)}` : undefined,
    imageWidth: photo.w,
  };
}

export const pastvu: SourceAdapter = {
  name: "pastvu",

  async fetch(limit, cfg: SourceConfig, cursors: CursorStore): Promise<RawItem[]> {
    const yearFrom = cfg.years?.[0] ?? 1900;
    const yearTo = cfg.years?.[1] ?? 1965;
    const perCity = Math.max(3, Math.ceil(limit / CITIES_PER_FETCH));

    const cityStart = await cursors.get("pastvu", "city");
    const items: RawItem[] = [];

    for (let i = 0; i < CITIES_PER_FETCH && items.length < limit; i++) {
      const idx = (cityStart + i) % GEO_POOL.length;
      const point = GEO_POOL[idx];
      if (!point) continue;
      const { name, geo } = point;
      const skipKey = `skip:${idx}:${yearFrom}-${yearTo}`;
      const skip = await cursors.get("pastvu", skipKey);

      let photos: PastvuListPhoto[];
      try {
        const res = await call<{ photos: PastvuListPhoto[] }>("photo.giveNearestPhotos", {
          geo,
          limit: perCity,
          skip,
          year: yearFrom,
          year2: yearTo,
        });
        photos = res.photos ?? [];
      } catch (err) {
        console.warn(`  pastvu: ${name} — ${(err as Error).message}`);
        continue;
      }
      // выдача кончилась — начинаем город заново со следующего цикла
      await cursors.set("pastvu", skipKey, photos.length < perCity ? 0 : skip + photos.length);

      for (const p of photos) {
        if (items.length >= limit) break;
        try {
          const photo = await fetchDetails(p.cid);
          if (photo.type === 2) continue; // живопись, не фотография
          const year = photo.year ?? p.year;
          if (year && (year < yearFrom || year > yearTo)) continue;
          items.push(buildItem(p, name, photo));
        } catch (err) {
          console.warn(`  pastvu: детали ${p.cid} не получены — ${(err as Error).message}`);
        }
        await sleep(150);
      }
    }

    await cursors.set("pastvu", "city", (cityStart + CITIES_PER_FETCH) % GEO_POOL.length);
    return items;
  },

  async details(item: RawItem): Promise<string | undefined> {
    const photo = await fetchDetails(Number(item.sourceId));
    const parts = [
      photo.desc ? stripHtml(photo.desc) : undefined,
      photo.address,
      photo.regions?.map((r) => r.title_local).filter(Boolean).join(", "),
      photo.author ? `Автор: ${stripHtml(photo.author)}` : undefined,
    ].filter(Boolean);
    return parts.length ? parts.join(". ").slice(0, 1500) : undefined;
  },
};
