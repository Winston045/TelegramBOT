/**
 * Балансир по тегам: не долбить одну тему и одну страну.
 * Кандидаты идут в порядке убывания score. Тема (tags.subject), которая
 * за последнюю неделю уже показывалась maxPerTag раз, пропускается.
 * Регион (tags.region) ограничен внутри партии: не больше ~трети карточек
 * одной страны/региона — живой прогон дал партию наполовину из США.
 */

export type Taggable = {
  tags: { subject?: string; region?: string } | null;
};

export function pickBalanced<T extends Taggable>(
  ordered: T[],
  recentSubjectCounts: Map<string, number>,
  limit: number,
  maxPerTag: number,
): T[] {
  const picked: T[] = [];
  const counts = new Map(recentSubjectCounts);
  const regionCounts = new Map<string, number>();
  const maxPerRegion = Math.max(2, Math.ceil(limit / 3));

  for (const item of ordered) {
    if (picked.length >= limit) break;
    const subject = item.tags?.subject;
    if (subject) {
      const used = counts.get(subject) ?? 0;
      if (used >= maxPerTag) continue;
    }
    const region = item.tags?.region;
    if (region) {
      const used = regionCounts.get(region) ?? 0;
      if (used >= maxPerRegion) continue;
      regionCounts.set(region, used + 1);
    }
    if (subject) counts.set(subject, (counts.get(subject) ?? 0) + 1);
    picked.push(item);
  }
  return picked;
}
