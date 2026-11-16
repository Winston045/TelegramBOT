/**
 * Сетка рубрик (редакция 16.11): «доработки существующей системы не
 * работают - нужна новая».
 *
 * Прежний планировщик собирал всё, что дают архивы, а разнообразие
 * наводил при публикации штрафами и бонусами. Выбирать он мог только из
 * резерва, и когда резерв худел, правила ослаблялись по лестнице - одно и
 * то же просачивалось снова (два поста с пленными за три дня, 14 и
 * 16.11). Сетка переворачивает порядок: сначала решено, что выходит за
 * неделю, потом под это собирается материал.
 *
 * - у каждого поста ровно одна рубрика ленты (FEED_RUBRICS) и доля в неделе;
 * - слот берёт рубрика с самым большим недобором за 7 дней, внутри неё -
 *   лучший кадр; одна рубрика два раза подряд не идёт;
 * - тяжёлые темы (MARKS) и события - жёсткие лимиты, а не штрафы: оценка
 *   их не перебивает;
 * - ручное (одобренное, «Следующим») сильнее сетки.
 *
 * Файл без импортов: общий для Node и Deno. То, что живёт в plan.ts
 * (ключи событий, страна поста), передаётся параметрами.
 */

export type FeedRubric = {
  key: string;
  /** как рубрика называется в сводке */
  label: string;
  /** определение для модели */
  hint: string;
  /** постов в неделю при 21 посте (3 в день); пересчитывается от расписания */
  perWeek: number;
};

/**
 * Порядок - приоритет, когда кадр подходит в несколько рубрик: выше стоит
 * более редкая. Советский танк в подлинном цвете - «цвет эпохи», а не
 * «техника на земле»: цветных кадров в архивах в разы меньше.
 */
export const FEED_RUBRICS: FeedRubric[] = [
  { key: "color", label: "цвет эпохи", hint: "подлинный цветной снимок эпохи (не раскраска)", perWeek: 1 },
  { key: "event", label: "знаковое событие", hint: "кадр из события, которое знают все: битва, парад Победы, высадка, полёт в космос, катастрофа", perWeek: 2 },
  { key: "person", label: "человек и судьба", hint: "конкретный человек в кадре и его история: кто он, что с ним было", perWeek: 3 },
  { key: "oddity", label: "диковина", hint: "странная техника, курьёз, редкость, находчивость", perWeek: 2 },
  { key: "coldwar", label: "холодная война", hint: "кадр 1946-1991 годов: армии, кризисы и войны холодной войны (Корея, Вьетнам, Афганистан)", perWeek: 1 },
  { key: "ground", label: "техника на земле", hint: "танки, САУ, бронемашины, орудия, тягачи - техника главная в кадре", perWeek: 3 },
  { key: "aviation", label: "авиация", hint: "самолёты, вертолёты, аэродромы, лётчики у машин", perWeek: 2 },
  { key: "navy", label: "флот", hint: "корабли, подлодки, катера, моряки на борту", perWeek: 2 },
  { key: "combat", label: "бой и пехота", hint: "пехота в бою и на марше, расчёты, окопы, штурм", perWeek: 2 },
  { key: "rear", label: "тыл и быт", hint: "тыл, заводы, госпитали, повседневность армии и людей вокруг войны", perWeek: 2 },
  { key: "city", label: "город и разрушения", hint: "город на войне: улицы, руины, последствия бомбёжек", perWeek: 1 },
  { key: "poster", label: "плакат", hint: "плакат, карикатура, документ эпохи", perWeek: 0.5 },
];

const FEED_KEYS = new Set(FEED_RUBRICS.map((r) => r.key));
const FEED_ORDER = new Map(FEED_RUBRICS.map((r, i) => [r.key, i]));

export function feedLabel(key: string): string {
  return FEED_RUBRICS.find((r) => r.key === key)?.label ?? key;
}

/** Ключ рубрики из ответа модели; незнакомое - undefined. */
export function normalizeFeed(value: unknown): string | undefined {
  const v = typeof value === "string" ? value.trim().toLowerCase() : "";
  return FEED_KEYS.has(v) ? v : undefined;
}

/**
 * Тяжёлые темы - метка поверх рубрики, с жёстким лимитом (редакция 16.11):
 * пленные не чаще раза в 14 дней, вожди - раза в 7, руины - не больше
 * двух за 7 дней. Метка ставится и моделью, и простым правилом по тексту
 * подписи и тегам: сработало хоть одно - лимит включается.
 */
export type Mark = {
  key: string;
  label: string;
  hint: string;
  /** не чаще одного поста за столько дней */
  gapDays?: number;
  /** или не больше count постов за days дней */
  cap?: { count: number; days: number };
  /** узнать по тексту подписи */
  text?: RegExp;
  /** узнать по теме кадра (tags.subject) */
  subjects?: string[];
};

