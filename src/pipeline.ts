/**
 * Доводка подписи после анализа - ОДИН конвейер для сбора и предпросмотра.
 *
 * Раньше шаги жили копиями в scripts/collect.ts и scripts/caption-preview.ts,
 * и предпросмотр мог показать не то, что потом уйдёт в канал: справка о
 * людях и правка текста поста попали в сбор раньше, чем в предпросмотр.
 * Теперь порядок один:
 * 1. справки из Википедии: о предмете (технике, человеке) и о событии;
 * 2. редактор цитаты (critic.ts) - видит обе справки и людей в тексте;
 * 3. страховки по очереди: числа из источников, копия примера, штампы;
 * 4. проверка рубрики;
 * 5. валидатор, а при браке года в изюминке - пост без изюминки.
 */
import type { AppConfig } from "./config.js";
import type { Analysis } from "./analyze.js";
import { assembleCaptionHtml, descriptiveSentences, type GeneratedCaption } from "./caption.js";
import { reviewQuote } from "./critic.js";
import { guardCliches, guardCopies, guardNumbers, withoutQuote, type NumbersVerdict } from "./factcheck.js";
import { rubricCaptionFlaw, type Rubric } from "./rubrics.js";
import type { RawItem } from "./sources/types.js";
import { validateCaption, type ValidationResult } from "./validate.js";
import { eventReference, subjectReference } from "./wiki.js";

export type Reviewed = { caption: GeneratedCaption; rewritten: boolean };

export type FinishOptions = {
  item: RawItem & { source?: string };
  cfg: AppConfig;
  analysis: Analysis;
  /** описание с карточки архива и справка о событии из категорий Commons */
  extraContext?: string;
  rubric?: Rubric;
  /** false - на исходе бюджета: без справок и редактора, как есть */
  full: boolean;
  /**
   * Как звать редактора. Сбор оборачивает вызов ожиданием занятых
   * моделей (reviewWithWait), предпросмотр зовёт напрямую.
   */
  review: (call: () => Promise<Reviewed>, generated: GeneratedCaption) => Promise<Reviewed>;
  log: (message: string) => void;
};

export type FinishResult = {
  caption: GeneratedCaption;
  html: string;
  check: ValidationResult;
  rewritten: boolean;
  /** кадр рубрики не дотянул до рубрики - в резерв не идёт */
  rubricFlaw?: string;
  /** сколько предложений в теле (норма - одно) */
  sentences: number;
  references: { subject?: string; event?: string };
};

/** Справки к кадру: о предмете и о событии; одна статья дважды не нужна. */
export async function fetchReferences(
  analysis: Pick<Analysis, "subject_wiki" | "event_wiki">,
): Promise<{ subject?: string; event?: string }> {
  const subject = analysis.subject_wiki ? await subjectReference(analysis.subject_wiki) : undefined;
  const sameArticle =
    analysis.event_wiki &&
    analysis.subject_wiki &&
    analysis.event_wiki.trim().toLowerCase() === analysis.subject_wiki.trim().toLowerCase();
  const event = analysis.event_wiki && !sameArticle ? await eventReference(analysis.event_wiki) : undefined;
  return { subject, event };
}

export async function finishCaption(o: FinishOptions): Promise<FinishResult> {
  const { item, cfg, analysis: a, extraContext, rubric, log } = o;
  const tag = `[${item.source ?? "?"}] ${item.sourceId}`;

  const references = o.full ? await fetchReferences(a) : {};
  if (references.subject) log(`  справка о предмете: «${a.subject_wiki}» ${tag}`);
  if (references.event) log(`  справка о событии: «${a.event_wiki}» ${tag}`);
  // для редактора и проверок справки - одно поле контекста
  const refs = [references.subject, references.event].filter(Boolean).join("\n\n") || undefined;

  const reviewed: Reviewed = o.full
    ? await o.review(
        () => reviewQuote(item, cfg, a, extraContext, refs, { throwBusy: true, people: a.people }),
        a,
      )
    : { caption: a, rewritten: false };
  if (reviewed.rewritten) log(`  цитата переписана редактором: ${tag}`);

  // числа изюминки должны быть в источниках (src/factcheck.ts)
  const sources = [item.title, item.description, item.place, extraContext, refs].filter(Boolean).join("\n");
  // страховки по очереди: каждая видит итог предыдущей
  const guards: Array<(r: Reviewed) => NumbersVerdict> = [
    (r) => guardNumbers(r, a, sources),
    (r) => guardCopies(r, a),
    (r) => guardCliches(r, a),
  ];
  for (const guard of guards) {
    const check = guard(reviewed);
    if (check.outcome === "ok") continue;
    const what = check.outcome === "editor_rejected" ? "правка редактора отклонена" : "изюминка снята";
    log(`  ${check.bad.join(", ")} - ${what}: ${tag}`);
    reviewed.caption = check.caption;
  }

  // кадр рубрики обязан быть видимо рубрикой: повседневность - только
  // изюминкой, плакат - названным плакатом
  const rubricFlaw = rubric ? rubricCaptionFlaw(rubric, reviewed.caption) : undefined;
  const sentences = descriptiveSentences(reviewed.caption.caption);

  let html = assembleCaptionHtml(reviewed.caption, item, cfg.channel);
  // контекст (описание с карточки, справки) - легальный источник фактов,
  // его годы валидатор тоже должен знать
  const context = [extraContext, refs].filter(Boolean).join("\n");
  const meta = { ...item, context: context || undefined };
  let check = validateCaption(html, meta);
  // год не из источников в изюминке - снимаем изюминку, а не весь кадр
  if (!check.ok && !rubricFlaw) {
    for (const alt of withoutQuote(reviewed.caption)) {
      if (rubric && rubricCaptionFlaw(rubric, alt)) break;
      const altHtml = assembleCaptionHtml(alt, item, cfg.channel);
      if (!validateCaption(altHtml, meta).ok) continue;
      log(`  ${check.reason} - изюминка снята: ${tag}`);
      reviewed.caption = alt;
      html = altHtml;
      check = { ok: true };
      break;
    }
  }

  return {
    caption: reviewed.caption,
    html,
    check,
    rewritten: reviewed.rewritten,
    rubricFlaw,
    sentences,
    references,
  };
}
