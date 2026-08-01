import { describe, expect, it } from "vitest";

/** Копия правила из scripts/publish.ts: длина видимой цитаты. */
function quoteLength(captionHtml: string | null): number {
  const m = captionHtml?.match(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/);
  return m?.[1]?.replace(/<[^>]+>/g, "").trim().length ?? 0;
}

describe("quoteLength", () => {
  it("считает развёрнутую цитату длинной, а место с датой - короткой", () => {
    const long =
      "<blockquote expandable>" +
      "Кухонные дебаты - серия импровизированных диалогов между вице-президентом США " +
      "Ричардом Никсоном и председателем Совета Министров СССР Никитой Хрущёвым, " +
      "состоявшихся 24 июля 1959 года на открытии выставки в Москве." +
      "</blockquote>";
    expect(quoteLength(long)).toBeGreaterThanOrEqual(180);
    expect(quoteLength("<blockquote expandable>СССР, 1943 год.</blockquote>")).toBeLessThan(180);
    expect(quoteLength(null)).toBe(0);
  });
});
