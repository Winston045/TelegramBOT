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
