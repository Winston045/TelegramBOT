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
    // выдачу каждого архива держим отдельно: в конце сливаем по кругу,
    // иначе первый архив списка (Бундесархив) занимал весь лимит, а
    // дописанные в конец (Anefo, Signal Corps) не доходили никогда
    const byArchive: RawItem[][] = [];
    // стартовый архив сдвигается каждый прогон - при малом лимите очередь
    // обходит весь пул за несколько заходов, а не долбит одни и те же
    const startIdx = await cursors.get("commons", "archive-start");
    const rotated = archives.map(
      (_, i) => archives[(i + startIdx) % archives.length]!,
    );

    for (const archive of rotated) {
      const items: RawItem[] = [];
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

      // смещение внутри слова: когда очередь снова дойдёт до этого года,
      // продолжим с того же места (или с начала, если выдача кончилась)
      await cursors.set("commons", offKey, pages.length < perArchive ? 0 : offset + pages.length);
      // год меняется КАЖДЫЙ запуск. Раньше - только по исчерпанию выдачи,
      // и на гигантских категориях бот неделями сидел в первом годе списка:
      // живая лента превратилась в сплошную ПМВ
      await cursors.set("commons", `term:${archive.category}`, termIdx + 1);
      if (items.length) byArchive.push(items);
    }

    await cursors.set("commons", "archive-start", (startIdx + 1) % archives.length);
    // слияние по кругу: первый кадр каждого архива, потом второй и так
    // далее - срез любой длины остаётся представительным
    const merged: RawItem[] = [];
    for (let row = 0; merged.length < limit; row++) {
      const before = merged.length;
      for (const list of byArchive) {
        const item = list[row];
        if (item) merged.push(item);
        if (merged.length >= limit) break;
      }
      if (merged.length === before) break; // все списки исчерпаны
    }
    return merged;
  },

  /**
   * Подписи архивов вроде «Frankreich, Lorettohöhe, Artilleriebeschuss» -
   * это одна строка, из которой познавательную цитату не сделать. Зато у
   * файла есть тематические категории (люди, сражения, корабли), и по ним
   * находится статья Википедии - её вступление и даёт материал для
   * развёрнутой справки. Факты остаются документальными, не выдуманными.
   */
  async details(item: RawItem): Promise<string | undefined> {
    try {
      const topics = await fileTopics(item.sourceId, item.title);
      if (!topics.length) return undefined;
      for (const topic of topics) {
        const intro = (await wikiIntro("ru", topic)) ?? (await wikiIntro("en", topic));
        if (intro && intro.length >= 200) {
          return `Справка из Википедии о теме снимка («${topic}»), использовать только если она прямо относится к тому, что на фото:\n${intro}`;
        }
      }
      return undefined;
    } catch {
      return undefined;
    }
  },
};

// служебные категории Викисклада, из которых темы не выйдет
const SERVICE_CATEGORY =
  /images? from|photographs? from|files? from|media (from|needing)|cc-|pd-|licen|scan|uploaded|wikimedia|self-published|extracted|retouched|flickr|taken (on|with)|\bde\b-|german federal archive/i;

/** Тематические категории файла: сперва те, что перекликаются с заголовком. */
async function fileTopics(pageId: string, title?: string): Promise<string[]> {
  const url = new URL(API);
  url.searchParams.set("action", "query");
  url.searchParams.set("format", "json");
  url.searchParams.set("formatversion", "2");
  url.searchParams.set("pageids", pageId);
  url.searchParams.set("prop", "categories");
  url.searchParams.set("cllimit", "50");
  url.searchParams.set("clshow", "!hidden");

  const res = await fetch(url, {
    headers: { "user-agent": "story-team-bot/0.1 (contentbot)" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) return [];
  const body = (await res.json()) as {
    query?: { pages?: Array<{ categories?: Array<{ title: string }> }> };
  };
  // слова заголовка задают тему кадра: категория, которая с ними
  // пересекается, почти всегда и есть предмет съёмки
  const titleWords = new Set(
    (title ?? "")
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length > 3),
  );
  const relevance = (cat: string) =>
    cat
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => titleWords.has(w)).length;

  return (body.query?.pages?.[0]?.categories ?? [])
    .map((c) => c.title.replace(/^Category:/, ""))
    .filter((t) => !SERVICE_CATEGORY.test(t) && !/^\d{4}$/.test(t))
    .sort((a, b) => relevance(b) - relevance(a) || a.length - b.length)
    .slice(0, 8);
}

/** Вступление статьи Википедии по точному названию. */
async function wikiIntro(lang: string, title: string): Promise<string | undefined> {
  const url = new URL(`https://${lang}.wikipedia.org/w/api.php`);
  url.searchParams.set("action", "query");
  url.searchParams.set("format", "json");
  url.searchParams.set("formatversion", "2");
  url.searchParams.set("prop", "extracts");
  url.searchParams.set("exintro", "1");
  url.searchParams.set("explaintext", "1");
  url.searchParams.set("redirects", "1");
  url.searchParams.set("titles", title);

  const res = await fetch(url, {
    headers: { "user-agent": "story-team-bot/0.1 (contentbot)" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) return undefined;
  const body = (await res.json()) as {
    query?: { pages?: Array<{ missing?: boolean; extract?: string }> };
  };
  const page = body.query?.pages?.[0];
  if (!page || page.missing || !page.extract) return undefined;
  return page.extract.replace(/\s+/g, " ").trim().slice(0, 1200);
}
