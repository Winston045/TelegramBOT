/**
 * План публикаций - единственный источник правды о том, что и когда выйдет.
 *
 * Раньше автопостинг был пристройкой к ручному режиму: публикатор сам решал,
 * кого взять, а команда /queue показывала только одобренное - в авторежиме
 * она всегда была пуста, хотя посты выходили. Теперь и публикатор, и бот
 * зовут один и тот же планировщик, поэтому предпросмотр совпадает с тем,
 * что реально уедет в канал.
 *
 * Файл без импортов: используется и Node-скриптами, и Deno Edge Function.
 */

export type PlanTags = {
  subject?: string;
  region?: string;
  period?: string;
  military?: boolean;
  action?: boolean;
  color?: boolean;
  /** Рубрика вне военного ядра (см. RUBRIC_WEEKLY_CAP); у ядра её нет. */
  rubric?: string;
} | null;

export type PlanCandidate = {
  id: number;
  caption_html: string | null;
  score?: number | null;
  tags?: PlanTags;
  scheduled_at?: string | null;
  /** Архив-поставщик («Bundesarchiv», «IWM», «РИА Новости»...). */
  attribution?: string | null;
  /** Источник («commons», «loc», «pastvu») - запасной ключ чередования
   *  для старых кандидатов, собранных без архива. */
  source?: string | null;
  /** Ярус очереди: одобренным - APPROVED_PRIORITY, резерву - 0. */
  priority?: number;
  /** Когда кадр собран - по нему одобрение стареет (approvedPriority). */
  created_at?: string | null;
};

/**
 * Сколько дней кадр из резерва годен к автопубликации: у старых чаще
 * мертвеет ссылка архива, а оформление отстаёт от текущих правил. Общая
 * константа для публикатора, превью /queue и сторожа сбора - раньше
 * каждый жил со своим представлением о резерве, и превью показывало
 * посты, которые публикатор уже не возьмёт.
 */
export const RESERVE_TTL_DAYS = 10;

/**
 * Одобренный редактором пост выходит раньше любого из резерва - но только
 * если он не ломает правила разнообразия.
 *
 * Раньше одобренная очередь вытесняла резерв целиком: пока в ней лежал
 * хоть один пост, резерв не рассматривался вовсе. Отчёт 15.10: в очереди 7
 * одобренных, четыре из них - американская пехота, два ждут с 7 и 12
 * сентября. Все правила чередования работали на пуле из семи кадров, и
 * когда ни один не подходил, срабатывал аварийный добор - отсюда infantry
 * 33% месячной ленты и пары подряд, при живом резерве с другими темами.
 *
 * Теперь пул общий, а одобрение - отдельный ЯРУС сортировки, не надбавка
 * к рангу: среди подходящих под правила одобренный побеждает всегда;
 * резервный пост выходит только тогда, когда одобренный дал бы повтор.
 * Надбавкой (было +100) это не держалось: недельные доли архива, эпохи и
 * темы вместе со штрафами за статику и эпоху набирают больше сотни, и
 * сильный резервный кадр мог обойти подходящий одобренный.
 */
export const APPROVED_PRIORITY = 1;

/**
 * Ярус одобренного поста. Одобрение стареет вместе с резервом: пост,
 * собранный больше RESERVE_TTL_DAYS назад, остаётся в очереди и выходит,
 * но уже на общих основаниях - по рангу, без права вперёд.
 *
 * Симуляция 22.10: в очереди 14 одобренных, четыре из них - американская
 * пехота с оценкой 45-52, ждущая с 7 сентября. Ярус ставил их вперёд
 * всего, правило стран лишь разводило их через пост - и лента шла
 * «американец, кто-то, американец». А сторож добора считал их запасом и
 * не собирал свежего: резерва в сроке годности - ноль.
 */
export function approvedPriority(createdAt: string | null | undefined, now: Date): number {
  if (!createdAt) return APPROVED_PRIORITY;
  const age = now.getTime() - new Date(createdAt).getTime();
  return age <= RESERVE_TTL_DAYS * 24 * 3600 * 1000 ? APPROVED_PRIORITY : 0;
}

/** Откуда пост попал в план - это видно редактору в /queue. */
export type PlanKind = "scheduled" | "approved" | "auto";

export type PlanEntry = {
  candidate: PlanCandidate;
  kind: PlanKind;
  /** Человеческая метка времени: "сегодня 18:00", "сейчас", "02.08 09:30". */
  when: string;
  /** true - слот уже наступил, пост уедет ближайшим заходом публикатора. */
  due: boolean;
};