export const MARKS: Mark[] = [
  {
    key: "pow",
    label: "пленные",
    hint: "военнопленные - главное в кадре",
    gapDays: 14,
    text: /военнопленн|пленн(?:ые|ых|ого|ый|ая|ой|ым|ыми|ому|ику|ики|иков)|(?:^|[^\p{L}])(?:в|из) плен(?:у|а)?(?:$|[^\p{L}])/iu,
    subjects: ["pow"],
  },
  {
    key: "leader",
    label: "вожди",
    hint: "вождь, политик или генерал - главный герой кадра",
    gapDays: 7,
    subjects: ["leader"],
  },
  {
    key: "ruins",
    label: "руины",
    hint: "разрушенный город, дома в руинах - главное в кадре",
    cap: { count: 2, days: 7 },
    text: /руин|развалин|разрушенн\S* (?:город|улиц|квартал|дом|здани|церк|собор)/iu,
  },
];

const MARK_KEYS = new Set(MARKS.map((m) => m.key));

export type FeedTags = {
  feed?: string;
  marks?: string[];
  subject?: string;
  story?: string;
  color?: boolean;
  period?: string;
  rubric?: string;
} | null | undefined;

const COLD_WAR = new Set(["cold_war", "korea", "vietnam", "afghanistan"]);

/**
 * Рубрика по прежним тегам - для кадров, разобранных до сетки, и когда
 * модель вернула незнакомую рубрику. Порядок проверок - тот же приоритет,
 * что у FEED_RUBRICS.
 */
export function inferFeed(tags: FeedTags): string {
  const t = tags ?? {};
  const subject = t.subject ?? "";
  const story = t.story ?? "";
  if (t.color === true) return "color";
  if (t.rubric === "poster" || subject === "poster" || story === "poster") return "poster";
  if (story === "landmark" || story === "science") return "event";
  if (story === "human" || story === "twist" || t.rubric === "culture") return "person";
  if (story === "oddity") return "oddity";
  if (t.period && COLD_WAR.has(t.period)) return "coldwar";
  if (subject === "armor" || subject === "artillery") return "ground";
  if (subject === "aviation") return "aviation";
  if (subject === "navy") return "navy";
  if (subject === "portrait" || subject === "leader") return "person";
  if (subject === "homefront" || subject === "medicine" || story === "daily" || t.rubric === "social" || t.rubric === "ussr_daily") return "rear";
  if (subject === "street" || story === "disaster") return "city";
  return "combat";
}

/** Рубрика кадра: от модели, иначе по тегам. */
export function feedOf(c: { tags?: FeedTags }): string {
  return normalizeFeed(c.tags?.feed) ?? inferFeed(c.tags);
}

/** Метки тяжёлых тем: от модели, по теме кадра и по тексту подписи. */
export function marksOf(c: { tags?: FeedTags; caption_html?: string | null }): string[] {
  const out = new Set<string>();
  for (const m of c.tags?.marks ?? []) if (MARK_KEYS.has(m)) out.add(m);
  const text = (c.caption_html ?? "").replace(/<[^>]+>/g, " ");
  for (const m of MARKS) {
    if (m.subjects?.includes(c.tags?.subject ?? "")) out.add(m.key);
    if (m.text?.test(text)) out.add(m.key);
  }
  return [...out];
}

export function normalizeMarks(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string" && MARK_KEYS.has(v.trim().toLowerCase())).map((v) => v.trim().toLowerCase());
}

/** Строка схемы JSON для промпта анализа (поля внутри tags). */
export const FEED_SCHEMA = `"feed": "<рубрика ленты: ${FEED_RUBRICS.map((r) => `"${r.key}"`).join(" | ")}>", "marks": [<метки тяжёлых тем, обычно пусто: ${MARKS.map((m) => `"${m.key}"`).join(" | ")}>]`;

/** Определения рубрик и меток для промпта. */
export function feedGuide(): string {
  return [
    "tags.feed - рубрика ленты, ровно одна. Если кадр подходит в несколько, бери ту, что выше в списке:",
    ...FEED_RUBRICS.map((r) => `- ${r.key}: ${r.hint}`),
    "tags.marks - метки тяжёлых тем, только если это ГЛАВНОЕ в кадре (пленный на заднем плане - не метка):",
    ...MARKS.map((m) => `- ${m.key}: ${m.hint}`),
  ].join("\n");
}

/** Норма рубрик на неделю при заданном числе постов в неделю. */
export function weeklyTargets(postsPerWeek: number): Map<string, number> {
  const total = FEED_RUBRICS.reduce((s, r) => s + r.perWeek, 0);
  return new Map(FEED_RUBRICS.map((r) => [r.key, (r.perWeek / total) * postsPerWeek]));
}

