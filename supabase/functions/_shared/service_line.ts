/**
 * Служебная строка в карточке кандидата у редакторов.
 * По ней же вебхук находит кандидата, на которого ответили /ok.
 */

export function buildServiceLine(
  c: {
    id: number;
    source: string;
    quote_kind: string | null;
  },
  /** название рубрики вне ядра - редактор сразу видит, что это не война */
  rubricTitle?: string,
): string {
  const rubric = rubricTitle ? ` · рубрика: ${rubricTitle}` : "";
  return `<i>#${c.id} · ${c.source} · ${c.quote_kind ?? "-"}${rubric}</i>`;
}

/** Достаёт id кандидата из текста/подписи карточки ("#123 · loc · …"). */
export function parseCandidateId(text: string | undefined): number | undefined {
  const m = text?.match(/#(\d+) · /);
  return m ? Number(m[1]) : undefined;
}
