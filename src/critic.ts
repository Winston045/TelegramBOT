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
  return `Ты редактор телеграм-канала о военной истории. Проверь ТОЛЬКО цитату
под фотографией - блок, который идёт отдельной строкой после основного текста.

${metadataBlock(item, extraContext)}
Текст поста: ${generated.caption}
Цитата: ${generated.quote}

Цитата считается хорошей, если это:
- по-настоящему интересный факт: судьба людей или техники, цифры, контекст
  события, редкость момента, развёрнутая справка на два-четыре предложения;
- ИЛИ честное «место и дата»: «СССР, 1943 год.», «Воронежский фронт. Февраль 1943 года.»

Цитата ПЛОХАЯ, если это:
- пересказ текста поста другими словами;
- опись видимого («слева виден...», «на заднем плане...») без объяснения,
  чем это важно;
- технические сведения о негативе, съёмке или архиве;
- рассуждения общего характера без конкретики.

Если цитата хорошая - верни {"verdict": "ok"}.
Если плохая - перепиши. Материал бери СТРОГО из метаданных и контекста выше,
ничего не выдумывай. Когда фактов на справку не хватает - сделай цитатой
место и дату (и тогда убедись, что дата не дублируется в тексте поста).
Правила текста: простой текст без HTML и markdown, длинное тире не
использовать - только обычный дефис.

Верни строго JSON без обёрток:
{"verdict": "ok" | "weak", "quote": "...", "quote_kind": "observation" | "context"}`;
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
    if (res.verdict !== "weak" || !res.quote?.trim()) {
      return { caption: generated, rewritten: false };
    }
    return {
      caption: {
        ...generated,
        quote: res.quote.trim(),
        quote_kind: res.quote_kind === "observation" ? "observation" : "context",
      },
      rewritten: true,
    };
  } catch (err) {
    console.warn(`  редактор цитаты пропущен: ${(err as Error).message}`);
    return { caption: generated, rewritten: false };
  }
}
