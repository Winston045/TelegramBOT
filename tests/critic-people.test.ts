import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Правило ЛЮДИ (редакция 29.10): читатель русскоязычный, иностранных
 * генералов и артистов не знает - имя без пояснения пустой звук.
 */
const reply = { value: {} as Record<string, unknown> };
const calls: string[] = [];
vi.doMock("../src/gemini.js", () => ({
  GeminiBusyError: class extends Error {},
  geminiJson: async (parts: Array<{ text: string }>) => {
    calls.push(parts[0]!.text);
    return reply.value;
  },
}));
const { acceptBody, buildPrompt, reviewQuote } = await import("../src/critic.js");
const { captionRules } = await import("../src/caption.js");

const item = {
  sourceId: "1",
  sourceUrl: "https://x",
  imageUrl: "https://x.jpg",
  title: "Ado Broodboom en Jack Sels tijdens jazzconcert",
  description: "Trompettist Ado Broodboom en saxofonist Jack Sels",
  lang: "nl",
  license: "CC0",
  year: 1958,
  place: "Amsterdam",
};
const base = {
  caption: "Трубач Адо Бродбом и саксофонист Джек Селс выступают на джазовом концерте.",
  quote: "Амстердам, 1958 год.",
  quote_kind: "context" as const,
};

beforeEach(() => {
  calls.length = 0;
});

describe("люди в тексте поста", () => {
  it("правило есть и в подписи, и у редактора", () => {
    expect(captionRules({})).toContain("ИМЯ БЕЗ ПОЯСНЕНИЯ - ПУСТОЙ ЗВУК");
    const prompt = buildPrompt(item, base, undefined, undefined, ["Адо Бродбом", "Джек Селс"]);
    expect(prompt).toContain("В тексте поста названы люди: Адо Бродбом, Джек Селс");
    expect(prompt).toContain("замени имя ролью");
  });

  it("обычный пост с именами редактор смотрит, даже без справки о предмете", async () => {
    reply.value = { verdict: "ok", caption: "Голландские джазмены выступают на концерте в Амстердаме." };
    const r = await reviewQuote(item, {} as never, base, undefined, undefined, { people: ["Адо Бродбом"] });
    expect(calls).toHaveLength(1);
    expect(r.rewritten).toBe(true);
    expect(r.caption.caption).toBe("Голландские джазмены выступают на концерте в Амстердаме.");
    expect(r.caption.quote).toBe(base.quote);
  });

  it("без имён и справки обычный пост редактор не трогает - квота цела", async () => {
    const r = await reviewQuote(item, {} as never, base, undefined, undefined, { people: [] });
    expect(calls).toHaveLength(0);
    expect(r.rewritten).toBe(false);
  });
});

describe("страховки правки текста поста", () => {
  it("два предложения, выдуманное число или год - правка не принимается", () => {
    expect(acceptBody("Голландские джазмены выступают. Публика в восторге.", base.caption, item, [])).toBeUndefined();
    expect(acceptBody("Голландские джазмены, сыгравшие 300 концертов, выступают.", base.caption, item, [])).toBeUndefined();
    expect(acceptBody("Голландские джазмены, звёзды 1961 года, выступают.", base.caption, item, [])).toBeUndefined();
  });

  it("пояснение из справки принимается, длинное тире становится дефисом", () => {
    const ref = "Jack Sels was a Belgian jazz saxophonist, one of the first European bebop players.";
    expect(
      acceptBody("Джек Селс — один из первых европейских бибоп-саксофонистов — играет на концерте.", base.caption, item, [ref]),
    ).toBe("Джек Селс - один из первых европейских бибоп-саксофонистов - играет на концерте.");
  });
});
