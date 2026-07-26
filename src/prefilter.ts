import type { AppConfig } from "./config.js";
import type { RawItem } from "./sources/types.js";

export type RejectReason = "no_year" | "no_place" | "too_small" | "stop_word";

/** Дешёвый префильтр до vision-скоринга. Возвращает причину брака или null. */
export function rejectReason(item: RawItem, cfg: AppConfig): RejectReason | null {
  if (!item.year) return "no_year";
  if (!item.place) return "no_place";
  if (item.imageWidth !== undefined && item.imageWidth < cfg.collect.min_image_width) {
    return "too_small";
  }

  const haystack = `${item.title ?? ""} ${item.description ?? ""}`.toLowerCase();
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