/** Насколько развёрнутая цитата поднимает пост в очереди автовыбора. */
export const QUOTE_BONUS = 5;
/** Длина цитаты, с которой она считается познавательной справкой. */
export const LONG_QUOTE = 180;
/** Сколько последних постов помним для правил разнообразия. */
export const RECENT_WINDOW = 4;
/**
 * Насколько статика уступает живому кадру при равном качестве. Оценка за
 * постановочность больше не штрафуется (это делала модель и выбрасывала
 * целые архивы), но в ленте движение идёт вперёд.
 */
export const STATIC_PENALTY = 12;
/**
 * Подлинный цвет эпохи - редкость, читатели такое любят: небольшая фора,
 * чтобы цветной кадр выигрывал у равного чёрно-белого, но не у лучшего.
 */
export const COLOR_BONUS = 8;
/**
 * Эпохи до ВМВ уступают при равном качестве: снимки тех лет часто сильно
 * повреждены, упор канала - ВМВ и вторая половина XX века. Это скидка,
 * а не запрет: старый кадр с сильной историей (высокая оценка, развёрнутая
 * цитата) перевешивает её и выходит.
 */
export const OLD_ERA_PENALTY = 8;
export const OLD_PERIODS = new Set([
  "pre_ww1",
  "WW1",
  "russian_civil_war",
  "interwar",
  "spanish_civil_war",
]);
/** Сколько статичных кадров допускаем на окно из RECENT_WINDOW постов. */
export const MAX_STATIC_IN_WINDOW = 1;
/**
 * Развёрнутая цитата - изюминка ленты, а не норма: основная масса постов
 * короткие, и длинные справки не должны идти подряд. Одна на окно.
 */
export const MAX_LONG_IN_WINDOW = 1;
/**
 * Канал про войну: мирный сюжет уступает боевому при равном качестве,
 * но яркий мирный кадр (высокая оценка) штраф перевешивает и выходит.
 */
export const CIVILIAN_PENALTY = 6;
/** Сколько мирных кадров допускаем на окно из RECENT_WINDOW постов. */
export const MAX_CIVILIAN_IN_WINDOW = 1;
/**
 * Шахматный порядок архивов: два поста подряд из одного архива не идут.
 * Состав резерва зависит от того, кто в этот день отдал больше, и лента
 * качалась от «одних немцев» к «одним британцам»; веса источников тут
 * бессильны - перекос просто меняет флаг, поэтому чередуем на отборе.
 * Окно короткое (соседний пост), иначе при трёх живых архивах лента
 * упиралась бы в правило и шла по запасному пути.
 */
export const MAX_SAME_ARCHIVE_IN_WINDOW = 1;
export const ARCHIVE_WINDOW = 2;
/**
 * Чередования архивов мало: у одной страны их бывает несколько. Живой
 * случай 13.08 - в пуле четыре американских поставщика (LOC как источник,
 * та же Библиотека Конгресса внутри Commons, NARA и Signal Corps). Для
 * правила выше это четыре разных архива, которые честно сменяют друг
 * друга, а читатель видит подряд США, США, США. Поэтому же окно, но по
 * стране архива.
 */
export const MAX_SAME_NATION_IN_WINDOW = 1;
/**
 * Окно по стране - три поста: одна страна не чаще раза в три поста. Было
 * два, и разбор 22.10 показал, что этого мало: американцы шли через пост
 * (29% ленты за две недели, три из четырёх постов 20-21.10), и читатель
 * видел «канал про США».
 */
export const NATION_WINDOW = 3;

/**
 * Страна, занявшая больше пятой части недели, уступает при равном
 * качестве - как архив, эпоха и тема. Окно держит соседство, а доля -
 * неделю: без неё «через два поста на третий» тоже даёт треть ленты.
 */
export const NATION_SHARE_SOFT = 0.2;
export const NATION_SHARE_PENALTY = 60;

/**
 * «Своё» - СССР и Россия до него. Решение редакции 26.10: аудитория
 * русскоязычная, ей интереснее про своё. Разбор 45 постов 11-26.10: СССР
 * в 9% ленты, и то глазами чужих архивов (пленные у финнов, брошенный
 * ИС-2), а США - 27%. Правила выше уравнивали все страны; для своей
 * страны они мягче: не два поста подряд (а не раз в три), доля до 40%
 * недели (а не 20%), и при равном качестве свой кадр идёт первым.
 */
export const HOME_NATION = "ussr";
export const HOME_NATION_WINDOW = 1;
export const HOME_SHARE_SOFT = 0.4;
export const HOME_BONUS = 10;

/**
 * О какой стране пост - по тексту подписи, а не по архиву. Правило по
 * архиву не видело американцев в чужих архивах: плакат США с Commons
 * («WWII posters»), «американские солдаты» в британском IWM. Берём
 * страну, названную в описании первой: «Американские солдаты
 * осматривают подбитый немецкий танк» - пост про американцев.
 * Аббревиатуры ищем через \p{L}, а не \b: в JS граница слова не видит
 * кириллицы, и «армии США» правило пропускало.
 */
