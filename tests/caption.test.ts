import { describe, expect, it } from "vitest";
import {
  assembleCaptionHtml,
  buildCaptionPrompt,
  needsAttribution,
} from "../src/caption.js";
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
        "<blockquote>Надпись на стволе пушки — «Победа за нами».</blockquote>\n\n" +
        '<a href="https://t.me/Story_Teams">STORY | TEAM</a>',
    );
  });

  it("CC-BY-SA: строка атрибуции перед подписью канала", () => {
    const html = assembleCaptionHtml(
      generated,
      { license: "CC BY-SA 3.0 de", attribution: "Bundesarchiv, Koch / CC BY-SA 3.0 de" },
      channel,
    );
    expect(html).toContain(
      'Bundesarchiv, Koch / CC BY-SA 3.0 de\n<a href="https://t.me/Story_Teams">STORY | TEAM</a>',
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

describe("buildCaptionPrompt", () => {
  it("включает метаданные, глоссарий и правила", () => {
    const prompt = buildCaptionPrompt(
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
  });
});
