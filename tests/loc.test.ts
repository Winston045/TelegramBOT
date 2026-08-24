import { describe, expect, it } from "vitest";
import { mapLocResult } from "../src/sources/loc.js";

describe("страницы коллекций не выдаются за фотографии", () => {
  it("about-this-collection отбрасывается до анализа", () => {
    // живые случаи 21 и 24.08: обложка коллекции прошла все фильтры
    // и сожгла слот анализа Gemini
    expect(
      mapLocResult({
        id: "http://www.loc.gov/collections/fsa-owi-color-photographs/about-this-collection",
        url: "https://www.loc.gov/collections/fsa-owi-color-photographs/",
        image_url: ["https://tile.loc.gov/storage-services/service/pnp/x/collection.jpg#h=768&w=1024"],
        title: "FSA/OWI Color Photographs",
      }),
    ).toBeUndefined();
  });

  it("обычная карточка предмета проходит как раньше", () => {
    expect(
      mapLocResult({
        id: "http://www.loc.gov/item/2017878800/",
        url: "https://www.loc.gov/item/2017878800/",
        image_url: ["https://tile.loc.gov/storage-services/service/pnp/fsac/1a34000/1a34500.jpg#h=768&w=1024"],
        title: "Test",
        date: "1942",
      }),
    ).toBeDefined();
  });
});
