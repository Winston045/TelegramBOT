/**
 * Рубрики вне военного ядра (решение редакции 16.10).
 *
 * Канал - военная история; рубрика - редкая краска, а не смена профиля.
 * Поэтому у каждой - своё окно лет, своя постановка задачи для Gemini и
 * жёсткие проверки на выходе: кадр рубрики должен быть ВИДИМО рубрикой
 * (плакат назван плакатом, повседневность подана изюминкой), иначе это
 * лажа, и в резерв он не идёт. Сколько рубрик выходит в неделю, решает
 * планировщик (RUBRIC_WEEKLY_CAP в _shared/plan.ts), а не этот файл.
 *
 * Рубрику кадру ставит источник (поле rubric у архива или запроса в
 * config.yaml), а не модель: модель ошибается в классификации, конфиг -
 * нет. Военный кадр без рубрики идёт по общим правилам канала.
 */
import { RUBRIC_WEEKLY_CAP } from "./plan.js";
import { isBarePlaceDate } from "./caption.js";

export type Rubric = {
  /** Название для логов и отчётов. */
  title: string;
  /** Окно лет вместо общего min_year/max_year. */
  years: [number, number];
  /** Постановка задачи для Gemini: что это за кадр и как его судить. */
  brief: string;
  /** Тема, которую ставим сами: модель путала бы её с темами ядра. */
  subject?: string;
  /** Военный ли сюжет - тоже ставим сами, для окна мирных кадров. */
  military?: boolean;
  /** Порог оценки вместо общего min_score. */
  minScore?: number;
  /** Порог для кадра без крючка вместо общего hookless_min_score. */
  hooklessMinScore?: number;
  /** Пост обязан быть изюминкой: в цитате факт, а не голые место и год. */
  needsFact?: boolean;
  /** Тело подписи обязано называть жанр (плакат, карикатура). */
  bodyMust?: RegExp;
  /** Носитель - не фотография: рисунок, плакат, литография. */
  artwork?: boolean;
  /**
   * Метаданные кадра обязаны назвать кого-то из этого списка - иначе кадр
   * отсекается до Gemini. Для культуры: местная эстрада никому не нужна.
   */
  metaMust?: RegExp;
};

/**
 * Звёзды мировой величины для рубрики «культура». Редакция 22.10: Anefo
 * по словам «popgroep», «zangeres», «actrice» приносил нидерландских
 * исполнителей, которых за пределами страны никто не знает, - читатель
 * канала видел «каких-то певиц и музыкантов». Судить известность по
 * лицу модель не может, а список - может: в рубрику идут только кадры,
 * где архив сам назвал одну из этих звёзд. Список же служит словами
 * поиска по Anefo (config.yaml).
 */
export const CULTURE_STARS = [
  "Beatles", "Rolling Stones", "Louis Armstrong", "Ella Fitzgerald", "Duke Ellington",
  "Count Basie", "Miles Davis", "Dizzy Gillespie", "Lionel Hampton", "Benny Goodman",
  "Nat King Cole", "Ray Charles", "Chuck Berry", "Fats Domino", "Mahalia Jackson",
  "Harry Belafonte", "Sammy Davis", "Frank Sinatra", "Bing Crosby", "Marlene Dietrich",
  "Josephine Baker", "Edith Piaf", "Yves Montand", "Charles Aznavour", "Jacques Brel",
  "Johnny Hallyday", "Jimi Hendrix", "Bob Dylan", "ABBA", "Pink Floyd", "The Who",
  "The Kinks", "Led Zeppelin", "David Bowie", "Elton John", "Tina Turner", "Stevie Wonder",
  "Diana Ross", "Bee Gees", "Cliff Richard", "Shirley Bassey", "Tom Jones",
  "Charlie Chaplin", "Audrey Hepburn", "Sophia Loren", "Gina Lollobrigida", "Brigitte Bardot",
  "Kirk Douglas", "Gregory Peck", "Cary Grant", "John Wayne", "Elizabeth Taylor",
  "Ingrid Bergman", "Grace Kelly", "Gloria Swanson", "Romy Schneider", "Jane Fonda",
  "Alfred Hitchcock", "Federico Fellini", "Danny Kaye", "Jerry Lewis",
  "Leonard Bernstein", "Herbert von Karajan", "Igor Stravinsky", "Rudolf Noerejev",
  "Rudolf Nureyev", "Margot Fonteyn", "Salvador Dali", "Pablo Picasso", "Marc Chagall",
];

const CULTURE_STAR_RE = new RegExp(
  `(?<![\\p{L}])(${CULTURE_STARS.map((n) => n.replace(/ /g, "\\s+")).join("|")})(?![\\p{L}])`,
  "iu",
);

