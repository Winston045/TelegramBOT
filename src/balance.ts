/**
 * Балансир по тегам: не долбить одну тему.
 * Кандидаты идут в порядке убывания score; тема (tags.subject), которая
 * за последнюю неделю уже показывалась maxPerTag раз, пропускается.
 */

export type Taggable = {
  tags: { subject?: string } | null;
};

export function pickBalanced<T extends Taggable>(
  ordered: T[],
  recentSubjectCounts: Map<string, number>,
  limit: number,
  maxPerTag: number,
): T[] {
  const picked: T[] = [];
  const counts = new Map(recentSubjectCounts);

  for (const item of ordered) {
    if (picked.length >= limit) break;
    const subject = item.tags?.subject;
    if (subject) {
      const used = counts.get(subject) ?? 0;
      if (used >= maxPerTag) continue;
      counts.set(subject, used + 1);
    }
    picked.push(item);
  }
  return picked;
}
