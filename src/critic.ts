/**
 * Второй заход Gemini - редактор цитаты.
 *
 * Первый запрос делает всё сразу (оценка, теги, подпись), но справки о
 * самом предмете в кадре у него нет - только метаданные и статья о
 * событии. Отсюда штабные сводки вместо изюминок (аэростат у Ипра,
 * 10.2026: цели наступления на Пашендаль). Этот проход получает ещё и
 * справку о предмете (subject_wiki) и:
 * - слабую цитату (сводка, пересказ, опись, протокол, прописная истина)
 *   переписывает в научпоп о том, что в кадре, или сводит к «место, год»;
 * - обычный пост поднимает до изюминки, если справка даёт сильный факт.
 * Ничего не выдумывает: факты только из метаданных и справок.
 */
import type { AppConfig } from "./config.js";
import type { GeneratedCaption } from "./caption.js";
import { descriptiveSentences, isBarePlaceDate, metadataBlock } from "./caption.js";
import { unsupportedNumbers, validateYears } from "./validate.js";

export { isBarePlaceDate };
import type { RawItem } from "./sources/types.js";
import { GeminiBusyError, geminiJson } from "./gemini.js";

type Verdict = {
  verdict: "ok" | "weak";
  quote?: string;
  quote_kind?: "observation" | "context";
  /** новый текст поста - только ради правила ЛЮДИ */
  caption?: string;
};

export function buildPrompt(
  item: RawItem,
  generated: GeneratedCaption,
  extraContext?: string,
  subjectContext?: string,
  people?: string[],
): string {
  const peopleBlock = people?.length
    ? `\nВ тексте поста названы люди: ${people.join(", ")}.\n`
    : "";
  const placeLine = generated.quote_place
    ? `\nОтдельной строкой после цитаты уже стоит место и дата: ${generated.quote_place}`
    : "";
  const subject = subjectContext
    ? `\n${subjectContext}\n`
    : "\nСправки о предмете в кадре нет.\n";
  return `Ты редактор телеграм-канала о военной истории. Твоя зона - цитата
под фотографией (блок отдельной строкой после основного текста) и одно
правило в тексте поста: люди, названные по имени.

${metadataBlock(item, extraContext)}${subject}${peopleBlock}
Текст поста: ${generated.caption}
Цитата: ${generated.quote || "(пусто)"}${placeLine}

У цитаты в этом канале два законных вида:
- ОБЫЧНЫЙ пост: короткая цитата «место и год» («Австрия, 1946 год»,
  «Север СССР, 1941 год.») - так выглядит основная масса постов;
- ИЗЮМИНКА (каждый третий-четвёртый пост): маленькая история о том, что
  В КАДРЕ, - о технике, корабле, оружии, явлении, людях и их судьбе. Как
  это было устроено, зачем, чем удивительно, чем кончилось. Подача - как
  в хорошем научпопе: первая фраза цепляет (неожиданная деталь, цифра,
  парадокс), дальше развитие и развязка; два-четыре коротких предложения
  живым языком. Аудитория в теме и базовые вещи знает - нужен уровень
  знатока, поданный интересно.

Образец ПОДАЧИ изюминки (чужой кадр - британский аэростат у Ипра; его
факты - не источник, переносить их в цитату нельзя, даже если в кадре
тоже аэростат: факты только из метаданных и справок выше):
«Наблюдатель в плетёной корзине поднимался примерно на километр и видел
на десятки километров вглубь чужих позиций. По телефонному проводу,
вплетённому прямо в трос, он корректировал огонь своих батарей.
Аэростаты наполняли водородом, и одна зажигательная пуля превращала их в
факел. Поэтому их наблюдатели получили парашюты - у лётчиков их тогда ещё
не было.»
Брак на том же кадре: «Целью сражения за Пашендаль был захват высот для
контроля над Руселаре - ключевым узлом снабжения 4-й германской армии» -
в кадре аэростат, а цитата о целях наступления.

Цитата ПЛОХАЯ, если это:
- штабная сводка: цели и ход операции, номера армий и корпусов, узлы
  снабжения, линии фронта, - а кадр не о самом этом бое;
- сухая энциклопедическая справка без зацепки («Аэростат - летательный
  аппарат легче воздуха...»);
- пересказ текста поста или повтор хотя бы одного его предложения;
- опись видимого («слева виден...», «на заднем плане...») без объяснения,
  чем это важно;
- технические сведения о негативе, съёмке или архиве;
- прописная истина школьного учебника («Вторая мировая шла с 1939 по
  1945 год»);
- протокольный список фамилий, должностей или состава делегаций без
  судьбы и смысла;
- средний, ничем не цепляющий псевдофакт, который притворяется изюминкой.

Что делать:
1. Цитата - хорошая изюминка о том, что в кадре: ничего не меняй.
2. Цитата - «место и год» (или пусто): если в метаданных или справках
   есть ПО-НАСТОЯЩЕМУ интересный факт о том, что в кадре, - напиши из него
   изюминку; если нет - ничего не меняй, обычный пост - это норма.
3. Цитата плохая: перепиши её в изюминку о том, что в кадре, по
   метаданным и справкам; если сильной истории из них не собрать -
   положи место и год короткой строкой («СССР, 1943 год.») и убедись,
   что дата не дублирует текст поста.

ЛЮДИ В ТЕКСТЕ ПОСТА. Читатель русскоязычный: иностранных генералов,
чиновников и артистов он не знает, да и своих - далеко не всех. Имя без
пояснения - пустой звук («Трубач Адо Бродбом и саксофонист Джек Селс
выступают...» - брак). Проверь каждого названного человека:
- его знает каждый (Сталин, Черчилль, Гитлер, Жуков, Гагарин,
  Эйзенхауэр, «Битлз») - всё в порядке;
- иначе в тексте должно быть понятно, КТО ОН и ЧЕМ ИНТЕРЕСЕН. Нет -
  перепиши текст поста: добавь короткое пояснение по метаданным и
  справкам («Джордж Паттон, генерал, чьи танки первыми вышли к Рейну»)
  или, если о человеке в материале ничего, кроме фамилии и должности, -
  замени имя ролью («американский генерал», «голландские джазмены»);
- несколько фамилий подряд - оставь одного главного или замени ролью.
Новый текст поста - ровно ОДНО предложение, без даты и без места,
которое уже стоит в цитате; всё остальное в нём сохрани. Текст поста в
порядке - не трогай его.

Жёсткие правила:
- факты СТРОГО из метаданных и справок выше; не досочинять даже то, что
  «все знают», - за выдумку канал теряет доверие читателей;
- справка о предмете идёт в дело, только если она точно про то, что на
  фото (тот же тип техники, тот же корабль); чужая статья - не источник;
- не повторять текст поста и отдельную строку места и даты;
- топонимы в названии на дату снимка; простой текст без HTML и
  markdown; длинное тире не использовать - только обычный дефис.

Верни строго JSON без обёрток, ровно одну из двух форм:
- цитату не менять: {"verdict": "ok"}
- новая цитата: {"verdict": "weak", "quote": "...", "quote_kind": "observation" | "context"}
Если по правилу ЛЮДИ нужно исправить текст поста, добавь в любую из форм
поле "caption": "<новый текст поста>"; иначе поля caption не должно быть.`;
}

