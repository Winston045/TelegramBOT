import type { AppConfig } from "../config.js";
import type { CursorStore } from "../cursors.js";
import type { RawItem, SourceAdapter } from "./types.js";
import { loc } from "./loc.js";
import { bundesarchiv } from "./bundesarchiv.js";
import { commons } from "./commons.js";
import { pastvu } from "./pastvu.js";
import { nara } from "./nara.js";
import { europeana } from "./europeana.js";

export const ADAPTERS: Record<string, SourceAdapter> = {
  loc,
  bundesarchiv, // прежнее имя: старые кандидаты в базе ссылаются на него
  commons,
  pastvu,
  nara,
  europeana,
};

export type CollectedItem = RawItem & { source: string };

/**
 * Пропорциональное перемешивание источников с сохранением порядка внутри
 * каждого. Без него партия «на анализ» резалась по порядку конфига:
 * первые keepLimit записей - целиком первый источник, а хвост (PastVu)
 * не доходил до анализа вообще, какой бы вес ему ни стоял.
 *
 * Каждой записи считаем «глубину» в своём источнике (доля от размера его
 * пула) и сортируем по ней: срез любой длины держит пропорции пулов.
 */
export function interleaveBySource<T extends { source: string }>(items: T[]): T[] {
  const poolSizes = new Map<string, number>();
  for (const it of items) poolSizes.set(it.source, (poolSizes.get(it.source) ?? 0) + 1);

  const poolIndex = new Map<string, number>();
  return items
    .map((item) => {
      const idx = poolIndex.get(item.source) ?? 0;
      poolIndex.set(item.source, idx + 1);
      const depth = (idx + 0.5) / (poolSizes.get(item.source) ?? 1);
      return { item, depth, idx };
    })
    .sort((a, b) => a.depth - b.depth || a.idx - b.idx || a.item.source.localeCompare(b.item.source))
    .map((r) => r.item);
}

/**
 * Тянет rawLimit записей из включённых источников пропорционально weight.
 * Упавший источник не роняет сбор целиком — пишем ошибку и едем дальше.
 */
/** Сколько записей дал каждый источник: {loc: 27, commons: 54, pastvu: 0}. */
export const lastSourceCounts: Record<string, number> = {};

export async function collectRaw(
  cfg: AppConfig,
  rawLimit: number,
  cursors: CursorStore,
  only?: string,
): Promise<CollectedItem[]> {
  const enabled = Object.entries(cfg.sources).filter(([name, s]) =>
    only ? name === only : s.enabled,
  );
  const totalWeight = enabled.reduce((sum, [, s]) => sum + s.weight, 0);
  if (totalWeight === 0) return [];

  const out: CollectedItem[] = [];
  for (const [name, sourceCfg] of enabled) {
    const adapter = ADAPTERS[name];
    if (!adapter) {
      console.warn(`нет адаптера для источника "${name}" — пропуск`);
      continue;
    }
    const share = Math.round((rawLimit * sourceCfg.weight) / totalWeight);
    try {
      const items = await adapter.fetch(share, sourceCfg, cursors);
      out.push(...items.map((item) => ({ ...item, source: name })));
      lastSourceCounts[name] = items.length;
      console.log(`${name}: получено ${items.length} (запрошено ${share})`);
    } catch (err) {
      lastSourceCounts[name] = -1; // источник упал, а не отдал пусто
      console.error(`${name}: сбор упал — ${(err as Error).message}`);
    }
  }
  return out;
}
