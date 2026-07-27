import { describe, expect, it } from "vitest";
import {
  MAX_SLOTS,
  hourKeyboard,
  isValidTime,
  minuteKeyboard,
  normalizeTimes,
  packTime,
  panelKeyboard,
  schedulePanelText,
  unpackTime,
} from "../src/schedule_panel.js";

describe("время слота", () => {
  it("принимает корректные HH:MM", () => {
    expect(isValidTime("00:00")).toBe(true);
    expect(isValidTime("09:30")).toBe(true);
    expect(isValidTime("23:59")).toBe(true);
  });

  it("отклоняет мусор", () => {
    expect(isValidTime("24:00")).toBe(false);
    expect(isValidTime("9:30")).toBe(false);
    expect(isValidTime("09:60")).toBe(false);
    expect(isValidTime("0930")).toBe(false);
  });

  it("pack/unpack — обратные операции", () => {
    expect(packTime("09:30")).toBe("0930");
    expect(unpackTime("0930")).toBe("09:30");
    expect(unpackTime("2400")).toBeUndefined();
    expect(unpackTime("093")).toBeUndefined();
  });
});

describe("normalizeTimes", () => {
  it("сортирует и убирает дубли", () => {
    expect(normalizeTimes(["21:00", "09:00", "09:00", "12:30"])).toEqual([
      "09:00",
      "12:30",
      "21:00",
    ]);
  });

  it("выбрасывает некорректные значения и не-массивы", () => {
    expect(normalizeTimes(["09:00", "25:00", 42, null])).toEqual(["09:00"]);
    expect(normalizeTimes("09:00")).toEqual([]);
    expect(normalizeTimes(undefined)).toEqual([]);
  });
});

describe("клавиатуры панели", () => {
  it("панель: кнопка на каждый слот + управление", () => {
    const rows = panelKeyboard(["09:00", "12:30", "21:00"]);
    const buttons = rows.flat();
    expect(buttons.map((b) => b.callback_data)).toContain("tdel:0900");
    expect(buttons.map((b) => b.callback_data)).toContain("tdel:2100");
    expect(buttons.at(-2)?.callback_data).toBe("tadd");
    expect(buttons.at(-1)?.callback_data).toBe("tclose");
  });

  it("часы: 24 кнопки и возврат", () => {
    const buttons = hourKeyboard().flat();
    expect(buttons).toHaveLength(25);
    expect(buttons[0]?.callback_data).toBe("th:0");
    expect(buttons[23]?.callback_data).toBe("th:23");
    expect(buttons.at(-1)?.callback_data).toBe("tback");
  });

  it("минуты: шаг 10 для выбранного часа", () => {
    const buttons = minuteKeyboard(9).flat();
    expect(buttons[0]).toEqual({ text: "09:00", callback_data: "tset:0900" });
    expect(buttons[5]).toEqual({ text: "09:50", callback_data: "tset:0950" });
    expect(buttons.at(-1)?.callback_data).toBe("tadd");
  });

  it("текст панели показывает число постов и слоты по порядку", () => {
    const text = schedulePanelText(["09:00", "21:00"]);
    expect(text).toContain("Постов в день: 2");
    expect(text).toContain("1. 09:00");
    expect(text).toContain("2. 21:00");
    expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
  });

  it("лимит слотов разумный", () => {
    expect(MAX_SLOTS).toBeGreaterThanOrEqual(6);
    expect(MAX_SLOTS).toBeLessThanOrEqual(24);
  });
});