/** Вышедший пост - всё, что сетке нужно о нём помнить. Свежие первыми. */
export type FeedPost = {
  feed: string;
  marks: string[];
  nation: string;
  events: string[];
  /** ISO-время публикации */
  at: string;
};

export type GridCandidate = {
  id: number;
  caption_html: string | null;
  score?: number | null;
  tags?: (FeedTags & { event_wiki?: string; subject?: string }) | null;
  priority?: number;
  attribution?: string | null;
  source?: string | null;
};

export type GridHelpers<C> = {
  now: Date;
  /** страна поста (plan.ts: postNation) */
  nationOf: (c: C) => string;
  /** ключи события (plan.ts: eventKeys) */
  eventsOf: (c: C) => string[];
  /** своя страна получает добавку внутри рубрики */
  homeNation?: string;
  /** сколько постов в неделю по расписанию - для нормы рубрик */
  postsPerWeek?: number;
  /** кадр взят с ослабленными мягкими правилами */
  onFallback?: (c: C) => void;
};

/** Память событий и меток - 14 дней. */
export const FEED_MEMORY_DAYS = 14;
/** Одна страна - не больше стольких постов на окно из NATION_SPAN подряд. */
export const NATION_MAX = 2;
export const NATION_SPAN = 6;
/** Своя страна внутри рубрики: добавка к оценке при выборе лучшего. */
export const GRID_HOME_BONUS = 8;

const DAY = 86_400_000;

/** Детерминированный «случай» на день: порядок рубрик при равном недоборе. */
function dayHash(key: string, now: Date): number {
  const s = `${now.toISOString().slice(0, 10)}|${key}`;
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967296;
}

/** Нарушает ли метка лимит при данной истории (свежие первыми). */
export function markBlocked(mark: string, history: FeedPost[], now: Date): boolean {
  const rule = MARKS.find((m) => m.key === mark);
  if (!rule) return false;
  if (rule.gapDays) {
    const since = now.getTime() - rule.gapDays * DAY;
    if (history.some((p) => p.marks.includes(mark) && Date.parse(p.at) >= since)) return true;
  }
  if (rule.cap) {
    const since = now.getTime() - rule.cap.days * DAY;
    const n = history.filter((p) => p.marks.includes(mark) && Date.parse(p.at) >= since).length;
    if (n >= rule.cap.count) return true;
  }
  return false;
}

export type GridReason = { id: number; feed: string; why: string };

/**
 * Подбор по сетке на count слотов вперёд. Каждый выбранный пост сразу
 * становится частью истории - предпросмотр и публикация считают одинаково.
 *
 * 1. Одобренные (priority > 0) - ручное сильнее сетки, идут первыми как есть.
 * 2. Жёсткие лимиты: событие и тяжёлые метки не перебиваются ничем.
 * 3. Мягкие правила: рубрика не повторяется подряд, страна - не больше
 *    NATION_MAX на NATION_SPAN. Если под них не подходит никто - снимаются
 *    (onFallback), жёсткие остаются; пустой слот только когда нарушил бы
 *    жёсткий лимит любой кадр.
 * 4. Из допустимых: рубрика с наибольшим недобором за 7 дней, внутри -
 *    лучшая оценка (+ своя страна).
 */
