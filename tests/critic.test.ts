import { describe, expect, it } from "vitest";
import { duplicatesPlace } from "../src/critic.js";

describe("duplicatesPlace", () => {
  it("совпадение с точностью до пунктуации и регистра - дубль", () => {
    expect(duplicatesPlace("Тихий океан 1945 год", "Тихий океан, 1945 год.")).toBe(true);
    expect(duplicatesPlace("СССР, 1943 год.", "ссср 1943 год")).toBe(true);
  });

  it("вложение в одну из сторон - тоже дубль", () => {
    expect(duplicatesPlace("Австрия, 1946 год", "Австрия, 1946")).toBe(true);
  });

  it("другое место или дата - не дубль", () => {
    expect(duplicatesPlace("Ливия, декабрь 1942 года.", "Тихий океан, 1945 год.")).toBe(false);
  });

  it("настоящий факт не путается с местом и датой", () => {
    expect(
      duplicatesPlace("Трал ПТ-3 выдерживал от пяти до десяти детонаций.", "Лето 1943 года."),
    ).toBe(false);
  });

  it("без quote_place дубля нет", () => {
    expect(duplicatesPlace("СССР, 1943 год.", undefined)).toBe(false);
  });
});

describe("редактор цитаты: изюминка о предмете в кадре", async () => {
  const { vi, beforeEach } = await import("vitest");
  const reply = { value: {} as Record<string, unknown> };
  const calls: string[] = [];
  vi.doMock("../src/gemini.js", () => ({
    geminiJson: async (parts: Array<{ text: string }>) => {
      calls.push(parts[0]!.text);
      return reply.value;
    },
  }));
  // critic.js уже загружен статическим импортом вверху - без сброса
  // модулей подмена gemini.js до него не дойдёт
  vi.resetModules();
  const { reviewQuote, buildPrompt } = await import("../src/critic.js");
  const cfg = {} as never;
  const item = {
    sourceId: "1",
    sourceUrl: "https://x",
    imageUrl: "https://x.jpg",
    title: "Allied observation balloon Ypres 1917",
    lang: "en",
    license: "PD",
    year: 1917,
    place: "Ypres",
  };
  const base = {
    caption: "Британские солдаты готовят к подъёму аэростат наблюдения на фоне руин Ипра.",
    quote: "Ипр, Бельгия, 1917 год.",
    quote_kind: "context" as const,
  };
  const subject = "Справка из Википедии о предмете в кадре («Привязной аэростат»): ...";

  beforeEach(() => {
    calls.length = 0;
  });

  it("обычный пост без справки о предмете редактор не трогает - квота цела", async () => {
    const r = await reviewQuote(item, cfg, base);
    expect(r.rewritten).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("со справкой обычный пост становится изюминкой, место и год уходят второй цитатой", async () => {
    reply.value = { verdict: "weak", quote: "Наблюдатель поднимался на километр и корректировал огонь по проводу в тросе.", quote_kind: "context" };
    const r = await reviewQuote(item, cfg, base, undefined, subject);
    expect(r.rewritten).toBe(true);
    expect(r.caption.quote).toContain("Наблюдатель");
    expect(r.caption.quote_place).toBe("Ипр, Бельгия, 1917 год.");
    expect(calls[0]).toContain("Привязной аэростат");
  });

  it("если сильного факта нет, обычный пост остаётся обычным", async () => {
    reply.value = { verdict: "weak", quote: "Бельгия, 1917 год.", quote_kind: "context" };
    const r = await reviewQuote(item, cfg, base, undefined, subject);
    expect(r.rewritten).toBe(false);
    expect(r.caption).toEqual(base);
  });

  it("промпт запрещает штабные сводки и требует фактов только из справок", () => {
    const prompt = buildPrompt(item, base, undefined, subject);
    expect(prompt).toContain("штабная сводка");
    expect(prompt).toContain("СТРОГО из метаданных и справок");
    expect(prompt).toContain("Привязной аэростат");
    expect(buildPrompt(item, base)).toContain("Справки о предмете в кадре нет");
  });
});

describe("копия примера из промпта", async () => {
  const { copiesExample, guardCopies } = await import("../src/factcheck.js");
  const copied =
    "Таран был только половиной плана. В носу старого эсминца замуровали в бетон больше четырёх тонн взрывчатки с часовыми взрывателями. Немцы ходили по застрявшему кораблю, когда наутро он взорвался.";
  const own = "До рейда эсминец успел послужить в трёх флотах: американском, британском и нидерландском.";

  it("почти дословный пересказ примера - копия, своя изюминка - нет", () => {
    expect(copiesExample(copied)).toBe(true);
    expect(copiesExample(own)).toBe(false);
    expect(copiesExample("Сен-Назер, Франция, март 1942 года.")).toBe(false);
  });

  it("копия первого захода уступает своей правке редактора, иначе - место и год", () => {
    const first = { caption: "Эсминец.", quote: copied, quote_place: "Сен-Назер, 1942 год.", quote_kind: "context" as const };
    expect(guardCopies({ caption: { ...first, quote: own }, rewritten: true }, first).outcome).toBe("ok");
    expect(guardCopies({ caption: first, rewritten: false }, first)).toMatchObject({
      outcome: "quote_dropped",
      caption: { quote: "Сен-Назер, 1942 год." },
    });
  });
});