const NATION_WORDS: Array<[RegExp, string]> = [
  [/американ|(?<!\p{L})США(?!\p{L})/iu, "usa"],
  [/британ|английск|Королевск\S* (?:ВВС|флот)/i, "uk"],
  [/немецк|германск|вермахт|люфтваффе|кригсмарине/i, "germany"],
  [/советск|Красн\S* арми|(?<!\p{L})(?:СССР|РККА)(?!\p{L})/iu, "ussr"],
  // Россия до 1917-го и после 1991-го - тоже своё: «русские солдаты на
  // Юго-Западном фронте», «российские десантники»
  [/русск|российск|(?<!\p{L})Росси[ия]/iu, "ussr"],
  [/японск/i, "japan"],
  [/французск|\bФранци/i, "france"],
  [/польск/i, "poland"],
  [/финск|финлянд/i, "finland"],
  [/итальянск/i, "italy"],
  [/нидерланд|голландск/i, "netherlands"],
  [/австралийск/i, "australia"],
  [/канадск/i, "canada"],
  [/венгерск/i, "hungary"],
  [/китайск/i, "china"],
  [/югослав/i, "yugoslavia"],
  [/израильск/i, "israel"],
  [/ирландск/i, "ireland"],
];

/** Видимый текст описания - без цитат и подписи канала. */
function captionBody(captionHtml: string | null | undefined): string {
  if (!captionHtml) return "";
  return (captionHtml.split(/<blockquote/i)[0] ?? "").replace(/<[^>]+>/g, " ");
}

/** Страна, названная в описании первой; пустая строка - не названа. */
export function captionNation(captionHtml: string | null | undefined): string {
  const body = captionBody(captionHtml);
  let best = "";
  let bestAt = Infinity;
  for (const [re, nation] of NATION_WORDS) {
    const at = body.search(re);
    if (at !== -1 && at < bestAt) {
      bestAt = at;
      best = nation;
    }
  }
  return best;
}

/**
 * Страна поста для правил чередования: сначала то, о ком пост, потом -
 * страна архива. Пусто - страна неизвестна, правило такой кадр не держит.
 */
export function postNation(c: {
  caption_html?: string | null;
  attribution?: string | null;
  source?: string | null;
}): string {
  return captionNation(c.caption_html) || archiveNation(c.attribution, c.source);
}

/** Страна архива: ключ archiveKey → флаг. Незнакомые архивы - без страны. */
const ARCHIVE_NATIONS: Record<string, string> = {
  bundesarchiv: "germany",
  iwm: "uk",
  "library of congress": "usa",
  loc: "usa",
  nara: "usa",
  "us army signal corps": "usa",
  "риа новости": "ussr",
  pastvu: "ussr",
  "sa-kuva": "finland",
  awm: "australia",
  anefo: "netherlands",
  // расширение 29.08: лента была на 73% англосаксонской
  "narodowe archiwum cyfrowe": "poland",
  "agence rol": "france",
  "pd-japan": "japan",
  "sino-japanese war": "china",
  "yugoslav partisans": "yugoslavia",
  // расширение 18.10
  nhhc: "usa",
  fortepan: "hungary",
  "national library of ireland": "ireland",
  usaf: "usa",
  "soviet posters": "ussr",
  // своё, 26.10: фронтовые фотографы СССР на Commons
  "евгений халдей": "ussr",
  "георгий зельма": "ussr",
  "аркадий шайхет": "ussr",
};

/**
 * Страна архива по его ключу. Пустая строка - страна неизвестна, такой
 * кадр правило по странам не придерживает (лучше выпустить, чем молчать).
 */
export function archiveNation(attribution?: string | null, source?: string | null): string {
  const key = archiveKey(attribution) || (source ?? "");
  return ARCHIVE_NATIONS[key] ?? "";
}
/**
 * Вожди и церемонии с ними («leader») - самые «фотогеничные» кадры в
 * архивах, модель щедра к ним на оценку, и лента превращалась в галерею
 * Гитлера. Держим их редкой краской: не чаще одного на окно.
 */
export const LEADER_PENALTY = 10;
export const MAX_LEADERS_IN_WINDOW = 1;

/**
 * Имя архива из строки атрибуции. В базе она вида
 * «Bundesarchiv, Koch / CC BY-SA 3.0 de» - с фотографом и лицензией,
 * поэтому сравнивать строки целиком нельзя: они уникальны у каждого
 * кадра, и правила баланса по архиву не срабатывали ни разу.
 */
export function archiveKey(attribution?: string | null): string {
  if (!attribution) return "";
  return (attribution.split("/")[0] ?? "").split(",")[0]!.trim().toLowerCase();
}

