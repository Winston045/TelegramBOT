import { describe, expect, it } from "vitest";
import { assembleCaptionHtml, needsAttribution } from "../src/caption.js";
import { buildAnalysisPrompt } from "../src/analyze.js";
import { validateCaption } from "../src/validate.js";

const channel = {
  id: "@Story_Teams",
  signature: "STORY | TEAM",
  signature_url: "https://t.me/Story_Teams",
};

const generated = {
  caption: "<b>Танкисты</b> у танка Т-34-85. <i>1945 год.</i>",
  quote: "Надпись на стволе пушки — «Победа за нами».",
  quote_kind: "observation" as const,
};

describe("needsAttribution", () => {
  it("PD — нет, CC-BY-SA — да", () => {
    expect(needsAttribution("PD")).toBe(false);
    expect(needsAttribution("CC BY-SA 3.0 de")).toBe(true);
    expect(needsAttribution("CC-BY-SA-4.0")).toBe(true);
  });
});

describe("assembleCaptionHtml", () => {
  it("PD: подпись + цитата вплотную + подпись канала, без атрибуции", () => {
    const html = assembleCaptionHtml(generated, { license: "PD" }, channel);
    expect(html).toBe(
      "<b>Танкисты</b> у танка Т-34-85. <i>1945 год.</i>\n" +
        "<blockquote expandable>Надпись на стволе пушки - «Победа за нами».</blockquote>\n\n" +
        '<a href="https://t.me/Story_Teams">STORY | TEAM</a>',
    );
  });

  it("CC-BY-SA: атрибуция в пост не добавляется (решение редакции)", () => {
    const html = assembleCaptionHtml(
      generated,
      { license: "CC BY-SA 3.0 de", attribution: "Bundesarchiv, Koch / CC BY-SA 3.0 de" },
      channel,
    );
    expect(html).not.toContain("Bundesarchiv");
    expect(html).toContain('<a href="https://t.me/Story_Teams">STORY | TEAM</a>');
  });

  it("место и дата отдельной второй цитатой - эталонный формат 12.2024", () => {
    const html = assembleCaptionHtml(
      {
        caption: "Крейсер «Яхаги» под ударами американских самолетов.",
        quote: "В 12:46 торпеда попала в машинное отделение.",
        quote_place: "Тихий океан, 1945 год.",
        quote_kind: "context",
      },
      { license: "PD" },
      channel,
    );
    expect(html).toContain(
      "<blockquote expandable>В 12:46 торпеда попала в машинное отделение.</blockquote>\n" +
        "<blockquote>Тихий океан, 1945 год.</blockquote>",
    );
  });

  it("короткий пост: quote_place уходит в тело, а не в блок цитаты", () => {
    const html = assembleCaptionHtml(
      {
        caption: "Немецкие солдаты перед расстрелом группы советских партизан.",
        quote: "",
        quote_place: "Север СССР, 1941 год.",
        quote_kind: "context",
      },
      { license: "PD" },
      channel,
    );
    expect(html).not.toContain("blockquote");
    expect(html).toContain(
      "Немецкие солдаты перед расстрелом группы советских партизан.\nСевер СССР, 1941 год.",
    );
  });

  it("без цитаты blockquote не появляется", () => {
    const html = assembleCaptionHtml(
      { ...generated, quote: "" },
      { license: "PD" },
      channel,
    );
    expect(html).not.toContain("blockquote");
  });

  it("итог проходит валидацию подписи", () => {
    const html = assembleCaptionHtml(generated, { license: "PD" }, channel);
    expect(
      validateCaption(html, { title: "T-34-85, 1945", description: undefined, year: 1945, place: "Berlin" }),
    ).toEqual({ ok: true });
  });
});

describe("buildAnalysisPrompt", () => {
  it("включает метаданные, глоссарий, правила подписи и критерии оценки", () => {
    const prompt = buildAnalysisPrompt(
      {
        sourceId: "1",
        sourceUrl: "https://x",
        imageUrl: "https://x.jpg",
        title: "Königsberg street",
        lang: "de",
        year: 1940,
        place: "Königsberg",
        license: "PD",
      },
      { Königsberg: "Кёнигсберг" },
    );
    expect(prompt).toContain("Königsberg street");
    expect(prompt).toContain('"Königsberg" → "Кёнигсберг"');
    expect(prompt).toContain("НЕ ДОБАВЛЯЙ фактов");
    expect(prompt).toContain("1940");
    expect(prompt).toContain("score");
    expect(prompt).toContain("quote_place");
  });
});

describe("unquotePlace (лекарь партии 08.08)", async () => {
  const { unquotePlace } = await import("../scripts/fix-place.js");

  it("одиночный не-expandable blockquote переносится в тело", () => {
    const broken =
      "Немецкие солдаты перед расстрелом группы советских партизан.\n" +
      "<blockquote>Север СССР, 1941 год.</blockquote>\n\n" +
      '<a href="https://t.me/Story_Teams">STORY | TEAM</a>';
    expect(unquotePlace(broken)).toBe(
      "Немецкие солдаты перед расстрелом группы советских партизан.\n" +
        "Север СССР, 1941 год.\n\n" +
        '<a href="https://t.me/Story_Teams">STORY | TEAM</a>',
    );
  });

  it("изюминку с expandable-цитатой не трогает", () => {
    const ok =
      "Крейсер «Яхаги».\n<blockquote expandable>Факт.</blockquote>\n" +
      "<blockquote>Тихий океан, 1945 год.</blockquote>\n\n" +
      '<a href="https://t.me/Story_Teams">STORY | TEAM</a>';
    expect(unquotePlace(ok)).toBeNull();
  });

  it("подпись без блоков не трогает", () => {
    expect(unquotePlace("Текст.\n\n<a href=\"x\">X</a>")).toBeNull();
  });
});
