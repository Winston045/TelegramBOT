import type { AppConfig } from "./config.js";
import type { RawItem } from "./sources/types.js";
import { archiveKey } from "./plan.js";
import { rubricOf } from "./rubrics.js";

export type RejectReason =
  | "no_year"
  | "no_place"
  | "year_out_of_range"
  | "too_small"
  | "stereograph"
  | "album_record"
  | "untitled_record"
  | "studio_portrait"
  | "not_photo"
  | "not_artwork"
  | "unknown_rubric"
  | "no_star"
  | "stop_word";

/**
 * Рисунок, плакат, гравюра - не фотография, а канал - фотоархив.
 *
 * Отличать их по картинке поручали Gemini, и это ненадёжно: 15.10
 * облегчённая модель поставила фронтовому рисунку Говарда Броди 65 баллов
 * и пустила его в резерв с подписью «Боец на ночном дежурстве в окопе»,
 * а такой же рисунок той же серии минутой позже оценила в 15 как «не
 * фотографию». Архив же говорит об этом прямо, в физическом описании:
 * «1 drawing : crayon, graphite, and ink» и «Drawing shows ...». Фото там
 * - «1 photographic print», «1 negative», «1 transparency : color».
 */
/*
 * Носитель стоит в начале описания или поля («... | 1 drawing : ...»),
 * поэтому «3 posters» посреди сюжета («Soldiers putting up 3 posters»)
 * не в счёт. «Print shows» не в счёт тоже: у LOC это и фотоотпечатки
 * («Photographic print shows Marines landing») - ревизия 16.10 поймала,
 * что прежнее правило выбрасывало настоящие снимки.
 */
const NON_PHOTO_CARRIER =
  /(?:^|\|)\s*\d+\s+(?:drawings?|paintings?|posters?|watercolou?rs?|sketch(?:es)?|cartoons?|prints?\s*:\s*(?:lithograph|woodcut|etching|engraving|screenprint|serigraph)\w*)\b/i;
const NON_PHOTO_SHOWS = /\b(?:drawing|poster|painting|cartoon|sketch|lithograph) shows\b/i;
/**
 * Как пишут о рисунке музеи Europeana (Wellcome Collection): «Drawing by
 * F. Dadd: red cross soldiers...», «Gouache painting, c. 1916». Симуляция
 * 22.10 поставила такой рисунок в очередь анализа как фотографию.
 */
const NON_PHOTO_BY = /\b(?:drawing|painting|sketch|watercolou?r|etching|engraving) by\b|\b(?:gouache|oil|watercolou?r) painting\b/i;

/** Архив прямо называет носитель фотографией. */
const PHOTO_CARRIER =
  /\b\d+\s+(?:photographic prints?|photoprints?|negatives?|transparenc(?:y|ies)|slides?)\b|\bphotograph(?:s|ed)?\b/i;

export function isPhotoRecord(title?: string | null, description?: string | null): boolean {
  return PHOTO_CARRIER.test(`${title ?? ""} ${description ?? ""}`);
}

export function isNonPhotoRecord(title?: string | null, description?: string | null): boolean {
  const desc = description ?? "";
  // заголовок и каждое поле описания проверяются как отдельное начало
  const fields = [title ?? "", ...desc.split("|")];
  return (
    fields.some((f) => NON_PHOTO_CARRIER.test(f.trimStart())) ||
    NON_PHOTO_SHOWS.test(`${title ?? ""} ${desc}`) ||
    NON_PHOTO_BY.test(`${title ?? ""} ${desc}`)
  );
}

/**
 * Порог ширины кадра: у отдельных архивов он свой. Живой замер 16.08: у
 * РИА Новости общий порог отсекал 4 кадра из 6, и единственный советский
 * архив не доходил до ленты вовсе.
 */
export function minWidthFor(item: Pick<RawItem, "attribution">, cfg: AppConfig): number {
  return cfg.collect.min_image_width_by_archive?.[archiveKey(item.attribution)] ?? cfg.collect.min_image_width;
}

/** Дешёвый префильтр до vision-скоринга. Возвращает причину брака или null. */
export function rejectReason(item: RawItem, cfg: AppConfig): RejectReason | null {
  if (!item.year) return "no_year";
  // место обязательно, но запись с содержательным описанием пропускаем:
  // у архивов вне Бундесархива места в заголовке нет, а контекст в тексте есть
  if (!item.place && (item.description?.length ?? 0) < 60) return "no_place";
  // у рубрики своё окно лет: современная армия живёт после 1999-го,
  // а общий потолок канала её бы отрезал целиком
  const rubric = rubricOf(item.rubric);
  if (item.rubric && !rubric) return "unknown_rubric";
  // живой прогон: запрос "1930s" приносит современные фото зданий 1930-х
  const [min_year, max_year] = rubric?.years ?? [cfg.collect.min_year, cfg.collect.max_year];
  if ((min_year && item.year < min_year) || (max_year && item.year > max_year)) {
    return "year_out_of_range";
  }
  const minWidth = minWidthFor(item, cfg);
  if (item.imageWidth !== undefined && item.imageWidth < minWidth) {
    return "too_small";
  }

  const haystack = `${item.title ?? ""} ${item.description ?? ""}`.toLowerCase();
  // стереокарточки: два одинаковых кадра на картонке - в канал не годятся.
  // Europeana пишет на языке музея: «Stereofoto», «stéréoscopie» - сбор
  // 22.10 отдал такую карточку Gemini и получил оценку 15
  if (/st[eé]r[eé]o(?:graph|scop|skop|card|view|foto|photo|bild|aufnahm|gram|karte|kort|pair)|stereo[- ](?:card|view|pair|photo)|стерео/.test(haystack)) {
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
  // рубрика, которой нужно громкое имя в метаданных (культура - только
  // мировые звёзды): без него кадр не стоит запроса к Gemini
  if (rubric?.metaMust && !rubric.metaMust.test(`${item.title ?? ""} ${item.description ?? ""}`)) {
    return "no_star";
  }
  // плакатная рубрика - зеркало правила «не фотография»: туда идут ТОЛЬКО
  // плакаты и карикатуры, а снимок, попавший в выдачу по слову poster
  // («1 photographic print. | Soldiers putting up posters»), там чужой.
  // Без описания носителя доверяем источнику: категория плакатов на
  // Commons уже сама говорит, что внутри
  if (rubric?.artwork) {
    if (isPhotoRecord(item.title, item.description) && !isNonPhotoRecord(item.title, item.description)) {
      return "not_artwork";
    }
  } else if (isNonPhotoRecord(item.title, item.description)) {
    return "not_photo";
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
