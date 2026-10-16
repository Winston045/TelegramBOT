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

/**
 * Подлинный цвет эпохи - редкость, за которую канал любят.
 *
 * Архивы пишут о цвете не словами, а форматом носителя: у LOC это
 * «1 transparency : color» и «1 slide : color». Раньше сито знало только
 * имена плёнок, и цветной кадр не получал форы в очереди: LOC отдаёт за
 * прогон три десятка записей, а до анализа доходят пять - цвет проигрывал
 * их чёрно-белым соседям вслепую. Итог по базе 15.10: десять цветных
 * постов за всё время, и ни одного нового цветного кадра после 18.09.
 */
const COLOR_WORDS =
  /\b(kodachrome|autochrome|agfacolor|ektachrome|colou?r photograph|colou?r (transparenc(y|ies)|slides?)|farbfoto|farbaufnahme|farbdia)\b|\b\d+\s+(transparenc(y|ies)|slides?)\s*:\s*colou?r/i;

/**
 * Слова протокола: церемонии, портреты, совещания. Такой кадр почти
 * наверняка не получит крючка, и тратить на него слот жалко.
 *
 * Языки сита должны совпадать с языками пула, иначе оно слепо. Полный
 * сбор 15.10 отдал 11 кадров из 23 в отсев «без крючка», и половина из
 * них - протокол на голландском и польском: приведение офицеров к
 * присяге дважды (beëdiging), приём в яхт-клубе (receptie), делегация,
 * светский портрет, парадный марш кавалерии. Anefo и Narodowe Archiwum
 * Cyfrowe сейчас по пять постов в ленте за месяц - столько же, сколько
 * IWM, - а их церемонии шли в анализ беспрепятственно. Финский добавлен
 * заодно: SA-kuva того же калибра поставщик.
 */
const DULL_WORDS =
  /\b(portrait|ceremony|ceremonial|conference|meeting|delegation|inspection|parade|posing|poses|group photo|award\w*|visit\w* of|besuch|feier|porträt)\b/i;

/** Протокол по-русски. */
const DULL_RU = /портрет|церемони\w*|совещан\w*|делегац\w*|парад\w*|вручен\w*|присяг\w*/i;

/**
 * Протокол по-голландски (Anefo) и по-польски (NAC). Границу слова
 * задаём через \p{L}, а не \b: в JS \b не видит букв с диакритикой, и
 * «Defilé» после «é» границы не находил - кадр проходил мимо сита.
 * Основы сравниваются по началу слова: «bezoek» ловит и «bezoeken».
 */
const DULL_NL_PL =
  /(?<!\p{L})(?:be[eë]dig|ceremonie|receptie|bezoek|defil[eé]|onderscheiding|huldiging|portret|vergadering|delegatie|inspectie|uroczysto|defilada|przysi[eę]g|wizyta|odznacze|obchody|akademi|po[sś]wi[eę]ceni)/iu;

/** Протокол по-фински (SA-kuva). */
const DULL_FI = /(?<!\p{L})(?:paraati|vierailu|juhla|seppeleenlasku|kunniamerkk)/iu;

/** Протокольный ли кадр по метаданным - на любом из языков пула. */
function isDull(text: string): boolean {
  return DULL_WORDS.test(text) || DULL_RU.test(text) || DULL_NL_PL.test(text) || DULL_FI.test(text);
}

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
  if (isDull(text)) score -= 4;
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
