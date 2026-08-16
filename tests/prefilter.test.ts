import { describe, expect, it } from "vitest";
import type { AppConfig } from "../src/config.js";
import { prefilter, rejectReason } from "../src/prefilter.js";
import type { RawItem } from "../src/sources/types.js";

const cfg = {
  collect: { min_image_width: 700, min_year: 1850, max_year: 1965 },
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
  it("современные и допотопные годы — брак (живой прогон: фото 2018 года по запросу '1930s')", () => {
    expect(rejectReason({ ...good, year: 2018 }, cfg)).toBe("year_out_of_range");
    expect(rejectReason({ ...good, year: 1790 }, cfg)).toBe("year_out_of_range");
    expect(rejectReason({ ...good, year: 1850 }, cfg)).toBeNull();
    expect(rejectReason({ ...good, year: 1965 }, cfg)).toBeNull();
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

describe("карточки альбомов вместо снимков", () => {
  const base = {
    sourceId: "1",
    sourceUrl: "https://x",
    imageUrl: "https://x.jpg",
    lang: "en",
    license: "PD",
    year: 1944,
    place: "France",
  };

  it("записи «... Collection» и альбомы отсеиваются до анализа", () => {
    for (const title of [
      "Harold Charles Braly Collection",
      "James A. Yost World War II Photograph Album",
      "Bruce F. Meyers Collection",
    ]) {
      expect(rejectReason({ ...base, title }, cfg)).toBe("album_record");
    }
  });

  it("обычный снимок со словом collection внутри названия не трогаем", () => {
    expect(
      rejectReason({ ...base, title: "Tank of the collection unit moves through Percy" }, cfg),
    ).toBeNull();
  });
});

describe("студийные портреты", () => {
  const base = {
    sourceId: "1",
    sourceUrl: "https://x",
    imageUrl: "https://x.jpg",
    lang: "en",
    license: "PD",
    year: 1943,
    place: "London",
  };

  it("«Churchill portrait» не доходит до анализа", () => {
    expect(rejectReason({ ...base, title: "Churchill portrait NYP 45063" }, cfg)).toBe(
      "studio_portrait",
    );
  });

  it("портрет рядом с техникой оставляем - там может быть трофей", () => {
    expect(
      rejectReason({ ...base, title: "Portrait of crew with captured Tiger tank" }, cfg),
    ).toBeNull();
  });
});

describe("свой порог ширины у отдельных архивов", () => {
  const cfgWithOverride = {
    collect: {
      min_image_width: 800,
      min_year: 1850,
      max_year: 1999,
      min_image_width_by_archive: { "риа новости": 600 },
    },
    filters: { stop_words: [] },
  } as unknown as AppConfig;

  const frame = (attribution: string, imageWidth: number) => ({
    sourceId: "1",
    sourceUrl: "https://x",
    imageUrl: "https://x.jpg",
    title: "Атака пехоты",
    lang: "ru",
    license: "PD",
    year: 1943,
    place: "Сталинград",
    attribution,
    imageWidth,
  });

  it("советский архив проходит по своему, пониженному порогу", () => {
    expect(rejectReason(frame("РИА Новости, Иванов / CC BY-SA 3.0", 700), cfgWithOverride)).toBeNull();
  });

  it("но совсем мелкий кадр не проходит и у него", () => {
    expect(rejectReason(frame("РИА Новости / CC BY-SA 3.0", 500), cfgWithOverride)).toBe("too_small");
  });

  it("остальным архивам послабление не достаётся", () => {
    expect(rejectReason(frame("Bundesarchiv, Koch / CC BY-SA 3.0 de", 700), cfgWithOverride)).toBe(
      "too_small",
    );
  });
});
