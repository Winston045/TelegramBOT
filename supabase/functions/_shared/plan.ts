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
  /** Статья о знаковом событии кадра (analyze.ts): ключ правила «событие раз в неделю». */
  event_wiki?: string;
  /** Тип сюжета (_shared/story.ts): «про что» пост - по нему сетка ленты. */
  story?: string;
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
 *
 * Было 10, стало 14 (15.11): запас поднят до недели (DAYS_OF_BUFFER в
 * src/reserve.ts), и при десяти днях годности часть недельного запаса
 * сгорала бы раньше своей очереди - квота Gemini впустую.
 */
export const RESERVE_TTL_DAYS = 14;

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
 * Сколько последних постов нужно планировщику целиком: самое длинное окно
 * соседства - у малых стран (SECONDARY_NATION_WINDOW). Темы, статика и
 * изюминки по-прежнему считаются по RECENT_WINDOW.
 */
export const HISTORY_WINDOW = 8;
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
/**
 * Было 2 (архив - через пост). Разбор 15.11, «Венгрия, нидерландские
 * солдаты, всё по кругу»: у малых архивов одна-две темы (Fortepan -
 * Будапешт-1956, Anefo - голландские военные), и раз в три поста они
 * возвращались с тем же сюжетом. Пять постов - архив не чаще раза в
 * два дня.
 */
export const ARCHIVE_WINDOW = 5;
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
 * США - отдельная планка (редакция 27.10: «очень много США»). Разборы
 * 22.10 и 26.10: американцы 27-29% ленты при общем правиле «раз в три
 * поста, до 20% недели». Американских поставщиков больше всех (LOC,
 * NARA, Signal Corps, флот, ВВС, плакаты), и общее правило их не держит:
 * кадров много, и они честно занимают каждое третье место. Для США -
 * не чаще раза в пять постов и не больше десятой части недели.
 */
export const LIMITED_NATIONS: Record<string, { window: number; softShare: number }> = {
  usa: { window: 5, softShare: 0.1 },
};

/**
 * Главные участники войн XX века: их материал разнообразен (фронты,
 * годы, рода войск), для них хватает общего окна в три поста.
 */
export const MAJOR_NATIONS = new Set(["germany", "uk"]);
/**
 * Остальные страны - Венгрия, Нидерланды, Финляндия, Польша, Бельгия -
 * приходят из одного-двух малых архивов с узким набором сюжетов. Разбор
 * 15.11: Венгрия пять раз за 19 дней (все пять - Будапешт-1956),
 * голландские военные 13.11 и 14.11. Читатель видит круг уже через
 * день-два, поэтому для них окно - восемь постов, почти три дня.
 */
export const SECONDARY_NATION_WINDOW = 8;

/** Окно соседства для страны: своё - через пост, США - раз в пять, малые - раз в восемь. */
export function nationWindow(nation: string): number {
  if (nation === HOME_NATION) return HOME_NATION_WINDOW;
  const limited = LIMITED_NATIONS[nation]?.window;
  if (limited) return limited;
  return MAJOR_NATIONS.has(nation) ? NATION_WINDOW : SECONDARY_NATION_WINDOW;
}

/** Доля недели без штрафа для страны. */
export function nationSoftShare(nation: string): number {
  if (nation === HOME_NATION) return HOME_SHARE_SOFT;
  return LIMITED_NATIONS[nation]?.softShare ?? NATION_SHARE_SOFT;
}

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
/**
 * Сетка ленты по типам сюжетов (редакция 15.11). Разбор 60 постов:
 * «будни армии» - 48% ленты (солдаты строят блиндаж, расчёт ведёт огонь),
 * «человек» - 6%, «поворот» - ни одного. Источников сорок, а сюжет один.
 *
 * - «будни армии» - не чаще раза в SERVICE_WINDOW постов (раз в день
 *   при трёх слотах);
 * - история про человека, поворот и знаковое событие - фора в очереди:
 *   при равном качестве такой пост выходит первым, и в день находится
 *   хотя бы один, если резерв их держит;
 * - «будни армии» уступают при равном качестве.
 */
