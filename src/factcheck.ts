/**
 * Страховка изюминки от выдуманных чисел - общая для сбора и
 * предпросмотра, чтобы предпросмотр показывал ровно то, что уйдёт в базу.
 */
import type { GeneratedCaption } from "./caption.js";
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