/**
 * Принимать ли новый текст поста от редактора. Ему разрешено только
 * пояснить, кто назван, или заменить имя ролью, - поэтому новый текст
 * обязан остаться одним предложением, а его годы и числа должны найтись
 * в источниках или в прежнем тексте. Иначе остаётся старый текст.
 */
export function acceptBody(
  proposed: string | undefined,
  current: string,
  item: RawItem,
  context: Array<string | undefined>,
): string | undefined {
  const body = plainDashes(proposed?.trim() ?? "");
  if (!body || body === current.trim()) return undefined;
  if (body.length > 300 || /<[^>]+>/.test(body)) return undefined;
  if (descriptiveSentences(body) > 1) return undefined;
  const sources = [item.title, item.description, item.place, current, ...context].filter(Boolean).join("\n");
  if (unsupportedNumbers(body, sources).length) return undefined;
  const years = validateYears(body, {
    title: item.title,
    description: item.description,
    year: item.year,
    place: item.place,
    context: [current, ...context].filter(Boolean).join("\n"),
  });
  return years.ok ? body : undefined;
}

/** Длинные тире - в обычный дефис, как во всём, что уходит в канал. */
function plainDashes(text: string): string {
  return text.replace(/[\u2012\u2013\u2014\u2015\u2212]/g, "-");
}

/**
 * Дублирует ли новая цитата отдельную строку места и даты. Сравнение по
 * буквам и цифрам без пунктуации: «Тихий океан, 1945 год.» == «Тихий океан 1945 год».
 */
export function duplicatesPlace(quote: string, place: string | undefined): boolean {
  if (!place) return false;
  const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const q = norm(quote);
  const p = norm(place);
  if (!q || !p) return false;
  return q.includes(p) || p.includes(q);
}

