import { afterEach, describe, expect, it, vi } from "vitest";
import { memoryCursorStore } from "../src/cursors.js";
import { loc } from "../src/sources/loc.js";
import { bundesarchiv } from "../src/sources/bundesarchiv.js";

const locResult = (id: string) => ({
  id: `http://www.loc.gov/item/${id}/`,
  url: `https://www.loc.gov/item/${id}/`,
  title: "t",
  date: "1940",
  location: ["x"],
  image_url: [`//tile.loc.gov/${id}.jpg#h=100&w=1000`],
});

const commonsPage = (pageid: number) => ({
  pageid,
  title: `File:Bundesarchiv Bild ${pageid}, Ort, Sujet.jpg`,
  imageinfo: [
    {
      url: `https://upload.wikimedia.org/${pageid}.jpg`,
      descriptionurl: `https://commons.wikimedia.org/${pageid}`,
      width: 800,
      height: 600,
      extmetadata: { DateTimeOriginal: { value: "1940" } },
    },
  ],
});

function mockFetch(bodies: unknown[]) {
  const calls: string[] = [];
  let i = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: URL | string) => {
      calls.push(String(url));
      const body = bodies[Math.min(i++, bodies.length - 1)];
      return { ok: true, json: async () => body } as Response;
    }),
  );
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe("memoryCursorStore", () => {
  it("хранит и отдаёт курсоры, по умолчанию 0", async () => {
    const s = memoryCursorStore();
    expect(await s.get("loc", "q")).toBe(0);
    await s.set("loc", "q", 7);
    expect(await s.get("loc", "q")).toBe(7);
  });
});

describe("пагинация loc", () => {
  it("первый запуск — sp=1, полная страница двигает курсор, второй запуск — sp=2", async () => {
    const store = memoryCursorStore();
    const calls = mockFetch([
      { results: [locResult("a"), locResult("b")] }, // полная страница (perQuery=2)
      { results: [locResult("c")] },                 // короткая — конец выдачи
    ]);

    await loc.fetch(2, { enabled: true, weight: 50, queries: ["war"] }, store);
    expect(calls[0]).toContain("sp=1");
    expect(await store.get("loc", "war")).toBe(1);

    await loc.fetch(2, { enabled: true, weight: 50, queries: ["war"] }, store);
    expect(calls[1]).toContain("sp=2");
    // короткая страница — курсор завернулся на начало
    expect(await store.get("loc", "war")).toBe(0);
  });
});

describe("пагинация bundesarchiv", () => {
  it("смещение растёт на размер выдачи и заворачивается на конце", async () => {
    const store = memoryCursorStore();
    const calls = mockFetch([
      { query: { pages: [commonsPage(1), commonsPage(2)] } }, // полная (perTerm=2)
      { query: { pages: [commonsPage(3)] } },                 // короткая
    ]);

    await bundesarchiv.fetch(2, { enabled: true, weight: 50, categories: ["1939"] }, store);
    expect(calls[0]).toContain("gsroffset=0");
    expect(await store.get("bundesarchiv", "1939")).toBe(2);

    await bundesarchiv.fetch(2, { enabled: true, weight: 50, categories: ["1939"] }, store);
    expect(calls[1]).toContain("gsroffset=2");
    expect(await store.get("bundesarchiv", "1939")).toBe(0);
  });
});
