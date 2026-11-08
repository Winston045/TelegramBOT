import { describe, expect, it, vi } from "vitest";

/**
 * Общий конвейер подписи (src/pipeline.ts) - один для сбора и
 * предпросмотра. Проверяем порядок: справки → редактор → страховки →
 * рубрика → валидатор.
 */
const wikiCalls: string[] = [];
vi.doMock("../src/wiki.js", () => ({
  subjectReference: async (t: string) => (wikiCalls.push(`subject:${t}`), `Справка о предмете («${t}»): the barque sailed in 1910.`),
  eventReference: async (t: string) => (wikiCalls.push(`event:${t}`), `Справка о событии («${t}»): Scott and four companions died on the return journey in 1912.`),
}));
const criticCalls: Array<{ refs?: string; people?: string[] }> = [];
const criticReply = { value: undefined as undefined | { quote: string; quote_place?: string } };
vi.doMock("../src/critic.js", () => ({
  reviewQuote: async (
    _item: unknown,
    _cfg: unknown,
    generated: { quote: string },
    _extra: unknown,
    refs: string | undefined,
    opts: { people?: string[] },
  ) => {
    criticCalls.push({ refs, people: opts.people });
    return criticReply.value
      ? { caption: { ...generated, ...criticReply.value, quote_kind: "context" }, rewritten: true }
      : { caption: generated, rewritten: false };
  },
}));
const { fetchReferences, finishCaption } = await import("../src/pipeline.js");
const { RUBRICS } = await import("../src/rubrics.js");

const cfg = { channel: { name: "STORY | TEAM", url: "https://t.me/x", signature: "STORY | TEAM" } } as never;
const item = {
  sourceId: "1",
  sourceUrl: "https://x",
  imageUrl: "https://x.jpg",
  title: "Terra Nova in the ice, 1910",
  lang: "en",
  license: "PD",
  year: 1910,
  place: "Antarctica",
  source: "events",
};
const analysis = {
  score: 70,
  tags: { hook: "moment" },
  caption: "Барк «Терра Нова» британской экспедиции Роберта Скотта во льдах.",
  quote: "Антарктида, 1910 год.",
  quote_kind: "context" as const,
  subject_wiki: "Terra Nova (ship)",
  event_wiki: "Terra Nova Expedition",
} as never;
const direct = (call: () => Promise<never>) => call();

describe("справки", () => {
  it("о предмете и о событии - обе; одна статья дважды не запрашивается", async () => {
    wikiCalls.length = 0;
    const both = await fetchReferences({ subject_wiki: "Terra Nova (ship)", event_wiki: "Terra Nova Expedition" });
    expect(both.subject).toContain("Terra Nova (ship)");
    expect(both.event).toContain("Terra Nova Expedition");
    wikiCalls.length = 0;
    await fetchReferences({ subject_wiki: "Terra Nova Expedition", event_wiki: "terra nova expedition" });
    expect(wikiCalls).toEqual(["subject:Terra Nova Expedition"]);
  });
});

describe("конвейер", () => {
  it("редактор видит обе справки и людей; ставки проходят валидатор", async () => {
    criticCalls.length = 0;
    criticReply.value = {
      quote: "Из этой экспедиции Скотт не вернулся: вместе с четырьмя спутниками он погиб на обратном пути с полюса в 1912 году.",
    };
    const done = await finishCaption({ item, cfg, analysis, full: true, review: direct, log: () => {} });
    expect(criticCalls[0]?.refs).toContain("Справка о предмете");
    expect(criticCalls[0]?.refs).toContain("Справка о событии");
    expect(done.check.ok).toBe(true);
    expect(done.html).toContain("Скотт не вернулся");
  });

  it("штамп редактора не проходит - остаётся первый заход", async () => {
    criticReply.value = { quote: "Барк стал настоящим символом эпохи полярных открытий." };
    const done = await finishCaption({ item, cfg, analysis, full: true, review: direct, log: () => {} });
    expect(done.html).not.toContain("символом");
    expect(done.html).toContain("Антарктида, 1910 год.");
  });

  it("на исходе бюджета - без справок и редактора", async () => {
    wikiCalls.length = 0;
    criticCalls.length = 0;
    const done = await finishCaption({ item, cfg, analysis, full: false, review: direct, log: () => {} });
    expect(wikiCalls).toHaveLength(0);
    expect(criticCalls).toHaveLength(0);
    expect(done.check.ok).toBe(true);
  });

  it("кадр рубрики без изюминки - флаг рубрики, а не запись", async () => {
    criticReply.value = undefined;
    const done = await finishCaption({
      item,
      cfg,
      analysis,
      rubric: RUBRICS.ussr_daily,
      full: true,
      review: direct,
      log: () => {},
    });
    expect(done.rubricFlaw).toBeTruthy();
  });
});
