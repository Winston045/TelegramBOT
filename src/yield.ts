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
import { archiveKey } from "./plan.js";

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
  attribution?: string | null;
  source?: string | null;
  tags?: { story?: string } | null;
};

/**
 * Сетка ленты (15.11): в день нужен хотя бы один пост про человека,
 * поворот или знаковое событие, а «будни армии» - половина ленты. Архив,
 * чьи прошедшие кадры чаще дают такие истории, получает добавку к весу,
 * архив «просто солдат» - скидку. Множитель в этих рамках.
 */
export const STORY_MIN_FACTOR = 0.8;
export const STORY_MAX_FACTOR = 1.3;
const HEADLINE = new Set(["human", "twist", "landmark"]);

/**
 * Веса архивов по истории анализа: сглаженный выход архива, делённый на
 * общий выход. 1 - средний архив, меньше - хвост очереди, больше - голова.
 */
export function archiveWeights(rows: YieldRow[]): Map<string, number> {
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
    if (PASSED.has(r.status)) {
      s.ok++;
      passed++;
    }
    stats.set(key, s);
  }
  // доля историй (человек, поворот, событие) среди размеченных прошедших
  const stories = new Map<string, { tagged: number; headline: number }>();
  let taggedAll = 0;
  let headlineAll = 0;
  for (const r of rows) {
    if (!PASSED.has(r.status) || !r.tags?.story) continue;
    const key = archiveKey(r.attribution) || r.source || "";
    if (!key) continue;
    const st = stories.get(key) ?? { tagged: 0, headline: 0 };
    st.tagged++;
    taggedAll++;
    if (HEADLINE.has(r.tags.story)) {
      st.headline++;
      headlineAll++;
    }
    stories.set(key, st);
  }
  const headlineMean = taggedAll ? headlineAll / taggedAll : 0;

  const weights = new Map<string, number>();
  if (!total) return weights;
  const mean = passed / total;
  if (mean <= 0) return weights;
  for (const [key, s] of stats) {
    const smoothed = (s.ok + YIELD_PRIOR * mean) / (s.n + YIELD_PRIOR);
    let w = Math.min(MAX_WEIGHT, Math.max(MIN_WEIGHT, smoothed / mean));
    const st = stories.get(key);
    if (st && headlineMean > 0) {
      const share = (st.headline + YIELD_PRIOR * headlineMean) / (st.tagged + YIELD_PRIOR);
      w *= Math.min(STORY_MAX_FACTOR, Math.max(STORY_MIN_FACTOR, share / headlineMean));
    }
    weights.set(key, Math.round(w * 100) / 100);
  }
  return weights;
}

/** Веса архивов по выходу за YIELD_DAYS дней - из истории анализа в базе. */
export async function loadArchiveWeights(db: ReturnType<typeof getDb>): Promise<Map<string, number>> {
  const since = new Date(Date.now() - YIELD_DAYS * 86_400_000).toISOString();
  try {
    const rows = await selectAll<YieldRow>((from, to) =>
      db
        .from("candidates")
        .select("status, attribution, source, tags")
        .gte("created_at", since)
        .order("id")
        .range(from, to),
    );
    return archiveWeights(rows);
  } catch (err) {
    // без весов очередь просто чередует архивы поровну, как раньше
    console.warn(`веса архивов не прочитаны: ${(err as Error).message}`);
    return new Map();
  }
}
