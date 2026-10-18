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

export const europeana: SourceAdapter = {
  name: "europeana",

  async fetch(limit, cfg: SourceConfig, cursors: CursorStore): Promise<RawItem[]> {
    const apiKey = process.env.EUROPEANA_API_KEY?.trim();
    if (!apiKey) {
      console.warn("europeana: EUROPEANA_API_KEY не задан — источник пропущен");
      return [];
    }

    const own = locQueries(cfg).map((x) => x.q);
    const queries = own.length ? own : ["world war"];
    const perQuery = Math.ceil(limit / queries.length);
    const items: RawItem[] = [];

    for (const q of queries) {
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
        const rights = r.rights?.[0] ?? "";
        // берём только открытые лицензии, и без NC/ND даже при сбое фильтра API
        if (!/publicdomain|creativecommons/.test(rights) || /\/by-(nc|nd)|\/by-sa-nc|-nc-|-nd\b/.test(rights)) continue;
        const isPd = /publicdomain|zero/.test(rights);
        const provider = r.dataProvider?.[0] ?? "Europeana";
        items.push({
          sourceId: r.id,
          sourceUrl: `https://www.europeana.eu/item${r.id}`,
          imageUrl: r.edmIsShownBy[0],
          title: r.title?.[0],
          description: r.dcDescription?.[0],
          lang: "en",
          year: r.year?.[0] ? Number(r.year[0]) || parseYear(r.year[0]) : parseYear(r.title?.[0]),
          place: r.country?.[0],
          license: isPd ? "PD" : rights,
          // архив-поставщик нужен балансиру всегда, и у PD тоже: иначе все
          // кадры Europeana для чередования - один архив без страны
          attribution: `${provider} / ${isPd ? "PD" : rights}`,
        });
      }
    }
    return items.slice(0, limit);
  },
};
