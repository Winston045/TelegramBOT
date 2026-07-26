import { describe, expect, it } from "vitest";
import {
  validateCaption,
  validateHtml,
  validateYears,
  visibleLength,
} from "../src/validate.js";

const CAPTION =
  '<b>Танкисты</b> у танка Т-34-85. <i>1945 год.</i>\n\n' +
  "<blockquote>Надпись на стволе пушки — «Победа за нами».</blockquote>\n\n" +
  '<a href="https://t.me/Story_Teams">STORY | TEAM</a>';

const meta = { title: "T-34-85 tank crew, 1945", description: undefined, year: 1945, place: "Berlin" };

describe("validateHtml", () => {
  it("принимает эталонную подпись", () => {
    expect(validateHtml(CAPTION)).toEqual({ ok: true });
  });
  it("запрещает посторонние теги", () => {
    expect(validateHtml("<script>x</script>").ok).toBe(false);
    expect(validateHtml("<u>x</u>").ok).toBe(false);
  });
  it("ловит незакрытые и лишние теги", () => {
    expect(validateHtml("<b>жирный").ok).toBe(false);
    expect(validateHtml("текст</b>").ok).toBe(false);
    expect(validateHtml("<b><i>x</b></i>").ok).toBe(false);
  });
  it("у <a> допустим только href, у остальных атрибутов нет", () => {
    expect(validateHtml('<a href="https://x.y">z</a>').ok).toBe(true);
    expect(validateHtml('<a onclick="js">z</a>').ok).toBe(false);
    expect(validateHtml('<b class="x">z</b>').ok).toBe(false);
  });
  it("ловит голые < и >", () => {
    expect(validateHtml("a < b").ok).toBe(false);
  });
});

describe("validateYears", () => {
  it("год из метаданных — ок", () => {
    expect(validateYears(CAPTION, meta)).toEqual({ ok: true });
  });
  it("выдуманный год — брак", () => {
    expect(validateYears("<i>1946 год.</i>", meta).ok).toBe(false);
  });
  it("год берётся и из title, и из поля year", () => {
    expect(validateYears("<i>1945 год.</i>", { ...meta, year: undefined }).ok).toBe(true);
    expect(validateYears("<i>1945 год.</i>", { ...meta, title: undefined }).ok).toBe(true);
  });
});

describe("validateCaption", () => {
  it("эталон проходит целиком", () => {
    expect(validateCaption(CAPTION, meta)).toEqual({ ok: true });
  });
  it("режет длиннее 1024 видимых символов", () => {
    const long = "<b>Т</b>" + "х".repeat(1030);
    expect(validateCaption(long, meta).ok).toBe(false);
  });
  it("теги не считаются в длину", () => {
    const okLen = "<b>" + "х".repeat(1000) + "</b>";
    expect(visibleLength(okLen)).toBe(1000);
    expect(validateCaption(okLen, meta).ok).toBe(true);
  });
});