/**
 * Возвращает подпись с проверенной цитатой. Ошибка редактора (квота, сбой
 * разбора) не должна ронять сбор - тогда остаётся исходный вариант.
 */
export async function reviewQuote(
  item: RawItem,
  cfg: AppConfig,
  generated: GeneratedCaption,
  extraContext?: string,
  subjectContext?: string,
  /**
   * Пробросить «все модели перегружены» наверх, а не молча оставить
   * цитату первого захода. Сбор 22.10: редактор дважды пропущен с
   * ожиданием 196-240 с, и изюминки облегчённой модели ушли в резерв
   * без вычитки, хотя времени дождаться было больше десяти минут.
   */
  opts: {
    throwBusy?: boolean;
    /** люди, названные в тексте поста: с ними редактор смотрит и обычный пост */
    people?: string[];
  } = {},
): Promise<{ caption: GeneratedCaption; rewritten: boolean }> {
  // пустую цитату и штатное «место, год» без справки о предмете не
  // проверяем - экономим квоту: сделать из них изюминку не из чего.
  // Справка о предмете в кадре - ровно тот материал, которого не было у
  // первого захода, поэтому с ней редактор смотрит и обычный пост
  const plain = !generated.quote || isBarePlaceDate(generated.quote);
  const people = opts.people?.filter((p) => p.trim()) ?? [];
  if (plain && !subjectContext && !people.length) {
    return { caption: generated, rewritten: false };
  }
  try {
    const res = await geminiJson<Verdict>(
      [{ text: buildPrompt(item, generated, extraContext, subjectContext, people) }],
      { fullOnly: true },
    );
    // правка текста поста по правилу ЛЮДИ - со своими страховками
    const body = acceptBody(res.caption, generated.caption, item, [extraContext, subjectContext]);
    const bodyChanged = body !== undefined;
    if (body !== undefined) {
      console.log(`  текст поста поправлен (люди): «${generated.caption}» → «${body}»`);
      generated = { ...generated, caption: body };
    }
    if (res.verdict !== "weak") {
      return { caption: generated, rewritten: bodyChanged };
    }
    const quote = res.quote?.trim() ?? "";
    if (!quote) {
      // сильной замены не нашлось - цитата убирается, пост выходит коротким
      return { caption: { ...generated, quote: "" }, rewritten: true };
    }
    // замена - голые место и год, значит пост становится ОБЫЧНЫМ, и
    // цитата места должна остаться ОДНА. Если у изюминки уже стояла своя
    // строка места (quote_place), она точнее короткой замены («Район
    // Скарперии, Италия. 25 декабря 1944 года» против «Италия, 1944
    // год») и побеждает. Живой случай 07.09, карточка #308: буквальное
    // сравнение duplicatesPlace дубля не увидело, и в карточку уехали
    // ДВЕ цитаты места подряд
    if (isBarePlaceDate(quote)) {
      // обычный пост и так был обычным - менять нечего
      if (plain) return { caption: generated, rewritten: bodyChanged };
      const finalQuote =
        generated.quote_place && isBarePlaceDate(generated.quote_place)
          ? generated.quote_place
          : quote;
      // дата, уже стоящая в теле поста, дала бы дубль - тогда цитату убрать
      const years = finalQuote.match(/(18|19|20)\d{2}/g) ?? [];
      if (years.some((y) => generated.caption.includes(y))) {
        return { caption: { ...generated, quote: "", quote_place: undefined }, rewritten: true };
      }
      return {
        caption: { ...generated, quote: finalQuote, quote_place: undefined, quote_kind: "context" },
        rewritten: true,
      };
    }
    // обычный пост стал изюминкой: его «место и год» уходят второй
    // цитатой после факта - канон изюминки (quote_place)
    const placeAfter =
      generated.quote_place ?? (plain && generated.quote ? generated.quote : undefined);
    return {
      caption: {
        ...generated,
        quote,
        // если модель всё же переписала цитату в место и дату, которые уже
        // стоят отдельной строкой, - вторую строку убираем, дубль хуже
        quote_place: duplicatesPlace(quote, placeAfter) ? undefined : placeAfter,
        quote_kind: res.quote_kind === "observation" ? "observation" : "context",
      },
      rewritten: true,
    };
  } catch (err) {
    if (opts.throwBusy && err instanceof GeminiBusyError) throw err;
    console.warn(`  редактор цитаты пропущен: ${(err as Error).message}`);
    return { caption: generated, rewritten: false };
  }
}
