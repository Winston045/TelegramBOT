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

/**
 * Подпись для всех запросов к Викимедиа. Правила их API требуют в
 * User-Agent контакт - ссылку или почту; клиентов без контакта
 * датацентровые лимиты режут первыми.
 */
export const WIKIMEDIA_UA = "story-team-bot/0.1 (https://t.me/Story_Teams; Telegram history channel)";
const UA = WIKIMEDIA_UA;
const INTRO_LIMIT = 1200;
const RETRIES = 1;
const RETRY_DELAY_MS = 2_000;
/** Пауза между запросами к Википедии: датацентровым адресам лимит строже. */
const MIN_GAP_MS = 1_000;
/** Сколько молчать после 429. */
const COOLDOWN_MS = 60_000;
let lastRequestAt = 0;
let cooldownUntil = 0;

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

  // Вежливый темп и пауза после отказа. Полный сбор 22.10: Википедия
  // отвечала 429 на десятки запросов подряд - справка о событии перебирала
  // по восемь статей на кадр и выжигала лимит, и до справки о предмете в
  // кадре (ради неё всё и затевалось) очередь не доходила
  if (Date.now() < cooldownUntil) return undefined;
  for (let attempt = 0; ; attempt++) {
    const wait = lastRequestAt + MIN_GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastRequestAt = Date.now();
    try {
      const res = await fetch(url, {
        headers: { "user-agent": UA },
        signal: AbortSignal.timeout(20_000),
      });
      if (res.ok) {
        const body = (await res.json()) as { query?: { pages?: WikiPage[] } };
        return body.query?.pages?.[0];
      }
      if (res.status === 429) {
        // повтор через пару секунд только продлит отказ - пауза на минуту
        cooldownUntil = Date.now() + COOLDOWN_MS;
        console.warn(`  википедия: 429 на «${title}» - пауза ${COOLDOWN_MS / 1000} с`);
        return undefined;
      }
      if (res.status < 500) return undefined;
      if (attempt >= RETRIES) console.warn(`  википедия ${lang}: «${title}» → HTTP ${res.status}`);
    } catch (err) {
      if (attempt >= RETRIES) {
        console.warn(`  википедия ${lang}: «${title}» → ${(err as Error).message}`);
        throw err;
      }
    }
    if (attempt >= RETRIES) return undefined;
    await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
  }
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
