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

describe("ротация запросов LOC", () => {
  it("каждый прогон начинается со следующего запроса, рубрика едет с кадром", async () => {
    const { vi } = await import("vitest");
    const { loc } = await import("../src/sources/loc.js");
    const { memoryCursorStore } = await import("../src/cursors.js");
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL) => {
        const q = url.searchParams.get("q") ?? "";
        seen.push(q);
        return new Response(
          JSON.stringify({
            results: [
              {
                id: `https://www.loc.gov/item/${q.replace(/\W/g, "")}/`,
                url: `https://www.loc.gov/item/${q.replace(/\W/g, "")}/`,
                title: q,
                image_url: ["https://tile.loc.gov/x.jpg#h=800&w=1000"],
                date: "1942",
              },
            ],
          }),
        );
      }),
    );
    const cursors = memoryCursorStore();
    const cfg = { enabled: true, weight: 1, queries: ["a", "b", { q: "c", rubric: "poster" }] };
    const first = await loc.fetch(3, cfg, cursors);
    const firstOrder = [...seen];
    seen.length = 0;
    await loc.fetch(3, cfg, cursors);
    expect(firstOrder).toEqual(["a", "b", "c"]);
    expect(seen).toEqual(["b", "c", "a"]);
    expect(first.find((i) => i.title === "c")?.rubric).toBe("poster");
    expect(first.find((i) => i.title === "a")?.rubric).toBeUndefined();
    vi.unstubAllGlobals();
  });
});