export function planGrid<C extends GridCandidate>(
  pool: C[],
  history: FeedPost[],
  count: number,
  h: GridHelpers<C>,
  reasons?: GridReason[],
): C[] {
  const now = h.now;
  const hist = [...history];
  const left = [...pool];
  const out: C[] = [];
  const perWeek = h.postsPerWeek ?? 21;
  const targets = weeklyTargets(perWeek);

  const toPost = (c: C): FeedPost => ({
    feed: feedOf(c),
    marks: marksOf(c),
    nation: h.nationOf(c),
    events: h.eventsOf(c),
    at: now.toISOString(),
  });

  // ручное - вперёд, в порядке яруса, затем оценки
  const manual = left
    .filter((c) => (c.priority ?? 0) > 0)
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || (b.score ?? 0) - (a.score ?? 0) || a.id - b.id);
  for (const c of manual) {
    if (out.length >= count) break;
    out.push(c);
    left.splice(left.indexOf(c), 1);
    hist.unshift(toPost(c));
    reasons?.push({ id: c.id, feed: feedOf(c), why: "ручное: одобрено редактором" });
  }

  while (out.length < count && left.length) {
    const memory = now.getTime() - FEED_MEMORY_DAYS * DAY;
    const events = new Set(hist.filter((p) => Date.parse(p.at) >= memory).flatMap((p) => p.events));
    const hard = left.filter(
      (c) => !h.eventsOf(c).some((k) => events.has(k)) && !marksOf(c).some((m) => markBlocked(m, hist, now)),
    );
    if (!hard.length) break;

    const lastFeed = hist[0]?.feed;
    const recentNations = hist.slice(0, NATION_SPAN - 1).map((p) => p.nation);
    const soft = hard.filter((c) => {
      if (feedOf(c) === lastFeed) return false;
      const n = h.nationOf(c);
      return !n || recentNations.filter((x) => x === n).length < NATION_MAX;
    });
    const usable = soft.length ? soft : hard;
    const relaxed = !soft.length;

    // недобор рубрик за 7 дней с учётом этого слота
    const week = hist.filter((p) => Date.parse(p.at) >= now.getTime() - 7 * DAY);
    const scale = (week.length + 1) / perWeek;
    const counts = new Map<string, number>();
    for (const p of week) counts.set(p.feed, (counts.get(p.feed) ?? 0) + 1);
    const byFeed = new Map<string, C[]>();
    for (const c of usable) {
      const f = feedOf(c);
      byFeed.set(f, [...(byFeed.get(f) ?? []), c]);
    }
    const feeds = [...byFeed.keys()].sort((a, b) => {
      const da = (targets.get(a) ?? 0) * scale - (counts.get(a) ?? 0);
      const db = (targets.get(b) ?? 0) * scale - (counts.get(b) ?? 0);
      return db - da || dayHash(a, now) - dayHash(b, now) || (FEED_ORDER.get(a) ?? 0) - (FEED_ORDER.get(b) ?? 0);
    });
    const feed = feeds[0]!;
    const gridScore = (c: C) => (c.score ?? 0) + (h.homeNation && h.nationOf(c) === h.homeNation ? GRID_HOME_BONUS : 0);
    const pick = [...byFeed.get(feed)!].sort((a, b) => gridScore(b) - gridScore(a) || a.id - b.id)[0]!;

    if (relaxed) h.onFallback?.(pick);
    const deficit = (targets.get(feed) ?? 0) * scale - (counts.get(feed) ?? 0);
    reasons?.push({
      id: pick.id,
      feed,
      why: `${feedLabel(feed)}: за неделю ${counts.get(feed) ?? 0} при норме ${((targets.get(feed) ?? 0) * scale).toFixed(1)} (недобор ${deficit.toFixed(1)})${relaxed ? "; мягкие правила сняты" : ""}`,
    });
    out.push(pick);
    left.splice(left.indexOf(pick), 1);
    hist.unshift(toPost(pick));
  }
  return out;
}

/** Запас рубрик в резерве и недобор на неделю вперёд - для сбора и сводки. */
export function feedDeficits(
  reserve: Array<{ tags?: FeedTags }>,
  postsPerWeek: number,
): Array<{ key: string; label: string; stock: number; need: number; deficit: number; full: boolean }> {
  const targets = weeklyTargets(postsPerWeek);
  const stock = new Map<string, number>();
  for (const c of reserve) stock.set(feedOf(c), (stock.get(feedOf(c)) ?? 0) + 1);
  return FEED_RUBRICS.map((r) => {
    const need = targets.get(r.key) ?? 0;
    const have = stock.get(r.key) ?? 0;
    return {
      key: r.key,
      label: r.label,
      stock: have,
      need,
      deficit: Math.max(0, need - have),
      // потолок запаса: полторы недельные нормы, выше - не ищем
      full: have >= Math.max(1, need * 1.5),
    };
  });
}

/** Режим сетки: on - публикует, shadow - пишет в лог, что выбрала бы, off - выключена. */
export type FeedMode = "on" | "shadow" | "off";
/** По умолчанию - тень: два дня сравнения со старым планировщиком (16.11). */
export const FEED_MODE_DEFAULT: FeedMode = "shadow";

export function normalizeFeedMode(value: unknown): FeedMode {
  return value === "on" || value === "off" || value === "shadow" ? value : FEED_MODE_DEFAULT;
}

/** История для сетки из вышедших постов (любой порядок на входе) - свежие первыми. */
export function feedHistory<R extends { tags?: FeedTags; caption_html?: string | null; published_at?: string | null }>(
  rows: R[],
  nationOf: (r: R) => string,
  eventsOf: (r: R) => string[],
): FeedPost[] {
  return rows
    .filter((r) => r.published_at)
    .map((r) => ({
      feed: feedOf(r),
      marks: marksOf(r),
      nation: nationOf(r),
      events: eventsOf(r),
      at: r.published_at as string,
    }))
    .sort((a, b) => b.at.localeCompare(a.at));
}
