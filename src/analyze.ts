/**
 * Объединённый анализ снимка: оценка + теги + готовая подпись ОДНИМ
 * запросом к Gemini. Раньше на карточку уходило два запроса (скоринг,
 * потом подпись) — при дневной квоте бесплатного тарифа это роскошь.
 * Бонус: подпись есть у каждого оценённого фото, хорошие кандидаты
 * копятся в резерв, и /more может слать их вообще без Gemini.
 */
import type { AppConfig } from "./config.js";
import type { RawItem } from "./sources/types.js";
import { geminiJson, imagePart } from "./gemini.js";
import { FEW_SHOT, captionRules, metadataBlock } from "./caption.js";
import { SCORE_FIELDS_SCHEMA, SCORING_CRITERIA } from "./scoring.js";
import type { GeneratedCaption } from "./caption.js";
import type { VisionScore } from "./scoring.js";

export type Analysis = VisionScore & GeneratedCaption;

export function buildAnalysisPrompt(
  item: RawItem,
  glossary: Record<string, string>,
  extraContext?: string,
): string {
  return `Ты отбираешь исторические фотографии для русскоязычного телеграм-канала
о ВОЕННОЙ ИСТОРИИ (Первая мировая, Вторая мировая, холодная война) и
готовишь к ним подписи. Сделай обе задачи за один раз.

${metadataBlock(item, extraContext)}
${SCORING_CRITERIA}

${captionRules(glossary)}

${FEW_SHOT}

Верни строго JSON без обёрток и без markdown:
{${SCORE_FIELDS_SCHEMA}, "caption": "...", "quote": "<обычный пост: место и год короткой строкой; изюминка: факт-справка>", "quote_place": "<место и дата отдельной строкой - только у изюминки, иначе пустая строка>", "quote_kind": "observation" | "context"}`;
}

export async function analyzeImage(
  item: RawItem,
  cfg: AppConfig,
  image: Buffer,
  extraContext?: string,
): Promise<Analysis> {
  const img = await imagePart(image);
  const result = await geminiJson<Analysis>([
    { text: buildAnalysisPrompt(item, cfg.glossary, extraContext) },
    img,
  ]);
  return {
    score: Math.max(0, Math.min(100, Math.round(result.score ?? 0))),
    score_why: result.score_why?.trim().slice(0, 120) || undefined,
    tags: result.tags ?? {},
    unsafe: Boolean(result.unsafe),
    caption: result.caption ?? "",
    quote: result.quote ?? "",
    quote_place: result.quote_place?.trim() || undefined,
    quote_kind: result.quote_kind === "observation" ? "observation" : "context",
  };
}
