import type { AppConfig } from "./config.js";
import type { RawItem } from "./sources/types.js";
import { archiveKey } from "./plan.js";

export type RejectReason =
  | "no_year"
  | "no_place"
  | "year_out_of_range"
  | "too_small"
  | "stereograph"
  | "album_record"
  | "untitled_record"
  | "studio_portrait"
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
  // порог ширины: у отдельных архивов он свой. Живой замер 16.08: у РИА
  // Новости общий порог отсекал 4 кадра из 6, и единственный советский
  // архив не доходил до ленты вовсе
  const perArchive = cfg.collect.min_image_width_by_archive?.[archiveKey(item.attribution)];
  const minWidth = perArchive ?? cfg.collect.min_image_width;
  if (item.imageWidth !== undefined && item.imageWidth < minWidth) {
    return "too_small";
  }

  const haystack = `${item.title ?? ""} ${item.description ?? ""}`.toLowerCase();
  // стереокарточки: два одинаковых кадра на картонке - в канал не годятся
  if (/stereograph|stereoscop|stereo card|stereo view/.test(haystack)) {
    return "stereograph";
  }
  // карточка целого альбома вместо снимка: у LOC такие приходят с обычной
  // картинкой-обложкой и проходят все проверки, а на анализе выясняется,
  // что описывать нечего (живой прогон 12.08: три подряд «... Collection»)
  const title = (item.title ?? "").trim();
  if (/\b(collection|photograph album|scrapbook|papers)$/i.test(title)) {
    return "album_record";
  }
  // LOC-заглушка «Untitled photo, possibly related to: ...»: сам архив не
  // знает, что на снимке, - подписи из такого не выйдет, а одинаковый
  // заголовок идёт дублями (живая очередь 31.08: два слота на один текст)
  if (/^untitled photo/i.test(title)) {
    return "untitled_record";
  }
  // студийный портрет: в названии так и сказано. Крючка у такого кадра
  // нет по определению, а анализ он всё равно съедает (сухой прогон
  // 12.08: «Churchill portrait NYP 45063»)
  if (/\bportrait\b/i.test(title) && !/\b(tank|aircraft|ship|gun|wreck)\b/i.test(title)) {
    return "studio_portrait";
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
