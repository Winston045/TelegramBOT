/**
 * Размер резерва и размер следующей партии.
 *
 * Сбор приносит больше, чем расходуют слоты, поэтому без тормоза резерв
 * растёт бесконечно: лишняя квота Gemini и стареющие ссылки на фото.
 * Держим запас на несколько дней вперёд и берём ровно столько, сколько
 * нужно до этого запаса.
 */
import type { AppConfig } from "./config.js";
import { getDb } from "./db.js";
import { loadPublishTimes } from "./settings.js";

/** На сколько дней публикаций держим готовые посты. */
export const DAYS_OF_BUFFER = 3;
/** Меньше этого партию собирать не стоит: накладные расходы те же. */
export const MIN_BATCH = 6;
/** Запас на выбраковку: порог оценки отсеивает примерно половину партии. */
const OVERSHOOT = 2;

export type ReservePlan = {
  available: number; // готовые к публикации: резерв + одобренная очередь
  target: number; // сколько хотим иметь
  keep: number; // сколько фото отдать на анализ (0 - сбор не нужен)
};

/**
 * Чистая часть решения - без базы, чтобы её можно было проверить тестами.
 */
export function planFromCounts(
  available: number,
  slotsPerDay: number,
  prefilterKeep: number,
): ReservePlan {
  const target = Math.max(MIN_BATCH, slotsPerDay * DAYS_OF_BUFFER);
  const deficit = target - available;
  const keep =
    deficit <= 0 ? 0 : Math.min(prefilterKeep, Math.max(MIN_BATCH, deficit * OVERSHOOT));
  return { available, target, keep };
}

/** Сколько готовых постов лежит в базе: резерв плюс одобренная очередь. */
export async function countAvailable(): Promise<number> {
  const db = getDb();
  const [reserve, approved] = await Promise.all([
    db
      .from("candidates")
      .select("id", { count: "exact", head: true })
      .in("status", ["new", "shown"])
      .not("caption_html", "is", null),
    db.from("candidates").select("id", { count: "exact", head: true }).eq("status", "approved"),
  ]);
  if (reserve.error) throw new Error(`чтение резерва: ${reserve.error.message}`);
  if (approved.error) throw new Error(`чтение очереди: ${approved.error.message}`);
  return (reserve.count ?? 0) + (approved.count ?? 0);
}

export async function planReserve(cfg: AppConfig): Promise<ReservePlan> {
  const [available, times] = await Promise.all([
    countAvailable(),
    loadPublishTimes(cfg.publish.times),
  ]);
  return planFromCounts(available, times.length, cfg.collect.prefilter_keep);
}