/** Видимая длина цитаты внутри blockquote. */
export function quoteLength(captionHtml: string | null): number {
  const m = captionHtml?.match(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/);
  return m?.[1]?.replace(/<[^>]+>/g, "").trim().length ?? 0;
}

/** Первая строка подписи без тегов - заголовок для списков. */
export function headline(captionHtml: string | null, limit = 70): string {
  if (!captionHtml) return "(без подписи)";
  const text = captionHtml.replace(/<[^>]+>/g, "").split("\n")[0] ?? "";
  return text.length > limit ? `${text.slice(0, limit - 3)}...` : text;
}

/**
 * Место в очереди: качество кадра плюс редакционные предпочтения.
 * Оценка отвечает за качество, здесь - за характер ленты.
 */
export function rank(
  c: PlanCandidate,
  archiveShare?: Record<string, number>,
  periodShare?: Record<string, number>,
  subjectShare?: Record<string, number>,
  nationShare?: Record<string, number>,
): number {
  const quote = quoteLength(c.caption_html ?? null) >= LONG_QUOTE ? QUOTE_BONUS : 0;
  const staticShot = c.tags?.action === false ? STATIC_PENALTY : 0;
  const color = c.tags?.color === true ? COLOR_BONUS : 0;
  const oldEra = c.tags?.period && OLD_PERIODS.has(c.tags.period) ? OLD_ERA_PENALTY : 0;
  const civilian = c.tags?.military === false ? CIVILIAN_PENALTY : 0;
  const leader = c.tags?.subject === "leader" ? LEADER_PENALTY : 0;
  // недельный перекос: архив, занявший больше четверти ленты, уступает
  // своя страна живёт в основном в РИА Новости - её архиву планка выше,
  // иначе потолок архива срезал бы и долю своего
  const nation = postNation(c);
  const home = nation === HOME_NATION;
  const share = archiveShare?.[archiveKey(c.attribution) || (c.source ?? "")] ?? 0;
  const archiveSoft = home ? HOME_SHARE_SOFT : ARCHIVE_SHARE_SOFT;
  const overshare = share > archiveSoft ? (share - archiveSoft) * ARCHIVE_SHARE_PENALTY : 0;
  // и эпоха, занявшая больше половины недели, тоже - иначе при резерве
  // из одной ВМВ прочие эпохи не выходят из хвоста очереди неделями
  const pShare = c.tags?.period ? (periodShare?.[c.tags.period] ?? 0) : 0;
  const periodOver =
    pShare > PERIOD_SHARE_SOFT ? (pShare - PERIOD_SHARE_SOFT) * PERIOD_SHARE_PENALTY : 0;
  // и тема: пехота на 30% ленты - те же «одни немцы», только по сюжету
  const sShare = c.tags?.subject ? (subjectShare?.[c.tags.subject] ?? 0) : 0;
  const subjectOver =
    sShare > SUBJECT_SHARE_SOFT ? (sShare - SUBJECT_SHARE_SOFT) * SUBJECT_SHARE_PENALTY : 0;
  // и страна поста: американцы на трети недели - перекос, даже если
  // соседние посты честно чередуются
  const nShare = nation ? (nationShare?.[nation] ?? 0) : 0;
  const nationSoft = home ? HOME_SHARE_SOFT : NATION_SHARE_SOFT;
  const nationOver = nShare > nationSoft ? (nShare - nationSoft) * NATION_SHARE_PENALTY : 0;
  return (
    (c.score ?? 0) +
    (home ? HOME_BONUS : 0) +
    quote +
    color -
    staticShot -
    oldEra -
    civilian -
    leader -
    overshare -
    periodOver -
    subjectOver -
    nationOver
  );
}

/**
 * Недельные доли осей разнообразия по выборке вышедших постов - общий
 * счётчик для публикатора и симуляции, чтобы предпросмотр не расходился
 * с боевым отбором (диагностика 04.09 поймала именно такое расхождение
 * на очереди анализа).
 */
