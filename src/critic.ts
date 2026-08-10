/**
 * Второй заход Gemini - редактор цитаты.
 *
 * Первый запрос делает всё сразу (оценка, теги, подпись). Цитата в канале -
 * изюминка: большинство постов выходят короткими, без неё. Этот проход
 * проверяет только поставленную цитату: слабую (пересказ, опись видимого,
 * протокол, прописная истина) либо заменяет действительно сильным фактом
 * из того же материала, либо убирает совсем - пост выходит коротким.
 * Ничего не выдумывает; пустую цитату не трогает (это норма формата).
 */
import type { AppConfig } from "./config.js";
import type { GeneratedCaption } from "./caption.js";
import { metadataBlock } from "./caption.js";
import type { RawItem } from "./sources/types.js";
import { geminiJson } from "./gemini.js";

type Verdict = {
  verdict: "ok" | "weak";
  quote?: string;
  quote_kind?: "observation" | "context";
};

function buildPrompt(item: RawItem, generated: GeneratedCaption, extraContext?: string): string {
  const placeLine = generated.quote_place
    ? `\nОтдельной строкой после цитаты уже стоит место и дата: ${generated.quote_place}`
    : "";
  return `Ты редактор телеграм-канала о военной истории. Проверь ТОЛЬКО цитату
под фотографией - блок, который идёт отдельной строкой после основного текста.

${metadataBlock(item, extraContext)}
Текст поста: ${generated.caption}
Цитата: ${generated.quote}${placeLine}

В этом канале у цитаты два законных вида:
- ОБЫЧНЫЙ пост: короткая цитата «место и год» («Австрия, 1946 год»,
  «Север СССР, 1941 год.») - это норма основной массы постов;
- ИЗЮМИНКА (каждый третий-четвёртый пост): по-настоящему стоящий факт -
  судьба людей или техники, поразительная цифра, редкая деталь, суть
  события, развёрнутая справка на два-четыре предложения. Аудитория
  канала разбирается в военной истории: базовые вещи (кто с кем воевал,
  когда шла война) она знает - изюминка должна давать больше.

Цитата ПЛОХАЯ, если это:
- пересказ текста поста другими словами;
- опись видимого («слева виден...», «на заднем плане...») без объяснения,
  чем это важно;
- технические сведения о негативе, съёмке или архиве;
- рассуждения общего характера без конкретики;
- прописная истина школьного учебника («Вторая мировая шла с 1939 по
  1945 год») - для аудитории канала это не новое знание;
- протокольное перечисление фамилий, должностей или состава делегаций
  без судьбы и смысла - суть события ценнее списка присутствовавших;
- повтор хотя бы одним предложением того, что уже сказано в тексте поста;
- средний, ничем не цепляющий псевдофакт, который притворяется изюминкой.

Если цитата хорошая (место-год ИЛИ настоящая изюминка) - верни
{"verdict": "ok"}.
Если плохая - верни "weak". При этом:
- если из метаданных и контекста можно собрать ДЕЙСТВИТЕЛЬНО сильную
  замену - положи её в "quote" (материал СТРОГО из данных выше, ничего
  не выдумывать, не повторять текст поста и отдельную строку места и
  даты, если она стоит);
- если сильной замены нет - положи в "quote" место и год короткой
  строкой («СССР, 1943 год.») - обычный формат канала; убедись, что
  дата не дублируется в тексте поста.
Правила текста: простой текст без HTML и markdown, длинное тире не
использовать - только обычный дефис.

Верни строго JSON без обёрток:
{"verdict": "ok" | "weak", "quote": "...", "quote_kind": "observation" | "context"}`;
}

/**
 * Голые место и дата («Италия, 1943 год.») - штатная цитата обычного
 * поста: проверять её редактором незачем, запрос квоты не тратим.
 */
export function isBarePlaceDate(text: string): boolean {
  const t = text.trim();
  if (t.length === 0 || t.length > 60) return false;
  if (!/(18|19|20)\d{2}/.test(t)) return false;
  const sentences = t.split(/\.\s+/).filter(Boolean);
  return sentences.length <= 2;
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
): Promise<{ caption: GeneratedCaption; rewritten: boolean }> {
  // пустую цитату и штатное «место, год» не проверяем - экономим квоту:
  // редактору есть смысл смотреть только на цитаты с претензией на факт
  if (!generated.quote || isBarePlaceDate(generated.quote)) {
    return { caption: generated, rewritten: false };
  }
  try {
    const res = await geminiJson<Verdict>([
      { text: buildPrompt(item, generated, extraContext) },
    ]);
    if (res.verdict !== "weak") {
      return { caption: generated, rewritten: false };
    }
    const quote = res.quote?.trim() ?? "";
    if (!quote) {
      // сильной замены не нашлось - цитата убирается, пост выходит коротким
      return { caption: { ...generated, quote: "" }, rewritten: true };
    }
    // замена «место, год» при дате, уже стоящей в теле поста (изюминка
    // с датой в caption), дала бы дубль - тогда цитату лучше убрать
    if (isBarePlaceDate(quote)) {
      const years = quote.match(/(18|19|20)\d{2}/g) ?? [];
      if (years.some((y) => generated.caption.includes(y))) {
        return { caption: { ...generated, quote: "" }, rewritten: true };
      }
    }
    return {
      caption: {
        ...generated,
        quote,
        // если модель всё же переписала цитату в место и дату, которые уже
        // стоят отдельной строкой, - вторую строку убираем, дубль хуже
        quote_place: duplicatesPlace(quote, generated.quote_place)
          ? undefined
          : generated.quote_place,
        quote_kind: res.quote_kind === "observation" ? "observation" : "context",
      },
      rewritten: true,
    };
  } catch (err) {
    console.warn(`  редактор цитаты пропущен: ${(err as Error).message}`);
    return { caption: generated, rewritten: false };
  }
}
