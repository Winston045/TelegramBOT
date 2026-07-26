import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { channelSlug, parseChannelPage } from "../src/tme.js";

const html = readFileSync(
  resolve(import.meta.dirname, "fixtures/tme_page.html"),
  "utf8",
);

describe("parseChannelPage", () => {
  it("находит все сообщения и их фото", () => {
    const page = parseChannelPage(html);
    expect(page.posts).toHaveLength(3);

    const byId = Object.fromEntries(page.posts.map((p) => [p.id, p.photoUrls]));
    expect(byId[4410]).toEqual(["https://cdn4.telesco.pe/file/photo4410.jpg"]);
    // альбом: оба фото привязаны к одному сообщению
    expect(byId[4408]).toEqual([
      "https://cdn4.telesco.pe/file/photo4408a.jpg",
      "https://cdn4.telesco.pe/file/photo4408b.jpg",
    ]);
    // текстовый пост — без фото
    expect(byId[4407]).toEqual([]);
  });

  it("отдаёт minId для пагинации ?before=", () => {
    expect(parseChannelPage(html).minId).toBe(4407);
  });

  it("пустая страница — нет постов и minId", () => {
    const page = parseChannelPage("<html><body></body></html>");
    expect(page.posts).toEqual([]);
    expect(page.minId).toBeUndefined();
  });
});

describe("channelSlug", () => {
  it("убирает @", () => {
    expect(channelSlug("@Story_Teams")).toBe("Story_Teams");
    expect(channelSlug("Story_Teams")).toBe("Story_Teams");
  });
});
