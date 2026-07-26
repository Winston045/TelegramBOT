import { describe, expect, it } from "vitest";
import { mapLocResult, parseYear } from "../src/sources/loc.js";
import {
  mapCommonsPage,
  placeFromTitle,
  stripHtml,
} from "../src/sources/bundesarchiv.js";

describe("parseYear", () => {
  it("вытаскивает год из разных форматов", () => {
    expect(parseYear("1943")).toBe(1943);
    expect(parseYear("1943-05-12")).toBe(1943);
    expect(parseYear("photograph taken circa 1938, printed later")).toBe(1938);
    expect(parseYear("May 1915")).toBe(1915);
  });
  it("не берёт мусор", () => {
    expect(parseYear(undefined)).toBeUndefined();
    expect(parseYear("no date")).toBeUndefined();
    expect(parseYear("negative number 123456")).toBeUndefined();
  });
});

describe("mapLocResult", () => {
  const base = {
    id: "http://www.loc.gov/item/2017878556/",
    url: "https://www.loc.gov/item/2017878556/",
    title: "Street scene, New York",
    description: ["Crowd at the market."],
    date: "1936",
    location: ["new york"],
    image_url: [
      "//tile.loc.gov/storage-services/service/pnp/fsa/8b29000/8b29516_150px.jpg#h=112&w=150",
      "//tile.loc.gov/storage-services/service/pnp/fsa/8b29000/8b29516v.jpg#h=768&w=1024",
    ],
  };

  it("маппит запись целиком и берёт самую большую картинку", () => {
    const item = mapLocResult(base)!;
    expect(item.sourceId).toBe("2017878556");
    expect(item.sourceUrl).toBe("https://www.loc.gov/item/2017878556/");
    expect(item.imageUrl).toBe(
      "https://tile.loc.gov/storage-services/service/pnp/fsa/8b29000/8b29516v.jpg#h=768&w=1024",
    );
    expect(item.imageWidth).toBe(1024);
    expect(item.year).toBe(1936);
    expect(item.place).toBe("new york");
    expect(item.lang).toBe("en");
    expect(item.license).toBe("PD");
  });

  it("отбрасывает записи без картинки и с ограниченным доступом", () => {
    expect(mapLocResult({ ...base, image_url: [] })).toBeUndefined();
    expect(mapLocResult({ ...base, access_restricted: true })).toBeUndefined();
  });
});

describe("bundesarchiv", () => {
  const page = {
    pageid: 5471234,
    title: "File:Bundesarchiv Bild 101I-124-0242-24, Im Westen, Panzer IV.jpg",
    imageinfo: [
      {
        url: "https://upload.wikimedia.org/wikipedia/commons/a/ab/Bundesarchiv_Bild_101I-124-0242-24.jpg",
        descriptionurl:
          "https://commons.wikimedia.org/wiki/File:Bundesarchiv_Bild_101I-124-0242-24,_Im_Westen,_Panzer_IV.jpg",
        width: 800,
        height: 549,
        extmetadata: {
          ImageDescription: { value: "<b>Im Westen</b>, Panzerkampfwagen IV." },
          DateTimeOriginal: { value: "1940 Mai" },
          LicenseShortName: { value: "CC BY-SA 3.0 de" },
          Artist: { value: "<a href='#'>Koch</a>" },
        },
      },
    ],
  };

  it("маппит страницу Commons в RawItem", () => {
    const item = mapCommonsPage(page)!;
    expect(item.sourceId).toBe("5471234");
    expect(item.imageWidth).toBe(800);
    expect(item.year).toBe(1940);
    expect(item.place).toBe("Im Westen");
    expect(item.lang).toBe("de");
    expect(item.description).toBe("Im Westen , Panzerkampfwagen IV.");
    expect(item.license).toBe("CC BY-SA 3.0 de");
    expect(item.attribution).toBe("Bundesarchiv, Koch / CC BY-SA 3.0 de");
  });

  it("stripHtml чистит теги и сущности", () => {
    expect(stripHtml("<p>a&nbsp;&amp;&nbsp;b</p>")).toBe("a & b");
  });

  it("placeFromTitle берёт второй элемент через запятую", () => {
    expect(
      placeFromTitle("File:Bundesarchiv Bild 183-S33882, Berlin, Brandenburger Tor.jpg"),
    ).toBe("Berlin");
    expect(placeFromTitle("File:Bundesarchiv Bild ohne Komma.jpg")).toBeUndefined();
  });
});
