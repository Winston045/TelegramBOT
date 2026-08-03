/**
 * Балансир по тегам: не долбить одну тему и одну страну.
 * Кандидаты идут в порядке убывания score. Тема (tags.subject), которая
 * за последнюю неделю уже показывалась maxPerTag раз, пропускается.
 * Регион (tags.region) ограничен внутри партии: не больше ~трети карточек
 * одной страны/региона — живой прогон дал партию наполовину из США.
 *
 * Ограничения мягкие: если под них не подошло ничего, партия всё равно
 * набирается по порядку оценки. Пустой чат хуже повтора темы.
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
  const chosen = new Set<T>();
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
    chosen.add(item);
  }

  // ограничения - предпочтение, а не запрет. Живой прогон 03.08: за неделю
  // накопились показы по всем темам партии, балансир отсеял все девять
  // кандидатов, и /more молча не прислал ничего. Лучше показать повтор
  // темы, чем оставить редактора с пустым чатом.
  if (picked.length < limit) {
    for (const item of ordered) {
      if (picked.length >= limit) break;
      if (chosen.has(item)) continue;
      picked.push(item);
      chosen.add(item);
    }
  }
  return picked;
}
