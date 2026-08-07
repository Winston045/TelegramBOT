/**
 * Второй заход Gemini - редактор цитаты.
 *
 * Первый запрос делает всё сразу (оценка, теги, подпись), и цитата иногда
 * выходит пустышкой: пересказ подписи другими словами или опись видимого.
 * Этот проход смотрит только на цитату и, если она пустая, переписывает -
 * либо развёрнутой справкой из имеющегося материала, либо честным
 * «место и дата». Ничего не выдумывает: источник фактов тот же.
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

В этом канале цитата - ИЗЮМИНКА: основная масса постов выходит короткими,
вообще без цитаты, и это норма. Раз цитата стоит - она обязана быть
сильной. Аудитория канала разбирается в военной истории: базовые вещи
(кто с кем воевал, когда шла война) она знает.
Цитата хорошая, если знающий читатель узнал из неё что-то по-настоящему
стоящее: судьба людей или техники, поразительная цифра, редкая деталь,
суть события, развёрнутая справка на два-четыре предложения.

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
- место и дата, которые уже стоят в тексте поста;
- средний, ничем не цепляющий факт - для изюминки этого мало.

Если цитата хорошая - верни {"verdict": "ok"}.
Если плохая - верни "weak". При этом:
- если из метаданных и контекста можно собрать ДЕЙСТВИТЕЛЬНО сильную
  замену - положи её в "quote" (материал СТРОГО из данных выше, ничего
  не выдумывать, не повторять текст поста и отдельную строку места и
  даты, если она стоит);
- если сильной замены нет - верни "quote" ПУСТОЙ строкой: цитата
  уберётся, пост выйдет коротким, для канала это норма.
Правила текста: простой текст без HTML и markdown, длинное тире не
использовать - только обычный дефис.

Верни строго JSON без обёрток:
{"verdict": "ok" | "weak", "quote": "...", "quote_kind": "observation" | "context"}`;
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
  if (!generated.quote) return { caption: generated, rewritten: false };
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
