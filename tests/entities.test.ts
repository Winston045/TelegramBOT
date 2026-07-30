import { describe, expect, it } from "vitest";
import {
  entitiesToHtml,
  escapeHtml,
} from "../supabase/functions/_shared/entities.js";
import {
  replaceBody,
  replaceQuote,
  splitFooter,
} from "../supabase/functions/_shared/edit_caption.js";

describe("entitiesToHtml", () => {
  it("без сущностей — просто экранированный текст", () => {
    expect(entitiesToHtml("a < b & c")).toBe("a &lt; b &amp; c");
  });

  it("bold, italic, blockquote, text_link", () => {
    const text = "Танкисты у машины. 1945 год.";
    expect(
      entitiesToHtml(text, [
        { type: "bold", offset: 0, length: 8 },
        { type: "italic", offset: 19, length: 9 },
      ]),
    ).toBe("<b>Танкисты</b> у машины. <i>1945 год.</i>");

    expect(
      entitiesToHtml("цитата тут", [{ type: "blockquote", offset: 0, length: 10 }]),
    ).toBe("<blockquote>цитата тут</blockquote>");
    expect(
      entitiesToHtml("цитата тут", [
        { type: "expandable_blockquote", offset: 0, length: 10 },
      ]),
    ).toBe("<blockquote expandable>цитата тут</blockquote>");

    expect(
      entitiesToHtml("STORY | TEAM", [
        { type: "text_link", offset: 0, length: 12, url: "https://t.me/Story_Teams" },
      ]),
    ).toBe('<a href="https://t.me/Story_Teams">STORY | TEAM</a>');
  });

  it("вложенные сущности", () => {
    expect(
      entitiesToHtml("жирный курсив", [
        { type: "bold", offset: 0, length: 13 },
        { type: "italic", offset: 7, length: 6 },
      ]),
    ).toBe("<b>жирный <i>курсив</i></b>");
  });

  it("неподдерживаемые типы опускаются до простого текста", () => {
    expect(
      entitiesToHtml("код тут", [{ type: "code", offset: 0, length: 3 }]),
    ).toBe("код тут");
  });

  it("экранирует спецсимволы внутри сущностей", () => {
    expect(
      entitiesToHtml("a<b", [{ type: "bold", offset: 0, length: 3 }]),
    ).toBe("<b>a&lt;b</b>");
  });

  it("эмодзи (суррогатные пары) не ломают смещения", () => {
    // "📷 фото" — эмодзи занимает 2 UTF-16 code units, offset жирного = 3
    expect(
      entitiesToHtml("📷 фото", [{ type: "bold", offset: 3, length: 4 }]),
    ).toBe("📷 <b>фото</b>");
  });
});

const CAPTION =
  "<b>Танкисты</b> у танка. <i>1945 год.</i>\n\n" +
  "<blockquote>Старая цитата.</blockquote>\n\n" +
  'Bundesarchiv, Koch / CC BY-SA 3.0 de\n<a href="https://t.me/Story_Teams">STORY | TEAM</a>';

describe("splitFooter", () => {
  it("отделяет футер с атрибуцией и подписью канала", () => {
    const { body, footer } = splitFooter(CAPTION);
    expect(body).toBe(
      "<b>Танкисты</b> у танка. <i>1945 год.</i>\n\n<blockquote>Старая цитата.</blockquote>",
    );
    expect(footer).toBe(
      'Bundesarchiv, Koch / CC BY-SA 3.0 de\n<a href="https://t.me/Story_Teams">STORY | TEAM</a>',
    );
  });
});

describe("replaceQuote", () => {
  it("заменяет существующую цитату, футер не трогает", () => {
    const updated = replaceQuote(CAPTION, "Новая деталь & факт.");
    expect(updated).toContain("<blockquote expandable>Новая деталь &amp; факт.</blockquote>");
    expect(updated).not.toContain("Старая цитата");
    expect(updated).toContain('<a href="https://t.me/Story_Teams">STORY | TEAM</a>');
  });

  it("добавляет цитату, если её не было", () => {
    const noQuote =
      "<b>Т</b> у танка.\n\n" + '<a href="https://t.me/Story_Teams">STORY | TEAM</a>';
    const updated = replaceQuote(noQuote, "Деталь.");
    expect(updated).toBe(
      "<b>Т</b> у танка.\n<blockquote expandable>Деталь.</blockquote>\n\n" +
        '<a href="https://t.me/Story_Teams">STORY | TEAM</a>',
    );
  });
});

describe("replaceBody", () => {
  it("меняет тело, сохраняя футер", () => {
    const updated = replaceBody(CAPTION, "<b>Экипаж</b> на отдыхе. <i>1945 год.</i>");
    expect(updated).toBe(
      "<b>Экипаж</b> на отдыхе. <i>1945 год.</i>\n\n" +
        'Bundesarchiv, Koch / CC BY-SA 3.0 de\n<a href="https://t.me/Story_Teams">STORY | TEAM</a>',
    );
  });
});

describe("escapeHtml", () => {
  it("экранирует & < >", () => {
    expect(escapeHtml('<a href="x">&</a>')).toBe('&lt;a href="x"&gt;&amp;&lt;/a&gt;');
  });
});
