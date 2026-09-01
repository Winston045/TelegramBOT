/**
 * Очередь анализа - последний рубеж перед тратой квоты Gemini: тридцать
 * слотов, и каждый стоит 1-2 запроса. Перемешивание по архивам делает
 * очередь представительной, но не защищает от двух бед (живой прогон
 * 31.08):
 *
 * - дубли названий: «Citation winners in the war production drive» занял
 *   ТРИ слота - дедуп по картинке ловит такое только после скачивания,
 *   когда слот уже потрачен;
 * - монокультура: ВМВ - ядро каждого архива, и резерв стал сплошной ВМВ
 *   (план публикаций 31.08 - десять постов ВМВ подряд). Планировщик
 *   чередует только то, что есть в резерве: лечить надо здесь, до анализа.
 *
 * Потолки МЯГКИЕ: если другого материала не хватило, свободные слоты
 * добираются придержанными кадрами - неполная очередь хуже перекошенной.
 */
import type { RawItem } from "./sources/types.js";
import { archiveKey } from "./plan.js";

/** Доля очереди, больше которой один архив не занимает (LOC брал 7 из 30). */
export const MAX_ARCHIVE_SHARE = 1 / 6;
/** Доля очереди для кадров ВМВ: половина - как мягкая доля эпохи в ленте. */
export const MAX_WW2_SHARE = 1 / 2;

/** Годы, по которым кадр до анализа считается ВМВ (тег эпохи ставит Gemini позже). */
const WW2_FROM = 1939;
const WW2_TO = 1945;

export type QueueCuts = {
  /** повторы названия: выброшены совсем, слот им не достанется */
  duplicates: number;
  /** придержаны потолком архива (могут вернуться добором) */
  archiveCapped: number;
  /** придержаны потолком ВМВ (могут вернуться добором) */
  ww2Capped: number;
};

function titleKey(title?: string): string {
  return (title ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function isWw2(item: RawItem): boolean {
  return item.year !== undefined && item.year >= WW2_FROM && item.year <= WW2_TO;
}

/**
 * Собирает очередь анализа из перемешанного списка: порядок кандидатов
 * сохраняется, дубли названий выбрасываются, потолки архива и ВМВ
 * придерживают лишнее - с добором, если очередь не заполнилась.
 */
export function buildAnalysisQueue<T extends RawItem & { source: string }>(
  items: T[],
  limit: number,
): { queue: T[]; cuts: QueueCuts } {
  const cuts: QueueCuts = { duplicates: 0, archiveCapped: 0, ww2Capped: 0 };
  const archiveCap = Math.max(2, Math.ceil(limit * MAX_ARCHIVE_SHARE));
  const ww2Cap = Math.max(2, Math.ceil(limit * MAX_WW2_SHARE));

  const seenTitles = new Set<string>();
  const byArchive = new Map<string, number>();
  let ww2 = 0;
  const queue: T[] = [];
  const held: T[] = [];

  for (const item of items) {
    if (queue.length >= limit) break;
    const t = titleKey(item.title);
    if (t) {
      if (seenTitles.has(t)) {
        cuts.duplicates++;
        continue;
      }
      seenTitles.add(t);
    }
    const archive = archiveKey(item.attribution) || item.source;
    if ((byArchive.get(archive) ?? 0) >= archiveCap) {
      cuts.archiveCapped++;
      held.push(item);
      continue;
    }
    if (isWw2(item) && ww2 >= ww2Cap) {
      cuts.ww2Capped++;
      held.push(item);
      continue;
    }
    byArchive.set(archive, (byArchive.get(archive) ?? 0) + 1);
    if (isWw2(item)) ww2++;
    queue.push(item);
  }

  // добор: материала других эпох и архивов не хватило - лучше заполнить
  // очередь придержанными, чем жечь день на неполной партии
  for (const item of held) {
    if (queue.length >= limit) break;
    queue.push(item);
  }

  return { queue, cuts };
}
