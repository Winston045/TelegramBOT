import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hostFamily, isBlocked, noteOk, noteRateLimit, resetHostGuard, retryAfterMs } from "../src/hostguard.js";

/**
 * Редакция 08.11: «бот стучался в ресурсы беспрерывно, от чего они его
 * блокировали». После серии 429 хост до конца прогона не трогаем.
 */
beforeEach(() => {
  resetHostGuard();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("предохранитель хостов", () => {
  it("семейство: поиск и картинки LOC, все разделы Википедии - один хост", () => {
    expect(hostFamily("https://tile.loc.gov/x.jpg")).toBe("loc.gov");
    expect(hostFamily("https://www.loc.gov/photos/?q=x")).toBe("loc.gov");
    expect(hostFamily("https://ru.wikipedia.org/w/api.php")).toBe("wikipedia.org");
    expect(hostFamily("не адрес")).toBe("");
  });

  it("два отказа подряд - хост отдыхает; успех между ними сбрасывает счёт", () => {
    const u = "https://upload.wikimedia.org/a.jpg";
    expect(noteRateLimit(u)).toBe(false);
    noteOk(u);
    expect(noteRateLimit(u)).toBe(false);
    expect(noteRateLimit(u)).toBe(true);
    expect(isBlocked("https://thumb.wikimedia.org/wikipedia/commons/thumb/a/a.jpg/1920px-a.jpg")).toBe(true);
    expect(isBlocked("https://tile.loc.gov/x.jpg")).toBe(false);
  });

  it("раздача файлов Викимедиа и API Викисклада - разные семейства (сбор 15.11)", () => {
    expect(hostFamily("https://upload.wikimedia.org/a.jpg")).toBe("upload.wikimedia.org");
    expect(hostFamily("https://thumb.wikimedia.org/x/1920px-a.jpg")).toBe("upload.wikimedia.org");
    expect(hostFamily("https://commons.wikimedia.org/w/api.php")).toBe("wikimedia.org");
    // отказ API не закрывает картинки, и наоборот
    noteRateLimit("https://commons.wikimedia.org/w/api.php", { now: true });
    expect(isBlocked("https://upload.wikimedia.org/a.jpg")).toBe(false);
    noteRateLimit("https://upload.wikimedia.org/a.jpg", { now: true });
    expect(isBlocked("https://upload.wikimedia.org/b.jpg")).toBe(true);
  });

  it("Retry-After: секунды, дата, без заголовка - в разумных рамках", () => {
    expect(retryAfterMs("30")).toBe(30_000);
    expect(retryAfterMs("1")).toBe(5_000);
    expect(retryAfterMs("3600")).toBe(60_000);
    expect(retryAfterMs(null)).toBe(20_000);
    const now = Date.parse("2026-11-15T05:00:00Z");
    expect(retryAfterMs("Sun, 15 Nov 2026 05:00:40 GMT", now)).toBe(40_000);
    expect(retryAfterMs("мусор")).toBe(20_000);
  });

  it("loc.gov блокируется с первого отказа", () => {
    expect(noteRateLimit("https://www.loc.gov/item/1/?fo=json", { now: true })).toBe(true);
    expect(isBlocked("https://tile.loc.gov/x.jpg")).toBe(true);
  });
});

describe("источники уважают предохранитель", () => {
  it("LOC: после 429 в поиске карточки кадров не запрашиваются", async () => {
    const { loc } = await import("../src/sources/loc.js");
    const { memoryCursorStore } = await import("../src/cursors.js");
    const calls = vi.fn(async () => new Response("slow down", { status: 429 }));
    vi.stubGlobal("fetch", calls);
    await loc.fetch(3, { enabled: true, weight: 1, queries: ["a", "b"] }, memoryCursorStore());
    expect(calls).toHaveBeenCalledTimes(1);
    const ctx = await loc.details?.({ sourceId: "x", sourceUrl: "", imageUrl: "", lang: "en", license: "PD" });
    expect(ctx).toBeUndefined();
    expect(calls).toHaveBeenCalledTimes(1);
  });

  it("Википедия: после бана справки не запрашиваются вовсе", async () => {
    const { subjectReference } = await import("../src/wiki.js");
    noteRateLimit("https://en.wikipedia.org/w/api.php", { now: true });
    const calls = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", calls);
    expect(await subjectReference("Tiger I")).toBeUndefined();
    expect(calls).not.toHaveBeenCalled();
  });
});
