/**
 * Балансир партии карточек: ШАХМАТНЫЙ порядок по архивам.
 *
 * Главное правило (решение редакции 11.08): в одной партии каждая
 * карточка - из своего архива. Раньше ограничение было долевым («не
 * больше трети из одного»), и при партии в две-три карточки это
 * означало «можно всё из одного» - лента шла сплошными немцами.
 *
 * Кандидаты приходят по убыванию ранга. Сначала обходим архивы по кругу,
 * беря лучшего из каждого: получается партия из разных архивов, внутри
 * каждого - лучший кадр. Дополнительно держим прежние ограничения по
 * теме недели, региону и эпохе.
 *
 * Все ограничения мягкие: если разных архивов меньше, чем нужно карточек,
 * добираем лучшими оставшимися. Пустой чат хуже повтора.
 */

import { archiveKey } from "./plan.js";

export type Taggable = {
  tags: { subject?: string; region?: string; period?: string } | null;
  /** Архив-поставщик: партия не должна быть витриной одного архива. */
  attribution?: string | null;
  /** Запасной ключ чередования для кандидатов без архива. */
  source?: string | null;
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
  const maxPerRegion = Math.max(2, Math.ceil(limit / 3));
  // эпохи тоже мешаем: партия из одной ПМВ - скука, даже если темы разные
  const maxPerPeriod = Math.max(1, Math.ceil(limit / 2));

  // очереди по архивам, внутри каждой - порядок ранга
  const queues = new Map<string, T[]>();
  for (const item of ordered) {
    const key = archiveKey(item.attribution) || item.source || "(без архива)";
    const q = queues.get(key);
    if (q) q.push(item);
    else queues.set(key, [item]);
  }

  const fits = (item: T): boolean => {
    const subject = item.tags?.subject;
    if (subject && (counts.get(subject) ?? 0) >= maxPerTag) return false;
    const region = item.tags?.region;
    if (region && (regionCounts.get(region) ?? 0) >= maxPerRegion) return false;
    const period = item.tags?.period;
    if (period && (periodCounts.get(period) ?? 0) >= maxPerPeriod) return false;
    return true;
  };

  const take = (item: T) => {
    const subject = item.tags?.subject;
    const region = item.tags?.region;
    const period = item.tags?.period;
    if (subject) counts.set(subject, (counts.get(subject) ?? 0) + 1);
    if (region) regionCounts.set(region, (regionCounts.get(region) ?? 0) + 1);
    if (period) periodCounts.set(period, (periodCounts.get(period) ?? 0) + 1);
    picked.push(item);
    chosen.add(item);
  };

  // круг за кругом: по одной карточке с каждого архива. Первый круг и
  // даёт шахматку - столько разных архивов, сколько карточек в партии
  const keys = [...queues.keys()];
  while (picked.length < limit) {
    let tookAny = false;
    for (const key of keys) {
      if (picked.length >= limit) break;
      const queue = queues.get(key);
      if (!queue?.length) continue;
      // из очереди архива берём первого подходящего по теме/региону/эпохе
      const idx = queue.findIndex(fits);
      if (idx === -1) continue;
      const [item] = queue.splice(idx, 1);
      if (!item) continue;
      take(item);
      tookAny = true;
    }
    if (!tookAny) break; // все очереди исчерпаны или всё под ограничениями
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