export const HEADLINE_STORIES = new Set(["human", "twist", "landmark"]);
export const STORY_BONUS = 10;
export const SERVICE_PENALTY = 6;
export const SERVICE_WINDOW = 3;

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
  const nationSoft = nation ? nationSoftShare(nation) : NATION_SHARE_SOFT;
  const nationOver = nShare > nationSoft ? (nShare - nationSoft) * NATION_SHARE_PENALTY : 0;
  const story = c.tags?.story;
  const storyBonus = story && HEADLINE_STORIES.has(story) ? STORY_BONUS : 0;
  const servicePenalty = story === "service" ? SERVICE_PENALTY : 0;
  return (
    (c.score ?? 0) +
    storyBonus -
    servicePenalty +
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
 * Строки места, которые называют страну, фронт или стихию, а не место
 * события: «СССР, 1942 год» - это сотни разных кадров, а не одно событие.
 */
const BROAD_PLACE =
  /^(ссср|сша|россия|германия|франция|италия|польша|финляндия|великобритания|англия|нидерланды|бельгия|венгрия|австрия|австро-венгрия|чехословакия|югославия|румыния|греция|норвегия|дания|япония|китай|корея|вьетнам|бирма|индия|египет|ливия|тунис|израиль|канада|австралия|антарктида|арктика|европа|азия|африка|северная африка|восточная европа|карелия|прибалтика|украина|белоруссия)$|фронт|океан|море|залив|пролив/;

/**
 * Сколько дней помним событие вышедшего поста. Было 7 (неделя) - и
 * разбор ленты 15.11 нашёл Будапешт-1956 четыре раза за две недели
 * (29.10, 01.11, 06.11, 12.11): каждый повтор выходил на 8-й день или
 * проскакивал по ключу (см. eventKeys). Две недели - читатель ещё
 * помнит прошлый пост, повтор ощущается как «зацикленность».
 */
export const EVENT_MEMORY_DAYS = 14;

/**
 * Ключи события кадра: статья о событии И город с годом из строки места
 * («будапешт|1956») - оба сразу. Совпадение по любому - то же событие.
 *
 * Редакция 08.11: три поста про Будапешт-1956 за неделю - ИС-3, БТР-40 и
 * гаубица. Тогда ключ был один: статья, а без неё - город. Разбор 15.11:
 * Севастополь-1944 вышел 13.11 и 14.11 подряд, Вена-1945 - 04.11 и 09.11.
 * У одного поста была статья о событии, у другого - нет (или другая
 * статья о том же), ключи не сошлись, и правило молчало.
 */
export function eventKeys(c: { tags?: PlanTags; caption_html?: string | null }): string[] {
  const keys: string[] = [];
  const wiki = c.tags?.event_wiki?.trim().toLowerCase();
  if (wiki) keys.push(wiki);
  const quotes = [...(c.caption_html ?? "").matchAll(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/g)]
    .map((m) => (m[1] ?? "").replace(/<[^>]+>/g, "").trim())
    // строка места - короткая и с годом; изюминка длинная
    .filter((q) => q.length <= 70 && /(1[89]|20)\d{2}/.test(q));
  const line = quotes.at(-1);
  if (!line) return keys;
  const year = line.match(/(1[89]|20)\d{2}/)?.[0];
  const place = (line.split(/[,.]/)[0] ?? "").trim().toLowerCase().replace(/ё/g, "е");
  if (!year || !place || /\d/.test(place) || BROAD_PLACE.test(place)) return keys;
  keys.push(`${place}|${year}`);
  return keys;
}

/** Главный ключ события (статья, иначе город и год) - для отчётов. */
export function eventKey(c: { tags?: PlanTags; caption_html?: string | null }): string {
  return eventKeys(c)[0] ?? "";
}

/** Все ключи событий постов - память правила «одно событие раз в две недели». */
export function recentEvents(
  rows: Array<{ tags?: PlanTags; caption_html?: string | null }>,
): string[] {
  return rows.flatMap((r) => eventKeys(r));
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
  weekEvents: string[];
} {
  const archiveShare: Record<string, number> = {};
  const periodShare: Record<string, number> = {};
  const subjectShare: Record<string, number> = {};
  const nationShare: Record<string, number> = {};
  // рубрики считаем штуками, а не долями: потолок у них недельный и в постах
  const rubricWeek: Record<string, number> = {};
  const weekEvents = recentEvents(rows);
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
  return { archiveShare, periodShare, subjectShare, nationShare, rubricWeek, weekEvents };
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
  /** Типы сюжетов последних постов, свежие первыми ("" - без разметки). */
  stories?: string[];
  /** Сколько постов каждой рубрики вышло за неделю: {"poster": 1}. */
  rubricWeek?: Record<string, number>;
  /**
   * Ключи событий постов за EVENT_MEMORY_DAYS (recentEvents): одно
   * событие - не чаще раза в две недели. Имя осталось с недельных времён.
   */
  weekEvents?: string[];
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
  /**
   * Сообщить, что кадр взят аварийным добором (под правила не подошёл
   * никто). Разбор 15.11: второй Севастополь-1944 вышел именно добором,
   * а в логе публикатора этого не было видно.
   */
  onFallback?: (pick: PlanCandidate) => void,
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
  const stories = [...(recent.stories ?? [])];
  const rubricWeek: Record<string, number> = { ...(recent.rubricWeek ?? {}) };
  // события недели: план не повторяет ни их, ни свои же
  const events = new Set(recent.weekEvents ?? []);
  // рубрика, выбравшая недельный потолок, не выходит НИКАК - ни по
  // правилам, ни аварийным добором: плакат дважды за неделю - это уже не
  // рубрика, а смена профиля канала
  const repeatsEvent = (c: PlanCandidate) => eventKeys(c).some((k) => events.has(k));
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
    /**
     * relax - насколько правила отпущены, когда под все не подходит никто
     * (лестница добора, разбор 15.11):
     * 0 - все правила;
     * 1 - без статики, изюминок, мирных кадров и вождей подряд;
     * 2 - и без смены темы, эпохи и рубрики;
     * 3 - и без окна архива.
     * Событие, страна и потолки рубрик держатся на всех ступенях: именно
     * они дают «по кругу» - Венгрия, голландские солдаты, Севастополь.
     */
    const fits = (c: PlanCandidate, relax = 0) => {
      if (overCap(c)) return false;
      // одно событие - не чаще раза в две недели (Будапешт-1956 ×4 за 14 дней)
      if (repeatsEvent(c)) return false;
      // две рубрики подряд не идут: между ними - военное ядро
      if (relax < 2 && c.tags?.rubric && rubrics[0]) return false;
      const subject = c.tags?.subject;
      if (relax < 2 && subject && subjects.slice(0, RECENT_WINDOW).includes(subject)) return false;
      if (relax < 1 && c.tags?.military === false && civiliansInWindow >= MAX_CIVILIAN_IN_WINDOW)
        return false;
      // статика допустима, но редко: лента должна дышать движением
      if (relax < 1 && c.tags?.action === false && staticsInWindow >= MAX_STATIC_IN_WINDOW)
        return false;
      // развёрнутая цитата - изюминка: длинные посты не идут подряд
      if (
        relax < 1 &&
        quoteLength(c.caption_html ?? null) >= LONG_QUOTE &&
        longsInWindow >= MAX_LONG_IN_WINDOW
      )
        return false;
      // лента не должна неделями сидеть в одном году - эпохи чередуются
      if (relax < 2 && stuckPeriod && c.tags?.period === stuckPeriod) return false;
      // вожди - редкая краска, а не каждый второй пост
      if (
        relax < 1 &&
        c.tags?.subject === "leader" &&
        subjects.slice(0, RECENT_WINDOW).filter((s) => s === "leader").length >=
          MAX_LEADERS_IN_WINDOW
      ) {
        return false;
      }
      // сетка ленты: «будни армии» не чаще раза в SERVICE_WINDOW постов -
      // держится до последней ступени лестницы вместе с окном архива
      if (
        relax < 3 &&
        c.tags?.story === "service" &&
        stories.slice(0, SERVICE_WINDOW - 1).includes("service")
      ) {
        return false;
      }
      // и не должна быть витриной одного архива: «одни немцы», «одни британцы»
      const archive = archiveKey(c.attribution) || (c.source ?? "");
      if (
        relax < 3 &&
        archive &&
        archives.slice(0, ARCHIVE_WINDOW).filter((a) => a === archive).length >=
          MAX_SAME_ARCHIVE_IN_WINDOW
      ) {
        return false;
      }
      // то же по стране архива - иначе перекос просто меняет флаг
      const nation = postNation(c);
      if (
        nation &&
        nations.slice(0, nationWindow(nation)).filter((n) => n === nation).length >=
          MAX_SAME_NATION_IN_WINDOW
      ) {
        return false;
      }
      return true;
    };
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
    /** Лучший из допустимых по цепочке предпочтений; -1 - допустимых нет. */
    const byPrefs = (allowed: (c: PlanCandidate) => boolean): number => {
      for (const pref of prefs) {
        const i = pool.findIndex((c) => allowed(c) && pref(c));
        if (i !== -1) return i;
      }
      return pool.findIndex(allowed);
    };
    // США в окне соседства не выходят и аварийным добором: резерв
    // 27.10 был наполовину из одобренных Signal Corps, и добор ставил
    // американцев через пост. Лучше пустой слот и сигнал сторожу
    // собрать свежего, чем снова «канал про США»
    // и повтор события - тоже: «зацикленность» читатель замечает
    // сильнее пустого слота (разбор 15.11: Севастополь-1944 два дня подряд)
    const blocked = (c: PlanCandidate) => {
      if (overCap(c)) return true;
      if (repeatsEvent(c)) return true;
      const n = postNation(c);
      return (
        Boolean(LIMITED_NATIONS[n]) &&
        nations.slice(0, nationWindow(n)).filter((x) => x === n).length >= MAX_SAME_NATION_IN_WINDOW
      );
    };

    let idx = pool.findIndex((c) => fits(c));
    // лестница добора (разбор 15.11): отпускаем мелкие правила по одному,
    // а окна страны и события держим до последнего - добор, не глядевший
    // на них, и крутил «Венгрию и нидерландских солдат по кругу»
    for (let relax = 1; idx === -1 && relax <= 3; relax++) {
      idx = relax === 1 ? pool.findIndex((c) => fits(c, 1)) : byPrefs((c) => fits(c, relax));
    }
    // последняя ступень - прежний добор: держит только США, рубрики и события
    if (idx === -1) idx = byPrefs((c) => !blocked(c));
    // в пуле остались только рубрики сверх потолка, США в окне или
    // повторы событий - слот лучше оставить
    if (idx === -1) break;
    if (!fits(pool[idx]!)) onFallback?.(pool[idx]!);
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
    stories.unshift(pick.tags?.story ?? "");
    if (pick.tags?.rubric) rubricWeek[pick.tags.rubric] = (rubricWeek[pick.tags.rubric] ?? 0) + 1;
    for (const k of eventKeys(pick)) events.add(k);
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
