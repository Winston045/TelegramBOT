/**
 * Страховка изюминки от выдуманных чисел - общая для сбора и
 * предпросмотра, чтобы предпросмотр показывал ровно то, что уйдёт в базу.
 */
import { FEW_SHOT, type GeneratedCaption } from "./caption.js";
import { unsupportedNumbers } from "./validate.js";

export type NumbersVerdict = {
  caption: GeneratedCaption;
  /** что случилось: ok, правка редактора отклонена или изюминка снята */
  outcome: "ok" | "editor_rejected" | "quote_dropped";
  /** числа, которых нет в источниках */
  bad: string[];
};

/**
 * Числа изюминки должны быть в источниках. Не прошла правка редактора -
 * берём версию первого захода; не прошла и она - пост обычный, с местом
 * и годом: лучше без изюминки, чем с выдумкой.
 */
export function guardNumbers(
  reviewed: { caption: GeneratedCaption; rewritten: boolean },
  firstPass: GeneratedCaption,
  sources: string,
): NumbersVerdict {
  const bad = unsupportedNumbers(reviewed.caption.quote, sources);
  if (!bad.length) return { caption: reviewed.caption, outcome: "ok", bad };
  if (reviewed.rewritten && !unsupportedNumbers(firstPass.quote, sources).length) {
    return { caption: firstPass, outcome: "editor_rejected", bad };
  }
  return {
    caption: {
      ...reviewed.caption,
      quote: reviewed.caption.quote_place ?? "",
      quote_place: undefined,
      quote_kind: "context",
    },
    outcome: "quote_dropped",
    bad,
  };
}

/** Слова без пунктуации и регистра - для сравнения текстов по смыслу фраз. */
function words(text: string): string[] {
  return text.toLowerCase().replace(/ё/g, "е").split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

function shingles(text: string, n = 5): Set<string> {
  const w = words(text);
  const out = new Set<string>();
  for (let i = 0; i + n <= w.length; i++) out.add(w.slice(i, i + n).join(" "));
  return out;
}

/** Цитаты примеров из промпта - образец подачи, не источник. */
const EXAMPLE_QUOTES: Set<string>[] = FEW_SHOT.split("\n")
  .filter((l) => l.startsWith("quote: "))
  .map((l) => shingles(l.slice("quote: ".length)));

/**
 * Списана ли цитата с примера из промпта. Предпросмотр 22.10: облегчённая
 * модель вопреки прямому запрету почти дословно переписала пример про
 * «Кэмпбелтаун» в подпись того же кадра. Три общие пятёрки слов подряд -
 * это уже не совпадение формулировки, а копия.
 */
export function copiesExample(quote: string): boolean {
  const mine = shingles(quote);
  if (!mine.size) return false;
  return EXAMPLE_QUOTES.some((ex) => {
    let shared = 0;
    for (const s of mine) if (ex.has(s)) shared++;
    return shared >= 3;
  });
}

/**
 * Страховка от копии примера: правка редактора - копия, а первый заход
 * нет - берём первый заход; копия и он - пост обычный, с местом и годом.
 */
export function guardCopies(
  reviewed: { caption: GeneratedCaption; rewritten: boolean },
  firstPass: GeneratedCaption,
): NumbersVerdict {
  if (!copiesExample(reviewed.caption.quote)) return { caption: reviewed.caption, outcome: "ok", bad: [] };
  if (reviewed.rewritten && !copiesExample(firstPass.quote)) {
    return { caption: firstPass, outcome: "editor_rejected", bad: ["копия примера"] };
  }
  return {
    caption: {
      ...reviewed.caption,
      quote: reviewed.caption.quote_place ?? "",
      quote_place: undefined,
      quote_kind: "context",
    },
    outcome: "quote_dropped",
    bad: ["копия примера"],
  };
}
