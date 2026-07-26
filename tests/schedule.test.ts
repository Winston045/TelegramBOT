import { describe, expect, it } from "vitest";
import {
  countPublishedToday,
  shouldPublishNow,
  slotsPassed,
  tzDateString,
  tzMinutes,
} from "../src/schedule.js";

const TZ = "Europe/Moscow"; // UTC+3, без летнего времени
const TIMES = ["09:00", "12:30", "15:00", "18:00", "21:00"];

// 06:00 UTC = 09:00 МСК
const at = (utcHour: number, utcMin = 0) =>
  new Date(Date.UTC(2026, 6, 26, utcHour, utcMin));

describe("tz-хелперы", () => {
  it("tzMinutes переводит в минуты местного времени", () => {
    expect(tzMinutes(at(6, 0), TZ)).toBe(9 * 60);
    expect(tzMinutes(at(21, 5), TZ)).toBe(5); // 00:05 следующего дня МСК
  });

  it("tzDateString даёт дату в таймзоне", () => {
    expect(tzDateString(at(12), TZ)).toBe("2026-07-26");
    expect(tzDateString(at(22), TZ)).toBe("2026-07-27"); // 01:00 МСК след. дня
  });
});

describe("slotsPassed / shouldPublishNow", () => {
  it("до первого слота ничего не публикуем", () => {
    expect(slotsPassed(at(5, 45), TIMES, TZ)).toBe(0); // 08:45 МСК
    expect(shouldPublishNow(at(5, 45), TIMES, TZ, 0)).toBe(false);
  });

  it("ровно в слот и чуть позже — публикуем", () => {
    expect(slotsPassed(at(6, 0), TIMES, TZ)).toBe(1); // 09:00 МСК
    expect(shouldPublishNow(at(6, 0), TIMES, TZ, 0)).toBe(true);
    expect(shouldPublishNow(at(6, 10), TIMES, TZ, 0)).toBe(true);
  });

  it("слот уже отработан — не дублируем", () => {
    expect(shouldPublishNow(at(6, 10), TIMES, TZ, 1)).toBe(false);
  });

  it("пропущенный крон догоняется следующим запуском", () => {
    // 15:20 МСК: прошло 3 слота, опубликовано 2 → публикуем
    expect(slotsPassed(at(12, 20), TIMES, TZ)).toBe(3);
    expect(shouldPublishNow(at(12, 20), TIMES, TZ, 2)).toBe(true);
  });

  it("к концу дня все 5 слотов закрыты", () => {
    expect(slotsPassed(at(20, 45), TIMES, TZ)).toBe(5); // 23:45 МСК
    expect(shouldPublishNow(at(20, 45), TIMES, TZ, 5)).toBe(false);
  });
});

describe("countPublishedToday", () => {
  it("считает только сегодняшние в таймзоне канала", () => {
    const list = [
      at(6, 5).toISOString(), // сегодня 09:05 МСК
      at(9, 35).toISOString(), // сегодня 12:35 МСК
      new Date(Date.UTC(2026, 6, 25, 20, 0)).toISOString(), // вчера 23:00 МСК
      null,
    ];
    expect(countPublishedToday(list, at(12), TZ)).toBe(2);
  });

  it("публикация в 23:30 UTC относится к следующему дню МСК", () => {
    const late = [new Date(Date.UTC(2026, 6, 25, 23, 30)).toISOString()]; // 26.07 02:30 МСК
    expect(countPublishedToday(late, at(12), TZ)).toBe(1);
  });
});
