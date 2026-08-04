import { describe, expect, it } from "vitest";
import { duplicatesPlace } from "../src/critic.js";

describe("duplicatesPlace", () => {
  it("совпадение с точностью до пунктуации и регистра - дубль", () => {
    expect(duplicatesPlace("Тихий океан 1945 год", "Тихий океан, 1945 год.")).toBe(true);
    expect(duplicatesPlace("СССР, 1943 год.", "ссср 1943 год")).toBe(true);
  });

  it("вложение в одну из сторон - тоже дубль", () => {
    expect(duplicatesPlace("Австрия, 1946 год", "Австрия, 1946")).toBe(true);
  });

  it("другое место или дата - не дубль", () => {
    expect(duplicatesPlace("Ливия, декабрь 1942 года.", "Тихий океан, 1945 год.")).toBe(false);
  });

  it("настоящий факт не путается с местом и датой", () => {
    expect(
      duplicatesPlace("Трал ПТ-3 выдерживал от пяти до десяти детонаций.", "Лето 1943 года."),
    ).toBe(false);
  });

  it("без quote_place дубля нет", () => {
    expect(duplicatesPlace("СССР, 1943 год.", undefined)).toBe(false);
  });
});
