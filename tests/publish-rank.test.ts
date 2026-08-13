import { describe, expect, it } from "vitest";
import { archiveKey, planAuto } from "../src/plan.js";

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

describe("одобренная очередь тоже чередует архивы", () => {
  const cand = (id: number, archive: string, subject: string) => ({
    id,
    caption_html: `текст ${id}`,
    score: 70,
    attribution: `${archive} / CC BY-SA`,
    tags: { subject, period: "WW2", military: true, action: true },
  });

  it("после немецкого поста берёт британца, а не следующего немца по номеру", () => {
    // порядок в очереди - по id: два немца, потом британец
    const approved = [
      cand(101, "Bundesarchiv", "infantry"),
      cand(102, "Bundesarchiv", "armor"),
      cand(103, "IWM", "navy"),
    ];
    const [pick] = planAuto(approved, {
      subjects: [],
      periods: [],
      civilian: false,
      statics: 0,
      longs: 0,
      archives: ["bundesarchiv", "bundesarchiv"],
    }, 1);
    expect(pick?.id).toBe(103);
  });

  it("весь план одобренных раскладывается без двух одинаковых архивов подряд", () => {
    const approved = [
      cand(201, "Bundesarchiv", "infantry"),
      cand(202, "Bundesarchiv", "armor"),
      cand(203, "IWM", "navy"),
      cand(204, "IWM", "aviation"),
    ];
    const plan = planAuto(approved, {
      subjects: [],
      periods: [],
      civilian: false,
      statics: 0,
      longs: 0,
      archives: [],
    }, approved.length);
    expect(plan).toHaveLength(4);
    const keys = plan.map((c) => archiveKey(c.attribution));
    for (let i = 1; i < keys.length; i++) expect(keys[i]).not.toBe(keys[i - 1]);
  });
});
