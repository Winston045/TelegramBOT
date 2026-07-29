/**
 * Wikimedia Commons — не только Бундесархив: там лежат оцифровки военных
 * архивов разных стран (Имперский военный музей Британии, РИА Новости,
 * Национальный архив США, Австралийский военный мемориал...). Один адаптер
 * ходит по пулу категорий из config, давая каналу разные страны и фронты.
 *
 * У большинства архивов (кроме Бундесархива) места в заголовке файла нет —
 * такие записи пропускаем дальше только с содержательным описанием,
 * из которого модель возьмёт контекст.
 */
import type { SourceConfig } from "../config.js";
import type { RawItem, SourceAdapter } from "./types.js";
import type { CursorStore } from "../cursors.js";
import { mapCommonsPage, type CommonsPage } from "./bundesarchiv.js";

const API = "https://commons.wikimedia.org/w/api.php";

/** Без места нужен хотя бы такой длины текст описания — иначе брак. */
const MIN_DESC_WITHOUT_PLACE = 60;

async function search(
  category: string,
  term: string,
  limit: number,
  offset: number,
): Promise<CommonsPage[]> {
  const url = new URL(API);
  url.searchParams.set("action", "query");
  url.searchParams.set("format", "json");
  url.searchParams.set("formatversion", "2");
  url.searchParams.set("generator", "search");
  url.searchParams.set("gsrsearch", `incategory:"${category}" ${term}`.trim());
  url.searchParams.set("gsrnamespace", "6"); // File:
  url.searchParams.set("gsrlimit", String(Math.min(limit, 50)));
  url.searchParams.set("gsroffset", String(offset));
  url.searchParams.set("prop", "imageinfo");
  url.searchParams.set("iiprop", "url|size|extmetadata");
  // рендер вместо оригинала: у NARA и IWM оригиналы - гигантские .tif,
  // которые Телеграм не примет; thumburl всегда jpeg разумного размера
  url.searchParams.set("iiurlwidth", "1600");
  url.searchParams.set(
    "iiextmetadatafilter",
    "ImageDescription|DateTimeOriginal|LicenseShortName|Artist|Credit",
  );

  const res = await fetch(url, {
    headers: { "user-agent": "story-team-bot/0.1 (contentbot)" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`commons: ${category} → HTTP ${res.status}`);
  const body = (await res.json()) as { query?: { pages?: CommonsPage[] } };
  return body.query?.pages ?? [];
}

export const commons: SourceAdapter = {
  name: "commons",

  async fetch(limit, cfg: SourceConfig, cursors: CursorStore): Promise<RawItem[]> {
    const archives = cfg.archives ?? [];
    if (!archives.length) {
      console.warn("  commons: пул архивов в config пуст");
      return [];
    }
    const sharedTerms = cfg.categories?.length ? cfg.categories : [""];
    const perArchive = Math.max(5, Math.ceil(limit / archives.length));
    const items: RawItem[] = [];

    for (const archive of archives) {
      // у архива могут быть свои слова: у РИА Новости в названиях файлов
      // нет годов, ей нужен пустой фильтр — просто листаем категорию
      const terms = archive.terms?.length ? archive.terms : sharedTerms;
      // ротация поисковых слов и смещение внутри слова — как в других
      // источниках, чтобы каждый день приходила новая страница выдачи
      const termIdx = await cursors.get("commons", `term:${archive.category}`);
      const term = terms[termIdx % terms.length] ?? "";
      const offKey = `off:${archive.category}:${term}`;
      const offset = await cursors.get("commons", offKey);

      let pages: CommonsPage[];
      try {
        pages = await search(archive.category, term, perArchive, offset);
      } catch (err) {
        console.warn(`  commons: ${archive.attribution} — ${(err as Error).message}`);
        continue;
      }
      if (pages.length === 0 && offset === 0) {
        console.warn(
          `  commons: категория "${archive.category}" по "${term}" пуста — проверьте имя`,
        );
      }

      for (const page of pages) {
        const item = mapCommonsPage(page, {
          lang: archive.lang,
          attributionPrefix: archive.attribution,
        });
        if (!item) continue;
        // без места пропускаем только записи с содержательным описанием
        if (!item.place && (item.description?.length ?? 0) < MIN_DESC_WITHOUT_PLACE) continue;
        items.push(item);
      }

      // выдача по слову кончилась — со следующего запуска новое слово
      if (pages.length < perArchive) {
        await cursors.set("commons", offKey, 0);
        await cursors.set("commons", `term:${archive.category}`, termIdx + 1);
      } else {
        await cursors.set("commons", offKey, offset + pages.length);
      }
    }
    return items.slice(0, limit);
  },
};
