/**
 * «Обещание» кадра - грубая оценка по одним метаданным, без ИИ.
 *
 * Слотов на анализ всего тридцать, и раньше они доставались кадрам просто
 * по кругу архивов - то есть случайным. Обещание переставляет очередь так,
 * чтобы дорогие запросы к Gemini тратились на самых перспективных, а
 * заведомо протокольные сюжеты уходили в хвост.
 *
 * Это ТОЛЬКО порядок, ничего не выбрасывается: слова врут, и кадр с низким
 * обещанием вполне может оказаться отличным - он просто ждёт своей очереди.
 */
import type { RawItem } from "./sources/types.js";

/**
 * Слова, которыми архивы описывают то, ради чего мы и берём кадр:
 * трофей, обломки, момент, бой. Четыре языка - подписи в пуле разные.
 */
const HOOK_WORDS =
  /\b(captur\w*|erbeut\w*|trophy|wreck\w*|destroy\w*|zerst\w*|burn\w*|brenn\w*|abandon\w*|knocked[- ]out|ausgebrannt|sink\w*|sunk|crash\w*|attack\w*|angriff|assault|advanc\w*|storm\w*|firing|fires|explos\w*|hyökkäys|tuho\w*)|захвач\w*|трофе\w*|подбит\w*|обломк\w*|горящ\w*|разруш\w*|атак\w*|штурм/i;

/** Подлинный цвет эпохи - редкость, за которую канал любят. */
const COLOR_WORDS = /\b(kodachrome|autochrome|agfacolor|colou?r photograph|farbfoto|farbaufnahme)\b/i;

/**
 * Слова протокола: церемонии, портреты, совещания. Такой кадр почти
 * наверняка не получит крючка, и тратить на него слот жалко.
 */
const DULL_WORDS =
  /\b(portrait|ceremony|ceremonial|conference|meeting|delegation|inspection|parade|posing|poses|group photo|award\w*|visit\w* of|besuch|feier|porträt)\b|портрет|церемони\w*|совещан\w*|делегац\w*|парад\w*|вручен\w*/i;

/**
 * Балл обещания. Чем выше, тем раньше кадр попадёт на анализ.
 * Диапазон примерно от -4 до +9.
 */
export function promise(item: RawItem): number {
  const text = `${item.title ?? ""} ${item.description ?? ""}`;
  let score = 0;

  // содержательное описание = модели есть на чём построить подпись, и
  // выше шанс, что в кадре вообще есть о чём рассказать
  const len = (item.description ?? "").length;
  score += Math.min(3, Math.floor(len / 80));

  if (HOOK_WORDS.test(text)) score += 4;
  if (COLOR_WORDS.test(text)) score += 3;
  if (DULL_WORDS.test(text)) score -= 4;
  // известное место - меньше шансов, что подпись выйдет безликой
  if (item.place) score += 1;

  return score;
}

/**
 * Сортировка по обещанию, устойчивая: при равных баллах порядок исходный,
 * иначе перемешивание по архивам поедет и вернётся перекос.
 */
export function byPromise<T extends RawItem>(items: T[]): T[] {
  return items
    .map((item, i) => ({ item, i, p: promise(item) }))
    .sort((a, b) => b.p - a.p || a.i - b.i)
    .map((r) => r.item);
}
