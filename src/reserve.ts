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
import { RESERVE_TTL_DAYS } from "./plan.js";

/**
 * На сколько дней публикаций держим готовые посты.
 *
 * Было 3, то есть при трёх слотах в день запас ровно 9 - и лента жила
 * впритык: один сорванный сбор съедал треть буфера, а партия каждый день
 * выходила минимальной (MIN_BATCH). Утро 15.10: сбор дал ноль кадров, и
 * резерв сел на 8 при запасе 9. Четыре дня дают партии поменьше нервов и
 * остаются далеко внутри срока годности ссылок (RESERVE_TTL_DAYS = 10).
 */
export const DAYS_OF_BUFFER = 4;
/** Меньше этого партию собирать не стоит: накладные расходы те же. */
export const MIN_BATCH = 6;
/**
 * Запас на выбраковку: сколько кадров отдать на анализ на каждый
 * недостающий пост.
 *
 * Было 2 - расчёт на то, что порог оценки отсеивает половину партии. С
 * появлением сита по крючку (12.08) выход упал: живые прогоны 14-15.08
 * дали 3 из 10 и 2 из 5, то есть 30-40%, а не 50%. При множителе 2 добор
 * приносил меньше, чем лента съедает за сутки, и запас медленно таял.
 * Тройка возвращает баланс: на три недостающих поста просим девять
 * кадров, из них доходят примерно три.
 */
const OVERSHOOT = 3;

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

/**
 * Ключ квотного окна Gemini. Бесплатная квота сбрасывается в полночь по
 * Калифорнии, поэтому «сутки» для счётчика доборов начинаются в момент
 * сброса, а не в московскую полночь: заходы на выжатой квоте не должны съедать
 * лимит свежего окна (живой случай: два ночных добора впустую - и
 * предохранитель заблокировал первый сбор на свежей квоте).
 */
export function quotaDay(now: Date): string {
  // суточная квота Google сбрасывается в полночь по ТИХООКЕАНСКОМУ
  // времени: летом это 10:00 МСК, а с ноября, когда в США кончается
  // летнее время, - 11:00. Сдвиг «минус 10 часов от Москвы» был верен
  // только летом: зимой окно открывалось на час раньше настоящего сброса
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(now);
}

/**
 * Сколько готовых постов лежит в базе: свежий резерв плюс одобренная
 * очередь - ровно то, что публикатор реально может взять.
 *
 * Раньше в счёт шёл весь резерв, включая кадры старше RESERVE_TTL_DAYS,
 * которые публикатор уже не берёт. Дюжина таких «вечных» остатков
 * держала счётчик выше запаса: сбор решал, что всего хватает, а
 * публикатор видел два свежих кадра - и через два слота лента вставала.
 */
export async function countAvailable(now = new Date()): Promise<number> {
  const db = getDb();
  const freshSince = new Date(now.getTime() - RESERVE_TTL_DAYS * 24 * 3600 * 1000).toISOString();
  const [reserve, approved] = await Promise.all([
    db
      .from("candidates")
      .select("id", { count: "exact", head: true })
      .in("status", ["new", "shown"])
      .not("caption_html", "is", null)
      .gte("created_at", freshSince),
    db
      .from("candidates")
      .select("id", { count: "exact", head: true })
      .eq("status", "approved")
      .not("caption_html", "is", null),
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
