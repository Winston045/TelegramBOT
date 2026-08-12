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

import { archiveKey } from "./plan.js";

export type Taggable = {
  tags: { subject?: string; region?: string; period?: string } | null;
  /** Архив-поставщик: партия не должна быть витриной одного архива. */
  attribution?: string | null;
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
  const periodCounts = new Map<string, number>();
  const archiveCounts = new Map<string, number>();
  const maxPerRegion = Math.max(2, Math.ceil(limit / 3));
  // архивы отдают неравномерно, и партия легко выходит из одного:
  // «одни немцы» сменялись «одними британцами»
  const maxPerArchive = Math.max(2, Math.ceil(limit / 3));
  // эпохи тоже мешаем: партия из одной ПМВ - скука, даже если темы разные
  const maxPerPeriod = Math.max(1, Math.ceil(limit / 2));

  for (const item of ordered) {
    if (picked.length >= limit) break;
    const subject = item.tags?.subject;
    if (subject) {
      const used = counts.get(subject) ?? 0;
      if (used >= maxPerTag) continue;
    }
    const region = item.tags?.region;
    if (region && (regionCounts.get(region) ?? 0) >= maxPerRegion) continue;
    const period = item.tags?.period;
    if (period && (periodCounts.get(period) ?? 0) >= maxPerPeriod) continue;
    const archive = archiveKey(item.attribution);
    if (archive && (archiveCounts.get(archive) ?? 0) >= maxPerArchive) continue;

    if (archive) archiveCounts.set(archive, (archiveCounts.get(archive) ?? 0) + 1);
    if (region) regionCounts.set(region, (regionCounts.get(region) ?? 0) + 1);
    if (period) periodCounts.set(period, (periodCounts.get(period) ?? 0) + 1);
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