export function weekShares(
  rows: Array<{
    attribution?: string | null;
    source?: string | null;
    tags?: PlanTags;
    caption_html?: string | null;
  }>,
): {
  archiveShare: Record<string, number>;
  periodShare: Record<string, number>;
  subjectShare: Record<string, number>;
  nationShare: Record<string, number>;
  rubricWeek: Record<string, number>;
} {
  const archiveShare: Record<string, number> = {};
  const periodShare: Record<string, number> = {};
  const subjectShare: Record<string, number> = {};
  const nationShare: Record<string, number> = {};
  // рубрики считаем штуками, а не долями: потолок у них недельный и в постах
  const rubricWeek: Record<string, number> = {};
  for (const p of rows) {
    if (p.tags?.rubric) rubricWeek[p.tags.rubric] = (rubricWeek[p.tags.rubric] ?? 0) + 1;
    const key = archiveKey(p.attribution) || (p.source ?? "");
    if (key) archiveShare[key] = (archiveShare[key] ?? 0) + 1;
    if (p.tags?.period) periodShare[p.tags.period] = (periodShare[p.tags.period] ?? 0) + 1;
    if (p.tags?.subject) subjectShare[p.tags.subject] = (subjectShare[p.tags.subject] ?? 0) + 1;
    const nation = postNation(p);
    if (nation) nationShare[nation] = (nationShare[nation] ?? 0) + 1;
  }
  for (const share of [archiveShare, periodShare, subjectShare, nationShare]) {
    for (const key of Object.keys(share)) {
      share[key] = (share[key] ?? 0) / Math.max(1, rows.length);
    }
  }
  return { archiveShare, periodShare, subjectShare, nationShare, rubricWeek };
}

export type RecentContext = {
  /** Темы последних постов, свежие первыми. */
  subjects: string[];
  /** Эпохи последних постов, свежие первыми. */
  periods?: string[];
  /** Был ли мирный кадр среди последних постов. */
  civilian: boolean;
  /** Сколько статичных кадров было среди последних постов. */
  statics?: number;
  /** Сколько постов с развёрнутой цитатой было среди последних. */
  longs?: number;
  /** Архивы последних постов, свежие первыми. */
  archives?: string[];
  /**
   * Доли архивов за неделю: {"bundesarchiv": 0.6, "iwm": 0.2}. Короткое
   * окно не даёт лентe стать «в среднем немецкой»: соседние посты
   * чередуются, а за неделю перекос всё равно виден. Доминирующий архив
   * получает штраф в ранге - тем больший, чем сильнее он занял неделю.
   */
  archiveShare?: Record<string, number>;
  /** Доли эпох за неделю: {"WW2": 0.7}. Работает как archiveShare. */
  periodShare?: Record<string, number>;
  /** Доли тем за неделю: {"infantry": 0.3}. Работает как archiveShare. */
  subjectShare?: Record<string, number>;
  /** Доли стран за неделю (по тому, о ком пост): {"usa": 0.29}. */
  nationShare?: Record<string, number>;
  /**
   * Страны последних постов, свежие первыми, - по тому, о ком пост
   * (postNation). Не задано - выводится из архивов, как раньше.
   */
  nations?: string[];
  /** Рубрики последних постов, свежие первыми ("" - военное ядро). */
  rubrics?: string[];
  /** Сколько постов каждой рубрики вышло за неделю: {"poster": 1}. */
  rubricWeek?: Record<string, number>;
};

/**
 * С какой доли за неделю архив считается доминирующим. Было 0.35 - и
 * замер 24.08 показал, что IWM неделями сидит ровно на трети ленты
 * (10 постов из 30), не долетая до штрафа. Четверть - честный потолок
 * для девяти живых архивов.
 */
export const ARCHIVE_SHARE_SOFT = 0.25;
/** Штраф за каждый процент сверх мягкой доли (0.45 доли = 12 баллов). */
export const ARCHIVE_SHARE_PENALTY = 60;

/**
 * То же для эпох. ВМВ - ядро канала, и половина ленты за ней по праву,
 * но замер 24.08 дал 70% и серию из девяти постов ВМВ подряд: чередование
 * соседних постов с этим не справляется, когда эпоха доминирует в самом
 * резерве. Сверх половины эпоха начинает уступать при равном качестве -
 * редкие кадры других эпох всплывают раньше, а не ждут в хвосте.
 */
export const PERIOD_SHARE_SOFT = 0.5;
export const PERIOD_SHARE_PENALTY = 40;

/**
 * И для тем. Замер 15.09: infantry заняла 30% ленты за десять дней и
 * пошла тройкой подряд - у архива и эпохи недельные доли были, а тема
 * жила одним окном из четырёх постов, у которого нет памяти о неделе.
 * Пятая часть недели на одну тему - честный потолок при десятке живых.
 */
export const SUBJECT_SHARE_SOFT = 0.2;
export const SUBJECT_SHARE_PENALTY = 40;

/**
 * Рубрики вне военного ядра - не чаще стольких постов в неделю (решение
 * редакции 16.10). Это потолки, а не план: выходят, только если в резерве
 * есть сильный кадр рубрики. Военное ядро остаётся основой ленты: при
 * трёх постах в день рубрики вместе занимают не больше трети недели.
 *
 * - modern - современная армия 1991-2013 (текущие войны не берём);
 * - culture - культура 1945-1989, на пробу;
 * - social - социальная история, на пробу;
 * - ussr_daily - советская повседневность, только изюминкой и редко;
 * - poster - плакаты и карикатуры, раз в неделю.
 */
