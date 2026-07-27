/**
 * NARA — Национальный архив США. Catalog API v2, нужен бесплатный ключ:
 * https://catalog.archives.gov/api/v2/api-key (без карты).
 * Источник включается, когда в окружении появляется NARA_API_KEY.
 */
import type { SourceConfig } from "../config.js";
import type { RawItem, SourceAdapter } from "./types.js";
import type { CursorStore } from "../cursors.js";
import { parseYear } from "./loc.js";

const API = "https://catalog.archives.gov/api/v2/records/search";

type NaraHit = {
  _source?: {
    record?: {
      naId?: number;
      title?: string;
      scopeAndContentNote?: string;
      productionDates?: Array<{ logicalDate?: string; year?: number }>;
      digitalObjects?: Array<{ objectUrl?: string; objectType?: string }>;
    };
  };
};

export const nara: SourceAdapter = {
  name: "nara",

  async fetch(limit, cfg: SourceConfig, cursors: CursorStore): Promise<RawItem[]> {
    const apiKey = process.env.NARA_API_KEY?.trim();
    if (!apiKey) {
      console.warn("nara: NARA_API_KEY не задан — источник пропущен");
      return [];
    }

    const queries = cfg.queries?.length ? cfg.queries : ["world war"];
    const perQuery = Math.ceil(limit / queries.length);
    const items: RawItem[] = [];

    for (const q of queries) {
      const page = Math.max(1, (await cursors.get("nara", q)) + 1);
      const url = new URL(API);
      url.searchParams.set("q", q);
      url.searchParams.set("limit", String(perQuery));
      url.searchParams.set("page", String(page));
      url.searchParams.set("typeOfMaterials", "Photographs and other Graphic Materials");

      const res = await fetch(url, {
        headers: { "x-api-key": apiKey, accept: "application/json" },
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) {
        console.warn(`nara: "${q}" → HTTP ${res.status}`);
        continue;
      }
      const body = (await res.json()) as { body?: { hits?: { hits?: NaraHit[] } } };
      const hits = body.body?.hits?.hits ?? [];
      await cursors.set("nara", q, hits.length < perQuery ? 0 : page);

      for (const hit of hits) {
        const r = hit._source?.record;
        if (!r?.naId) continue;
        const image = r.digitalObjects?.find((o) =>
          /\.(jpe?g|png)(\?|$)/i.test(o.objectUrl ?? ""),
        )?.objectUrl;
        if (!image) continue;
        const dateText = r.productionDates
          ?.map((d) => d.logicalDate ?? String(d.year ?? ""))
          .join(" ");
        items.push({
          sourceId: String(r.naId),
          sourceUrl: `https://catalog.archives.gov/id/${r.naId}`,
          imageUrl: image,
          title: r.title,
          description: r.scopeAndContentNote,
          lang: "en",
          year: parseYear(dateText) ?? parseYear(r.title),
          place: undefined, // место чаще всего в title — префильтр отсеет пустые
          license: "PD",
        });
      }
    }
    return items.slice(0, limit);
  },
};
