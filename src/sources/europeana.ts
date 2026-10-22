/**
 * Europeana — агрегатор европейских архивов. Нужен бесплатный ключ:
 * https://pro.europeana.eu/page/get-api (без карты).
 * Источник включается, когда в окружении появляется EUROPEANA_API_KEY.
 */
import { locQueries, type SourceConfig } from "../config.js";
import type { RawItem, SourceAdapter } from "./types.js";
import type { CursorStore } from "../cursors.js";
import { parseYear } from "./loc.js";

const API = "https://api.europeana.eu/record/v2/search.json";

type EuropeanaItem = {
  id?: string;
  title?: string[];
  dcDescription?: string[];
  edmIsShownBy?: string[];
  year?: string[];
  country?: string[];
  dataProvider?: string[];
  rights?: string[];
};

/** IIIF-рендер «/full/512,/0/default.jpg» → тот же кадр в 1600 px. */
export function upsizeIiif(url: string): string {
  return url.replace(/\/full\/(?:\d+,\d*|,\d+|!\d+,\d+)\/0\/default\.jpg/, "/full/1600,/0/default.jpg");
}

/** Хосты, отдающие файлы только с авторизацией. */
const CLOSED_HOSTS = /\/\/[^/]*zetcom\.app\//i;

export const europeana: SourceAdapter = {
  name: "europeana",

  async fetch(limit, cfg: SourceConfig, cursors: CursorStore): Promise<RawItem[]> {
    const apiKey = process.env.EUROPEANA_API_KEY?.trim();
    if (!apiKey) {
      console.warn("europeana: EUROPEANA_API_KEY не задан — источник пропущен");
      return [];
    }

    const own = locQueries(cfg);
    const queries = own.length ? own : [{ q: "world war", theme: "photography" }];
    const perQuery = Math.ceil(limit / queries.length);
    const items: RawItem[] = [];

    for (const { q, theme, rubric } of queries) {
      const start = (await cursors.get("europeana", q)) + 1; // 1-based
      const url = new URL(API);
      url.searchParams.set("wskey", apiKey);
      url.searchParams.set("query", q);
      url.searchParams.append("qf", "TYPE:IMAGE");
      url.searchParams.append("qf", "MEDIA:true");
      // только свободные лицензии: PD, CC0, CC BY, CC BY-SA. Без этого
      // фильтр ниже пропускал «creativecommons» вида BY-NC-ND - запрет
      // на коммерцию и переделку, канал такое брать не может
      url.searchParams.set("reusability", "open");
      if (theme) url.searchParams.set("theme", theme);
      url.searchParams.set("rows", String(perQuery));
      url.searchParams.set("start", String(start));
      url.searchParams.set("profile", "rich");

      const res = await fetch(url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) {
        console.warn(`europeana: "${q}" → HTTP ${res.status}`);
        continue;
      }
      const body = (await res.json()) as { items?: EuropeanaItem[] };
      const found = body.items ?? [];
      await cursors.set("europeana", q, found.length < perQuery ? 0 : start - 1 + found.length);

      for (const r of found) {
        if (!r.id || !r.edmIsShownBy?.[0]) continue;
        // Телеграм берёт фото по ссылке только картинкой: tiff и pdf -
        // это 400 при публикации, а не пост
        if (/\.(tiff?|pdf|jp2)(\?|$)/i.test(r.edmIsShownBy[0])) continue;
        // превью вместо файла: «thumbnail» и IIIF-рендеры в 512 px. IIIF
        // просим крупнее сами - тот же сервер отдаёт любой размер
        const imageUrl = upsizeIiif(r.edmIsShownBy[0]);
        if (/thumbnail/i.test(imageUrl)) continue;
        // файлы, закрытые авторизацией: финские музеи (zetcom) на каждый
        // запрос отвечают 401 - сборы 22.10 дважды тратили на них слот
        if (CLOSED_HOSTS.test(imageUrl)) continue;
        const rights = r.rights?.[0] ?? "";
        // берём только открытые лицензии, и без NC/ND даже при сбое фильтра API
        if (!/publicdomain|creativecommons/.test(rights) || /\/by-(nc|nd)|\/by-sa-nc|-nc-|-nd\b/.test(rights)) continue;
        const isPd = /publicdomain|zero/.test(rights);
        const provider = r.dataProvider?.[0] ?? "Europeana";
        items.push({
          sourceId: r.id,
          sourceUrl: `https://www.europeana.eu/item${r.id}`,
          imageUrl,
          title: r.title?.[0],
          description: r.dcDescription?.[0],
          lang: "en",
          year: r.year?.[0] ? Number(r.year[0]) || parseYear(r.year[0]) : parseYear(r.title?.[0]),
          place: r.country?.[0],
          license: isPd ? "PD" : rights,
          // архив-поставщик нужен балансиру всегда, и у PD тоже: иначе все
          // кадры Europeana для чередования - один архив без страны
          attribution: `${provider} / ${isPd ? "PD" : rights}`,
          ...(rubric ? { rubric } : {}),
        });
      }
    }
    return items.slice(0, limit);
  },
};
