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
import { rubricOf } from "./rubrics.js";

export type Analysis = VisionScore &
  GeneratedCaption & {
    /**
     * Английское название статьи Википедии о главном предмете кадра
     * («Observation balloon», «HMS Campbeltown (I42)»). По нему сборщик
     * достаёт справку, и редактор цитат строит изюминку о самом предмете,
     * а не о событии вокруг.
     */
    subject_wiki?: string;
    /**
     * Люди, названные в тексте поста по имени. По нему редактор цитат
     * проверяет, объяснено ли читателю, кто это (правило 10 подписи).
     */
    people?: string[];
  };

export function buildAnalysisPrompt(
  item: RawItem,
  glossary: Record<string, string>,
  extraContext?: string,
): string {
  // кадр рубрики судится по её правилам: без этого модель честно ставила
  // бы плакату и современной съёмке «0-24, не по теме канала»
  const rubric = rubricOf(item.rubric);
  const rubricBlock = rubric
    ? `\n${rubric.brief}\nЭти правила рубрики ВАЖНЕЕ общих критериев ниже там, где они расходятся.\n`
    : "";
  return `Ты отбираешь исторические фотографии для русскоязычного телеграм-канала
о ВОЕННОЙ ИСТОРИИ (Первая мировая, Вторая мировая, холодная война) и
готовишь к ним подписи. Сделай обе задачи за один раз.
Основа канала - война, но редкой краской выходят ЗНАКОВЫЕ МИРНЫЕ СОБЫТИЯ
эпохи: первые полёты и космос, великие катастрофы и стройки, экспедиции.
Такой кадр - по теме: оценивай его по общим критериям (military: false).

${metadataBlock(item, extraContext)}${rubricBlock}
${SCORING_CRITERIA}

${captionRules(glossary)}

${FEW_SHOT}

subject_wiki - точное название статьи АНГЛИЙСКОЙ Википедии о ГЛАВНОМ
ПРЕДМЕТЕ кадра, про который интересно рассказать: тип техники, корабль,
самолёт, оружие, явление («Observation balloon», «Tiger I», «HMS
Campbeltown (I42)», «Higgins boat»). Только если предмет назван в
метаданных или однозначно узнаётся; общие сцены (солдаты, улица,
построение) и сомнения - пустая строка. По этому названию редакция
достанет справку: выдуманное название даст чужую статью.
Если главное в кадре - человек, названный в метаданных (генерал,
лётчик, артист), subject_wiki - статья о нём («George S. Patton»):
по ней редакция объяснит читателю, кто это и чем он интересен.

people - имена людей, которых ты назвал в caption (как написано в
caption: «Джордж Паттон»); никого не назвал - пустой список.

Верни строго JSON без обёрток и без markdown:
{${SCORE_FIELDS_SCHEMA}, "subject_wiki": "<название статьи или пустая строка>", "people": ["<имя из caption>"], "caption": "...", "quote": "<обычный пост: место и год короткой строкой; изюминка: факт-справка>", "quote_place": "<у изюминки место и дата ВСЕГДА здесь - отдельной второй цитатой после факта; у обычного поста пустая строка>", "quote_kind": "observation" | "context"}`;
}

export async function analyzeImage(
  item: RawItem,
  cfg: AppConfig,
  image: Buffer,
  extraContext?: string,
  /** только полноценные модели - для второго мнения по отказам */
  opts: { fullOnly?: boolean } = {},
): Promise<Analysis> {
  const img = await imagePart(image);
  const result = await geminiJson<Analysis>(
    [{ text: buildAnalysisPrompt(item, cfg.glossary, extraContext) }, img],
    { fullOnly: opts.fullOnly },
  );
  // слабая модель может вернуть «"score": "high"» или забыть подпись: NaN
  // проходил порог оценки (NaN < 40 - ложь), а пустая подпись давала
  // пост из одной цитаты и ссылки. Такой ответ - брак, а не кандидат
  const score = Number(result.score);
  if (!Number.isFinite(score)) {
    throw new Error(`gemini: оценка не число (${JSON.stringify(result.score)})`);
  }
  if (!result.caption?.trim()) throw new Error("gemini: нет подписи в ответе");
  return {
    score: Math.max(0, Math.min(100, Math.round(score))),
    score_why: result.score_why?.trim().slice(0, 120) || undefined,
    tags: result.tags ?? {},
    unsafe: Boolean(result.unsafe),
    caption: result.caption ?? "",
    quote: result.quote ?? "",
    quote_place: result.quote_place?.trim() || undefined,
    quote_kind: result.quote_kind === "observation" ? "observation" : "context",
    subject_wiki: typeof result.subject_wiki === "string" ? result.subject_wiki.trim().slice(0, 120) || undefined : undefined,
    people: Array.isArray(result.people)
      ? result.people.filter((p): p is string => typeof p === "string" && p.trim().length > 0).slice(0, 6)
      : undefined,
  };
}
