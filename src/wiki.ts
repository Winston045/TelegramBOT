/**
 * Справки из Википедии - легальный источник фактов для изюминки.
 *
 * Архив пишет, ЧТО на снимке («Allied observation balloon, Ypres 1917»),
 * но почти никогда - как это было устроено и чем удивительно. Раньше
 * единственной справкой была статья о СОБЫТИИ (по категории файла), и
 * изюминка превращалась в штабную сводку: цели наступления на Пашендаль,
 * узел снабжения 4-й армии. Читателю интереснее сам предмет в кадре:
 * аэростат, эсминец, танк. Модель называет его статью (subject_wiki), а
 * здесь мы достаём вступление - факты остаются документальными, не
 * выдуманными.
 */

const UA = "story-team-bot/0.1 (Telegram history channel; contact via t.me/Story_Teams)";
const INTRO_LIMIT = 1200;

/** Страница-развилка («может означать», «may refer to») - не справка. */
const DISAMBIGUATION = /may refer to|may also refer to|может означать|может относиться/i;

type WikiPage = {
  title?: string;
  missing?: boolean;
  extract?: string;
  langlinks?: Array<{ lang: string; title: string }>;
  pageprops?: { disambiguation?: string };
};

async function fetchPage(lang: string, title: string, withRuLink: boolean): Promise<WikiPage | undefined> {
  const url = new URL(`https://${lang}.wikipedia.org/w/api.php`);
  url.searchParams.set("action", "query");
  url.searchParams.set("format", "json");
  url.searchParams.set("formatversion", "2");
  url.searchParams.set("prop", withRuLink ? "extracts|langlinks|pageprops" : "extracts|pageprops");
  url.searchParams.set("exintro", "1");
  url.searchParams.set("explaintext", "1");
  url.searchParams.set("redirects", "1");
  url.searchParams.set("titles", title);
  if (withRuLink) url.searchParams.set("lllang", "ru");

  const res = await fetch(url, {
    headers: { "user-agent": UA },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) return undefined;
  const body = (await res.json()) as { query?: { pages?: WikiPage[] } };
  return body.query?.pages?.[0];
}

function usable(page: WikiPage | undefined): string | undefined {
  if (!page || page.missing || !page.extract) return undefined;
  if (page.pageprops?.disambiguation !== undefined) return undefined;
  const text = page.extract.replace(/\s+/g, " ").trim();
  if (text.length < 120 || DISAMBIGUATION.test(text.slice(0, 300))) return undefined;
  return text.slice(0, INTRO_LIMIT);
}

/** Вступление статьи по точному названию; undefined - нет статьи или это развилка. */
export async function wikiIntro(lang: string, title: string): Promise<string | undefined> {
  try {
    return usable(await fetchPage(lang, title, false));
  } catch {
    return undefined;
  }
}

/**
 * Справка о предмете в кадре по английскому названию статьи. Русская
 * версия, если она есть, точнее в терминах («привязной аэростат», а не
 * калька), поэтому сначала идём по межъязыковой ссылке, потом берём
 * английскую. Сбой сети - не повод ронять кадр: справки просто не будет.
 */
export async function subjectReference(enTitle: string): Promise<string | undefined> {
  const title = enTitle.trim();
  if (!title || title.length > 120) return undefined;
  try {
    const en = await fetchPage("en", title, true);
    const enText = usable(en);
    if (!enText) return undefined; // развилка или не та статья - лучше без справки
    const ruTitle = en?.langlinks?.find((l) => l.lang === "ru")?.title;
    const ruText = ruTitle ? await wikiIntro("ru", ruTitle) : undefined;
    const name = ruText ? ruTitle : en?.title ?? title;
    return `Справка из Википедии о предмете в кадре («${name}»), использовать только если она точно про то, что на фото:\n${ruText ?? enText}`;
  } catch {
    return undefined;
  }
}
