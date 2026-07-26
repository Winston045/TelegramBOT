import { describe, expect, it } from "vitest";
import type { AppConfig } from "../src/config.js";
import { prefilter, rejectReason } from "../src/prefilter.js";
import type { RawItem } from "../src/sources/types.js";

const cfg = {
  collect: { min_image_width: 700 },
  filters: { stop_words: ["execution", "mass grave"] },
} as unknown as AppConfig;

const good: RawItem = {
  sourceId: "1",
  sourceUrl: "https://example.org/1",
  imageUrl: "https://example.org/1.jpg",
  title: "Soldiers at rest",
  lang: "en",
  year: 1943,
  place: "Kursk",
  license: "PD",
  imageWidth: 1024,
};

describe("rejectReason", () => {
  it("пропускает нормальную запись", () => {
    expect(rejectReason(good, cfg)).toBeNull();
  });
  it("без года — брак", () => {
    expect(rejectReason({ ...good, year: undefined }, cfg)).toBe("no_year");
  });
  it("без места — брак", () => {
    expect(rejectReason({ ...good, place: undefined }, cfg)).toBe("no_place");
  });
  it("мелкая картинка — брак, неизвестная ширина — пропускаем", () => {
    expect(rejectReason({ ...good, imageWidth: 400 }, cfg)).toBe("too_small");
    expect(rejectReason({ ...good, imageWidth: undefined }, cfg)).toBeNull();
  });
  it("стоп-слово в любом регистре и в описании — брак", () => {
    expect(rejectReason({ ...good, title: "Execution site" }, cfg)).toBe("stop_word");
    expect(
      rejectReason({ ...good, description: "near the Mass Grave" }, cfg),
    ).toBe("stop_word");
  });
});

describe("prefilter", () => {
  it("делит на выживших и счётчик причин", () => {
    const items = [
      good,
      { ...good, sourceId: "2", year: undefined },
      { ...good, sourceId: "3", imageWidth: 100 },
      { ...good, sourceId: "4", title: "execution" },
    ];
    const { kept, rejected } = prefilter(items, cfg);
    expect(kept.map((i) => i.sourceId)).toEqual(["1"]);
    expect(rejected.get("no_year")).toBe(1);
    expect(rejected.get("too_small")).toBe(1);
    expect(rejected.get("stop_word")).toBe(1);
  });
});
