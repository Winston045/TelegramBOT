import { describe, expect, it } from "vitest";
import { DAYS_OF_BUFFER, MIN_BATCH, planFromCounts, quotaDay } from "../src/reserve.js";

const PREFILTER_KEEP = 30;
const plan = (available: number, slots = 5) =>
  planFromCounts(available, slots, PREFILTER_KEEP);

describe("planFromCounts", () => {
  it("держит запас на несколько дней публикаций", () => {
    expect(plan(0).target).toBe(5 * DAYS_OF_BUFFER);
    expect(plan(0, 2).target).toBe(2 * DAYS_OF_BUFFER);
  });

  it("резерв полон - сбор не нужен", () => {
    expect(plan(15).keep).toBe(0);
    expect(plan(40).keep).toBe(0);
  });

  it("резерв пуст - берём партию с запасом на выбраковку", () => {
    // не хватает 15, до резерва доходит около трети - упираемся в потолок
    expect(plan(0).keep).toBe(30);
  });

  it("мелкий недобор всё равно даёт партию не меньше минимальной", () => {
    expect(plan(14).keep).toBe(MIN_BATCH);
    expect(plan(13).keep).toBe(MIN_BATCH);
  });

  it("партия не превышает лимит префильтра", () => {
    expect(planFromCounts(0, 12, PREFILTER_KEEP).keep).toBe(PREFILTER_KEEP);
  });

  it("редкое расписание не опускает запас ниже минимального", () => {
    expect(plan(0, 1).target).toBe(MIN_BATCH);
  });
});

describe("quotaDay", () => {
  it("до 10:00 МСК - ещё вчерашнее квотное окно", () => {
    // 05.08 03:46 МСК = 05.08 00:46 UTC
    expect(quotaDay(new Date("2026-08-05T00:46:00Z"))).toBe("2026-08-04");
    // 05.08 09:59 МСК
    expect(quotaDay(new Date("2026-08-05T06:59:00Z"))).toBe("2026-08-04");
  });

  it("с 10:00 МСК начинается свежее окно", () => {
    // 05.08 10:00 МСК ровно
    expect(quotaDay(new Date("2026-08-05T07:00:00Z"))).toBe("2026-08-05");
    // 05.08 23:30 МСК - всё ещё то же окно
    expect(quotaDay(new Date("2026-08-05T20:30:00Z"))).toBe("2026-08-05");
  });
});

describe("добор покрывает суточный расход", () => {
  // измеренный выход сита: до резерва доходит примерно треть партии
  const YIELD = 1 / 3;

  it("при трёх слотах партия закрывает дневной расход, а не половину его", () => {
    const slots = 3;
    // резерв просел на дневной расход: было 9 (норма), стало 6
    const { target, keep } = planFromCounts(6, slots, PREFILTER_KEEP);
    expect(target).toBe(9);
    // просим столько, чтобы дошедших хватило закрыть недостачу
    expect(Math.round(keep * YIELD)).toBeGreaterThanOrEqual(target - 6);
  });

  it("минимальная партия не мельче порога окупаемости", () => {
    expect(planFromCounts(8, 3, PREFILTER_KEEP).keep).toBe(MIN_BATCH);
  });
});
