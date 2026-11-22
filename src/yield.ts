/**
 * Выход архива - какая доля его кадров, дошедших до анализа, прошла сито.
 * По нему очередь анализа решает, кому первым достаётся квота Gemini.
 *
 * Разбор 15.11 (бот на автопилоте, редакция в него не заходит): анализов
 * в день 6-15 - столько пускает бесплатная квота, годных из них около
 * трёх, ровно расход канала. Запаса нет, планировщику не из чего выбирать,
 * и лента повторяет то, что сбор принёс в этот день. При этом выход
 * архивов разный в десятки раз: Зельма 3 из 3, Шайхет 5 из 6, Халдей и
 * IWM 6 из 10 - а Europeana 1914-1918 1 из 28, Agence Rol 4 из 22,
 * НБ Ирландии 2 из 13. Очередь чередовала архивы поровну, и первые
 * десять мест (дальше квота кончается) доставались кому попало.
 *
 * Вес - это только порядок: слабый архив не выключается, он уходит в
 * хвост. Новый или редкий архив получает средний выход - шанс у него есть.
 */
import { getDb, selectAll } from "./db.js";
import { RESERVE_TTL_DAYS, archiveKey } from "./plan.js";
import { feedDeficits, feedOf, isEditorReject, type FeedTags } from "./feed.js";

/** За сколько дней считаем выход. */
export const YIELD_DAYS = 30;
/** Сила априорного среднего: столько «воображаемых» кадров со средним выходом. */
export const YIELD_PRIOR = 5;
/** Вес не ниже и не выше: хвост не умирает, лидер не забирает всю очередь. */
export const MIN_WEIGHT = 0.3;
export const MAX_WEIGHT = 1.5;

const PASSED = new Set(["new", "shown", "approved", "published"]);

export type YieldRow = {
  status: string;
  caption_html?: string | null;
  attribution?: string | null;
  source?: string | null;
  tags?: FeedTags;
  created_at?: string | null;
};

/**
 * Сбор под заказ (сетка рубрик, 16.11): архив, чьи прошедшие кадры чаще
 * попадают в рубрики с недобором в резерве, получает добавку к весу;
 * архив, кормящий переполненные рубрики, - скидку. Квота Gemini уходит
 * туда, где не хватает, а не на десятый танк. Множитель в этих рамках.
 */
export const FEED_MIN_FACTOR = 0.6;
export const FEED_MAX_FACTOR = 1.6;

/**
 * Веса архивов по истории анализа: сглаженный выход архива, делённый на
 * общий выход. 1 - средний архив, меньше - хвост очереди, больше - голова.
 */
export function archiveWeights(rows: YieldRow[], deficits?: Map<string, number>): Map<string, number> {
  const stats = new Map<string, { n: number; ok: number }>();
  let total = 0;
  let passed = 0;
  for (const r of rows) {
    // failed - сбой подписи или сети, а не свойство архива
    if (r.status === "failed") continue;
    const key = archiveKey(r.attribution) || r.source || "";
    if (!key) continue;
    const s = stats.get(key) ?? { n: 0, ok: 0 };
    s.n++;
    total++;
    // удалённое редакцией - двойной промах: кадр прошёл сито, но в канал не
    // годился (разбор 22.11: эстраду Anefo удаляли 11 раз из 13)
    if (isEditorReject(r)) {
      s.n++;
      total++;
    }
    if (PASSED.has(r.status)) {
      s.ok++;
      passed++;
    }
    stats.set(key, s);
  }
  // в какие рубрики ленты уходят прошедшие кадры архива
  const feeds = new Map<string, Map<string, number>>();
  const feedAll = new Map<string, number>();
  let passedAll = 0;
  for (const r of rows) {
    if (!PASSED.has(r.status)) continue;
    const key = archiveKey(r.attribution) || r.source || "";
    if (!key) continue;
    const f = feedOf(r);
    const m = feeds.get(key) ?? new Map<string, number>();
    m.set(f, (m.get(f) ?? 0) + 1);
    feeds.set(key, m);
    feedAll.set(f, (feedAll.get(f) ?? 0) + 1);
    passedAll++;
  }
  // доля рубрики в общем недоборе: 0 - рубрика сыта, не ищем
  const needTotal = deficits ? [...deficits.values()].reduce((a, b) => a + b, 0) : 0;
  const value = (m: Map<string, number> | undefined, n: number, prior: number) => {
    let v = 0;
    for (const [f, d] of deficits ?? []) {
      const pAll = passedAll ? (feedAll.get(f) ?? 0) / passedAll : 0;
      const p = ((m?.get(f) ?? 0) + prior * pAll) / (n + prior);
      v += p * (d / needTotal);
    }
    return v;
  };
  const feedMean = needTotal > 0 && passedAll ? value(feedAll, passedAll, 0) : 0;

  const weights = new Map<string, number>();
  if (!total) return weights;
  const mean = passed / total;
  if (mean <= 0) return weights;
  for (const [key, s] of stats) {
    const smoothed = (s.ok + YIELD_PRIOR * mean) / (s.n + YIELD_PRIOR);
    let w = Math.min(MAX_WEIGHT, Math.max(MIN_WEIGHT, smoothed / mean));
    if (feedMean > 0) {
      const m = feeds.get(key);
      const n = m ? [...m.values()].reduce((a, b) => a + b, 0) : 0;
      w *= Math.min(FEED_MAX_FACTOR, Math.max(FEED_MIN_FACTOR, value(m, n, YIELD_PRIOR) / feedMean));
    }
    weights.set(key, Math.round(w * 100) / 100);
  }
  return weights;
}

/** Веса архивов по выходу за YIELD_DAYS дней - из истории анализа в базе. */
export async function loadArchiveWeights(
  db: ReturnType<typeof getDb>,
  /** постов в неделю по расписанию: от него норма рубрик */
  postsPerWeek?: number,
  log?: (line: string) => void,
): Promise<Map<string, number>> {
  const since = new Date(Date.now() - YIELD_DAYS * 86_400_000).toISOString();
  try {
    const rows = await selectAll<YieldRow>((from, to) =>
      db
        .from("candidates")
        .select("status, attribution, source, tags, created_at, caption_html")
        .gte("created_at", since)
        .order("id")
        .range(from, to),
    );
    let deficits: Map<string, number> | undefined;
    if (postsPerWeek) {
      // запас резерва по рубрикам: годный, ещё не вышедший
      const fresh = Date.now() - RESERVE_TTL_DAYS * 86_400_000;
      const reserve = rows.filter(
        (r) => (r.status === "new" || r.status === "shown") && Date.parse(r.created_at ?? "") >= fresh,
      );
      const table = feedDeficits(reserve, postsPerWeek);
      deficits = new Map(table.map((t) => [t.key, t.deficit]));
      log?.(
        "сетка: запас/норма недели - " +
          table.map((t) => `${t.label} ${t.stock}/${t.need.toFixed(1)}${t.full ? " (сыта)" : ""}`).join(", "),
      );
    }
    return archiveWeights(rows, deficits);
  } catch (err) {
    // без весов очередь просто чередует архивы поровну, как раньше
    console.warn(`веса архивов не прочитаны: ${(err as Error).message}`);
    return new Map();
  }
}
