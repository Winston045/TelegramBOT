import type { AppConfig } from "./config.js";
import type { RawItem } from "./sources/types.js";

export type RejectReason =
  | "no_year"
  | "no_place"
  | "year_out_of_range"
  | "too_small"
  | "stereograph"
  | "stop_word";

/** Дешёвый префильтр до vision-скоринга. Возвращает причину брака или null. */
export function rejectReason(item: RawItem, cfg: AppConfig): RejectReason | null {
  if (!item.year) return "no_year";
  // место обязательно, но запись с содержательным описанием пропускаем:
  // у архивов вне Бундесархива места в заголовке нет, а контекст в тексте есть
  if (!item.place && (item.description?.length ?? 0) < 60) return "no_place";
  // живой прогон: запрос "1930s" приносит современные фото зданий 1930-х
  const { min_year, max_year } = cfg.collect;
  if ((min_year && item.year < min_year) || (max_year && item.year > max_year)) {
    return "year_out_of_range";
  }
  if (item.imageWidth !== undefined && item.imageWidth < cfg.collect.min_image_width) {
    return "too_small";
  }

  const haystack = `${item.title ?? ""} ${item.description ?? ""}`.toLowerCase();
  // стереокарточки: два одинаковых кадра на картонке - в канал не годятся
  if (/stereograph|stereoscop|stereo card|stereo view/.test(haystack)) {
    return "stereograph";
  }
  for (const word of cfg.filters.stop_words) {
    if (haystack.includes(word.toLowerCase())) return "stop_word";
  }
  return null;
}

export function prefilter<T extends RawItem>(
  items: T[],
  cfg: AppConfig,
): { kept: T[]; rejected: Map<RejectReason, number> } {
  const kept: T[] = [];
  const rejected = new Map<RejectReason, number>();
  for (const item of items) {
    const reason = rejectReason(item, cfg);
    if (reason === null) {
      kept.push(item);
    } else {
      rejected.set(reason, (rejected.get(reason) ?? 0) + 1);
    }
  }
  return { kept, rejected };
}