export const RUBRICS: Record<string, Rubric> = {
  modern: {
    title: "современная армия",
    // 2013 - сознательно: дальше начинаются войны, которые ещё идут
    years: [1991, 2013],
    brief: `РУБРИКА «СОВРЕМЕННАЯ АРМИЯ» (1991-2013). Это по теме канала:
современная съёмка здесь НЕ брак, правило «современное фото - 0-24» к
этому кадру не относится. Суди его как любой военный кадр канала: техника,
учения с огнём, десант, авиация, флот, редкие машины - по тем же критериям
крючка. Поставь period: "modern". Ничего не утверждай о войнах, которые
идут сейчас.`,
  },
  culture: {
    title: "культура 1945-1989",
    years: [1945, 1989],
    subject: "culture",
    military: false,
    // только звёзды мировой величины, названные архивом (редакция 22.10)
    metaMust: CULTURE_STAR_RE,
    minScore: 55,
    brief: `РУБРИКА «КУЛЬТУРА 1945-1989»: звёзды мировой величины - музыка,
кино, гастроли эпохи. Это по теме канала (military: false). Кадр интересен
ТОЛЬКО звездой, которую знает весь мир: Битлз, Луи Армстронг, Марлен
Дитрих. Подпись строится вокруг неё - назови её в теле поста. Крючок -
"human", "moment" или "rare". Людей называй ТОЛЬКО если они названы в
метаданных - по лицу никого не узнавай и не угадывай. Звезда стоит в
кадре мелко, со спины или её не видно - hook: "none".`,
  },
  social: {
    title: "социальная история",
    years: [1900, 1945],
    subject: "society",
    military: false,
    brief: `РУБРИКА «СОЦИАЛЬНАЯ ИСТОРИЯ»: как жили люди - детский труд,
Великая депрессия, переселенцы, заводы и фермы. Это по теме канала
(military: false). Крючок - человеческая история ("human") или редкая
деталь эпохи ("rare"). Без морализаторства и оценок: факты из метаданных
и то, что видно на снимке.`,
  },
  ussr_daily: {
    title: "советская повседневность",
    years: [1945, 1991],
    subject: "daily_life",
    military: false,
    needsFact: true,
    brief: `РУБРИКА «СОВЕТСКАЯ ПОВСЕДНЕВНОСТЬ» - редкая изюминка ленты: быт,
улицы, магазины, транспорт, работа в СССР. Это по теме канала
(military: false). Такой пост выходит ТОЛЬКО изюминкой: в quote - факт из
метаданных или контекста (что это, сколько стоило, чем кончилось, чем
необычно), место и дата - в quote_place. Нет в материале такого факта -
ставь hook: "none": голая бытовая сцена в канал не идёт.`,
  },
  poster: {
    title: "плакаты и карикатуры",
    years: [1914, 1991],
    subject: "poster",
    minScore: 60,
    // у плаката нет «крючка» в смысле снимка: его сила - образ и смысл,
    // поэтому судим только оценку, а она здесь строже общей
    hooklessMinScore: 60,
    bodyMust: /плакат|карикатур|листовк|афиш/i,
    artwork: true,
    brief: `РУБРИКА «ПЛАКАТЫ И КАРИКАТУРЫ». Это НЕ фотография, и это честно
рубрика канала: правило «репродукция плаката - 0-24» к этому кадру не
относится. Но если на картинке ФОТОГРАФИЯ (снимок людей, техники, улицы,
даже снимок плаката на стене), а не сам плакат или карикатура, - это
брак рубрики: score 0-10 и hook: "none", подпись «плакат» к фото - ложь. Оценивай как плакат: сила образа, читаемость, исторический
смысл, редкость; блёклый скан, обрезка и нечитаемость - потолок 45.
caption ОБЯЗАН назвать жанр и происхождение, если оно есть в метаданных:
«Американский плакат времён Второй мировой...», «Карикатура...». Лозунг
пересказывай по-русски ТОЛЬКО если его текст есть в метаданных - с
картинки не вычитывай. В quote - страна и год, как у обычного поста,
или изюминка о самом плакате (кто автор, зачем его выпустили, чем он
прославился), если это есть в материале.`,
  },
};

/** Рубрика по идентификатору; неизвестная - undefined. */
export function rubricOf(id?: string | null): Rubric | undefined {
  return id ? RUBRICS[id] : undefined;
}

/**
 * Сверка таблиц: у каждой рубрики сбора должен быть недельный потолок
 * публикации, и наоборот. Иначе рубрика собирается, но не выходит, или
 * выходит по запасному потолку - тихая рассинхронизация.
 */
export function rubricTablesMismatch(): string[] {
  const collect = Object.keys(RUBRICS);
  const publish = Object.keys(RUBRIC_WEEKLY_CAP);
  return [
    ...collect.filter((r) => !publish.includes(r)).map((r) => `у рубрики ${r} нет недельного потолка`),
    ...publish.filter((r) => !collect.includes(r)).map((r) => `потолок для неизвестной рубрики ${r}`),
  ];
}

/**
 * Чем подпись не дотягивает до рубрики; undefined - всё в порядке.
 * Проверяется ПОСЛЕ редактора цитат: он мог превратить изюминку в
 * голые место и год, и тогда пост повседневности уже не изюминка.
 */
export function rubricCaptionFlaw(
  rubric: Rubric,
  caption: { caption: string; quote: string },
): string | undefined {
  if (rubric.needsFact && (!caption.quote.trim() || isBarePlaceDate(caption.quote))) {
    return "нет изюминки - рубрика выходит только с фактом";
  }
  if (rubric.bodyMust && !rubric.bodyMust.test(caption.caption)) {
    return "в подписи не назван жанр";
  }
  return undefined;
}