export const RUBRIC_WEEKLY_CAP: Record<string, number> = {
  modern: 3,
  culture: 2,
  social: 1,
  ussr_daily: 1,
  poster: 1,
};
/** Потолок для рубрики, которой нет в таблице: осторожно, раз в неделю. */
export const DEFAULT_RUBRIC_CAP = 1;

/** Сколько постов одной эпохи подряд допускаем, прежде чем сменить её. */
export const MAX_SAME_PERIOD_STREAK = 2;

/**
 * Жадный подбор из резерва: каждый следующий пост учитывает не только
 * вышедшее раньше, но и то, что уже попало в этот же план. Иначе три
 * одинаковых парома встают подряд именно в предпросмотре.
 *
 * Если подходящих нет вовсе, берём лучший оставшийся - пустой слот хуже
 * повтора темы.
 */
export function planAuto(
  reserve: PlanCandidate[],
  recent: RecentContext,
  count: number,
): PlanCandidate[] {
  const pool = [...reserve].sort(
    (a, b) =>
      (b.priority ?? 0) - (a.priority ?? 0) ||
      rank(b, recent.archiveShare, recent.periodShare, recent.subjectShare, recent.nationShare) -
        rank(a, recent.archiveShare, recent.periodShare, recent.subjectShare, recent.nationShare) ||
      a.id - b.id,
  );
  const chosen: PlanCandidate[] = [];
  const subjects = [...recent.subjects];
  const periods = [...(recent.periods ?? [])];
  // канал про войну: мирный кадр - редкая передышка, не череда
  const civiliansWindow: boolean[] = recent.civilian ? [true] : [];
  // архивы последних постов: лента не должна быть витриной одного архива
  const archives = [...(recent.archives ?? [])];
  // и страны этих архивов: четыре разных американских архива подряд -
  // формально чередование, а на деле «канал про США»
  const nations = recent.nations ? [...recent.nations] : archives.map((a) => ARCHIVE_NATIONS[a] ?? "");
  // окно скользит: сколько статики в последних RECENT_WINDOW постах
  const staticsWindow: boolean[] = Array.from(
    { length: Math.min(recent.statics ?? 0, RECENT_WINDOW) },
    () => true,
  );
  // то же для изюминок - постов с развёрнутой цитатой
  const longsWindow: boolean[] = Array.from(
    { length: Math.min(recent.longs ?? 0, RECENT_WINDOW) },
    () => true,
  );
  // рубрики: недельный счётчик растёт и от постов этого же плана
  const rubrics = [...(recent.rubrics ?? [])];
  const rubricWeek: Record<string, number> = { ...(recent.rubricWeek ?? {}) };
  // рубрика, выбравшая недельный потолок, не выходит НИКАК - ни по
  // правилам, ни аварийным добором: плакат дважды за неделю - это уже не
  // рубрика, а смена профиля канала
  const overCap = (c: PlanCandidate) => {
    const r = c.tags?.rubric;
    return Boolean(r) && (rubricWeek[r!] ?? 0) >= (RUBRIC_WEEKLY_CAP[r!] ?? DEFAULT_RUBRIC_CAP);
  };

  while (chosen.length < count && pool.length) {
    const staticsInWindow = staticsWindow.slice(0, RECENT_WINDOW).filter(Boolean).length;
    const longsInWindow = longsWindow.slice(0, RECENT_WINDOW).filter(Boolean).length;
    // эпоха «застряла», если ею заняты MAX_SAME_PERIOD_STREAK свежих постов
    const streak = periods.slice(0, MAX_SAME_PERIOD_STREAK);
    const stuckPeriod =
      streak.length === MAX_SAME_PERIOD_STREAK && streak.every((p) => p === streak[0])
        ? streak[0]
        : undefined;
    const civiliansInWindow = civiliansWindow.slice(0, RECENT_WINDOW).filter(Boolean).length;
    const fits = (c: PlanCandidate) => {
      if (overCap(c)) return false;
      // две рубрики подряд не идут: между ними - военное ядро
      if (c.tags?.rubric && rubrics[0]) return false;
      const subject = c.tags?.subject;
      if (subject && subjects.slice(0, RECENT_WINDOW).includes(subject)) return false;
      if (c.tags?.military === false && civiliansInWindow >= MAX_CIVILIAN_IN_WINDOW) return false;
      // статика допустима, но редко: лента должна дышать движением
      if (c.tags?.action === false && staticsInWindow >= MAX_STATIC_IN_WINDOW) return false;
      // развёрнутая цитата - изюминка: длинные посты не идут подряд
      if (quoteLength(c.caption_html ?? null) >= LONG_QUOTE && longsInWindow >= MAX_LONG_IN_WINDOW)
        return false;
      // лента не должна неделями сидеть в одном году - эпохи чередуются
      if (stuckPeriod && c.tags?.period === stuckPeriod) return false;
      // вожди - редкая краска, а не каждый второй пост
      if (
        c.tags?.subject === "leader" &&
        subjects.slice(0, RECENT_WINDOW).filter((s) => s === "leader").length >=
          MAX_LEADERS_IN_WINDOW
      ) {
        return false;
      }
      // и не должна быть витриной одного архива: «одни немцы», «одни британцы»
      const archive = archiveKey(c.attribution) || (c.source ?? "");
      if (
        archive &&
        archives.slice(0, ARCHIVE_WINDOW).filter((a) => a === archive).length >=
          MAX_SAME_ARCHIVE_IN_WINDOW
      ) {
        return false;
      }
      // то же по стране архива - иначе перекос просто меняет флаг
      const nation = postNation(c);
      const nationWindow = nation === HOME_NATION ? HOME_NATION_WINDOW : NATION_WINDOW;
      if (
        nation &&
        nations.slice(0, nationWindow).filter((n) => n === nation).length >=
          MAX_SAME_NATION_IN_WINDOW
      ) {
        return false;
      }
      return true;
    };
    let idx = pool.findIndex(fits);
    if (idx === -1) {
      // под все правила не подошёл никто (резерв беден) - берём лучшего,
      // но по цепочке предпочтений, а не слепо: слепой добор давал
      // «Бундесархив, Бундесархив, Бундесархив» и девять ВМВ подряд
      // (живой замер 24.08, посты 15-23). Сначала пробуем сменить эпоху
      // застрявшей серии, потом тему последнего поста, потом страну
      // архива, потом хотя бы сам архив. Тему добавил замер 15.09:
      // без неё бедный резерв дал infantry×3 подряд - цепочка меняла
      // что угодно, кроме сюжета.
      const lastNation = nations[0];
      const lastArchive = archives[0];
      const lastSubject = subjects[0];
      const otherPeriod = (c: PlanCandidate) =>
        Boolean(stuckPeriod) && Boolean(c.tags?.period) && c.tags?.period !== stuckPeriod;
      const otherSubject = (c: PlanCandidate) =>
        Boolean(lastSubject) && Boolean(c.tags?.subject) && c.tags?.subject !== lastSubject;
      const otherNation = (c: PlanCandidate) => {
        const n = postNation(c);
        return Boolean(lastNation) && n !== "" && n !== lastNation;
      };
      const otherArchive = (c: PlanCandidate) =>
        Boolean(lastArchive) && (archiveKey(c.attribution) || (c.source ?? "")) !== lastArchive;
      const prefs = [
        // смена эпохи, не тащащая за собой повтор темы, - лучший выход:
        // контрольная симуляция 15.09 показала, как добор честно сменил
        // эпоху и поставил вторую aviation подряд
        // сменить сразу и эпоху, и тему, и страну - лучше всего
        (c: PlanCandidate) => otherPeriod(c) && otherSubject(c) && otherNation(c),
        (c: PlanCandidate) => otherPeriod(c) && otherSubject(c),
        // страна поднята выше одиночной смены эпохи: аварийный добор
        // 12.10 дал два Signal Corps подряд - американцы шли сериями
        (c: PlanCandidate) => otherNation(c) && otherSubject(c),
        (c: PlanCandidate) => otherPeriod(c) && otherNation(c),
        otherNation,
        otherPeriod,
        otherSubject,
        otherArchive,
      ];
      let other = -1;
      for (const pref of prefs) {
        other = pool.findIndex((c) => !overCap(c) && pref(c));
        if (other !== -1) break;
      }
      idx = other === -1 ? pool.findIndex((c) => !overCap(c)) : other;
      // в пуле остались только рубрики сверх потолка - слот лучше оставить
      if (idx === -1) break;
    }
    const [pick] = pool.splice(idx, 1);
    if (!pick) break;
    chosen.push(pick);
    if (pick.tags?.subject) subjects.unshift(pick.tags.subject);
    periods.unshift(pick.tags?.period ?? "");
    civiliansWindow.unshift(pick.tags?.military === false);
    archives.unshift(archiveKey(pick.attribution) || (pick.source ?? ""));
    nations.unshift(postNation(pick));
    staticsWindow.unshift(pick.tags?.action === false);
    longsWindow.unshift(quoteLength(pick.caption_html ?? null) >= LONG_QUOTE);
    rubrics.unshift(pick.tags?.rubric ?? "");
    if (pick.tags?.rubric) rubricWeek[pick.tags.rubric] = (rubricWeek[pick.tags.rubric] ?? 0) + 1;
  }
  return chosen;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** "HH:MM" -> минуты от полуночи. */
function toMinutes(slot: string): number {
  const [h, m] = slot.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

export type SlotContext = {
  /** Текущее время. */
  now: Date;
  /** Смещение таймзоны канала, например "+03:00". */
  tzOffset: string;
  /** Слоты расписания "HH:MM". */
  times: string[];
  /** Сколько постов уже вышло сегодня. */
  publishedToday: number;
};

/**
 * Ближайшие моменты публикации. Первыми идут «догоняющие» слоты: если
 * сегодня прошло слотов больше, чем вышло постов, публикатор наверстает
 * их ближайшим заходом - так это и показываем.
 */
export function upcomingSlots(ctx: SlotContext, count: number): Array<{ label: string; due: boolean }> {
  const { now, tzOffset, times, publishedToday } = ctx;
  if (!times.length || count <= 0) return [];

  const local = new Date(now.getTime() + offsetMinutes(tzOffset) * 60_000);
  const nowMinutes = local.getUTCHours() * 60 + local.getUTCMinutes();
  const passed = times.filter((t) => toMinutes(t) <= nowMinutes).length;

  const out: Array<{ label: string; due: boolean }> = [];
  for (let i = 0; i < passed - publishedToday && out.length < count; i++) {
    out.push({ label: "ближайшим заходом", due: true });
  }

  for (let day = 0; day < 7 && out.length < count; day++) {
    for (const t of times) {
      if (out.length >= count) break;
      if (day === 0 && toMinutes(t) <= nowMinutes) continue;
      const when = new Date(local.getTime() + day * 24 * 3600 * 1000);
      const label =
        day === 0
          ? `сегодня ${t}`
          : day === 1
            ? `завтра ${t}`
            : `${pad(when.getUTCDate())}.${pad(when.getUTCMonth() + 1)} ${t}`;
      out.push({ label, due: false });
    }
  }
  return out;
}

function offsetMinutes(tzOffset: string): number {
  const m = tzOffset.match(/^([+-])(\d{2}):(\d{2})$/);
  if (!m) return 0;
  const sign = m[1] === "-" ? -1 : 1;
  return sign * (Number(m[2]) * 60 + Number(m[3]));
}

export type PlanInput = SlotContext & {
  /** Одобренные с назначенным временем. */
  scheduled: PlanCandidate[];
  /** Одобренные без времени, в порядке одобрения. */
  approved: PlanCandidate[];
  /** Резерв с готовой подписью (учитывается только при autoPublish). */
  reserve: PlanCandidate[];
  /** Темы и характер последних вышедших постов. */
  recent: RecentContext;
  autoPublish: boolean;
  /** Форматирование времени запланированных постов. */
  formatScheduled: (iso: string) => string;
};

/**
 * Что и когда выйдет. Порядок приоритетов тот же, что у публикатора:
 * назначенное время → одобренная очередь → автовыбор из резерва.
 */
export function buildPlan(input: PlanInput, count: number): PlanEntry[] {
  const entries: PlanEntry[] = [];

  for (const c of input.scheduled) {
    if (!c.scheduled_at) continue;
    entries.push({
      candidate: c,
      kind: "scheduled",
      when: input.formatScheduled(c.scheduled_at),
      due: new Date(c.scheduled_at).getTime() <= input.now.getTime(),
    });
  }

  // Одобренная очередь тоже раскладывается планировщиком, а не по номеру
  // карточки. Редактор решает, ЧТО достойно канала; порядок - забота
  // ленты. Раньше одобренные шли строго по id, и все правила чередования
  // работали только в автопостинге: 12.08 подряд вышли два кадра
  // Бундесархива, хотя в очереди ждал британский.
  //
  // И один общий пул с резервом (см. APPROVED_PRIORITY): так же решает
  // публикатор, иначе предпросмотр врал бы о порядке
  const approvedIds = new Set(input.approved.map((c) => c.id));
  const pool: PlanCandidate[] = [
    ...input.approved.map((c) => ({
      ...c,
      priority: (c.priority ?? 0) + approvedPriority(c.created_at, input.now),
    })),
    ...(input.autoPublish ? input.reserve : []),
  ];
  const want = Math.max(input.approved.length, count - entries.length);
  const bySlot: Array<{ candidate: PlanCandidate; kind: PlanKind }> = planAuto(
    pool,
    input.recent,
    want,
  ).map((c) => ({
    candidate: c,
    kind: approvedIds.has(c.id) ? ("approved" as const) : ("auto" as const),
  }));

  const slots = upcomingSlots(input, bySlot.length);
  bySlot.forEach((item, i) => {
    const slot = slots[i];
    entries.push({
      candidate: item.candidate,
      kind: item.kind,
      when: slot?.label ?? "когда освободится слот",
      due: slot?.due ?? false,
    });
  });

  return entries.slice(0, count);
}
