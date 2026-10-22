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
  it("свёрнутая цитата: expandable разрешён, прочие атрибуты нет", () => {
    expect(validateHtml("<blockquote expandable>x</blockquote>").ok).toBe(true);
    expect(validateHtml('<blockquote class="x">x</blockquote>').ok).toBe(false);
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

  it("десятилетия и даты в метаданных: '1930s' разрешает 1930-е в подписи", () => {
    const m = { title: "restored during the 1930s", description: undefined, year: 1943, place: "x" };
    expect(validateYears("Реставрация 1930-х. <i>1943 год.</i>", m).ok).toBe(true);
    const m2 = { title: "Polen, Lublin 30.12.1939", description: undefined, year: undefined, place: "x" };
    expect(validateYears("<i>Декабрь 1939 года.</i>", m2).ok).toBe(true);
  });

  it("год из документального контекста - легальный, как из метаданных", () => {
    // промпт разрешает факты «строго из метаданных И контекста», а
    // валидатор знал только метаданные - и браковал изюминку с датой
    // из вики-справки (репортаж о визите Гамсуна вышел 3 августа 1944,
    // хотя снимок датирован июнем)
    const m = {
      ...meta,
      context: "Репортаж о визите вышел в Illustrierter Beobachter 3 августа 1944 года.",
    };
    expect(validateYears("<blockquote>Репортаж вышел в 1944 году.</blockquote>", m).ok).toBe(true);
    // но год, которого нет нигде - по-прежнему брак
    expect(validateYears("<blockquote>Репортаж вышел в 1947 году.</blockquote>", m).ok).toBe(false);
  });

  it("цифры шифра и номера описи годом не считаются", () => {
    // у Бундесархива «1985» в шифре - год регистрации негатива, а кадр 1942-го
    const bild = {
      title: "Bundesarchiv Bild 183-1985-0110-500, Russland, Panzer",
      description: undefined,
      year: 1942,
      place: "Russland",
    };
    expect(validateYears("<blockquote>Россия, 1942 год.</blockquote>", bild).ok).toBe(true);
    expect(validateYears("<blockquote>Россия, 1985 год.</blockquote>", bild).ok).toBe(false);
    // номер записи NARA содержит «1983», но это не год
    const nara = { title: "Marines advance, NARA 519838", description: undefined, year: 1944, place: "Saipan" };
    expect(validateYears("<blockquote>Сайпан, 1983 год.</blockquote>", nara).ok).toBe(false);
    const loc = { title: "LC-USW3-018391-E", description: undefined, year: 1943, place: "Chicago" };
    expect(validateYears("<blockquote>Чикаго, 1839 год.</blockquote>", loc).ok).toBe(false);
  });

  it("даты и диапазоны через дефис остаются годами", () => {
    const m = { title: "Landing 1944-06-06; patrol 12-15-1944; Juni-Juli-1943, 1941-1945", place: "x" };
    for (const y of ["1944", "1943", "1941", "1945"]) {
      expect(validateYears(`<blockquote>${y} год.</blockquote>`, m).ok, y).toBe(true);
    }
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
  it("пост без текста - только цитата и ссылка - брак", () => {
    // слабая модель однажды может забыть подпись: такой пост раньше
    // проходил валидацию целиком
    const bare =
      "<blockquote expandable>Италия, 1944 год.</blockquote>\n\n" +
      '<a href="https://t.me/Story_Teams">STORY | TEAM</a>';
    expect(validateCaption(bare, meta).ok).toBe(false);
  });

  it("теги не считаются в длину", () => {
    const okLen = "<b>" + "х".repeat(1000) + "</b>";
    expect(visibleLength(okLen)).toBe(1000);
    expect(validateCaption(okLen, meta).ok).toBe(true);
  });
});

describe("числа изюминки - только из источников", async () => {
  const { unsupportedNumbers } = await import("../src/validate.js");
  const { guardNumbers } = await import("../src/factcheck.js");

  it("число из справки - можно, из головы модели - нельзя", () => {
    const src = "ISU-152 weighed 47.3 tonnes; 152 mm howitzer; crew of 5";
    expect(unsupportedNumbers("Самоходка весила 47,3 тонны и несла 152-мм гаубицу.", src)).toEqual([]);
    expect(unsupportedNumbers("Самоходка весила 46 тонн.", src)).toEqual(["46"]);
  });

  it("годы и однозначные числа не в счёт, разряды склеиваются", () => {
    expect(unsupportedNumbers("В 1944 году пять машин.", "")).toEqual([]);
    expect(unsupportedNumbers("Высота 1 600 метров.", "altitude 1600 m")).toEqual([]);
  });

  it("числа словами ловятся так же, как цифрами", () => {
    const src = "ISU-152 weighed 47.3 tonnes; crew of five; 4,075 built";
    expect(unsupportedNumbers("Самоходка весила сорок шесть тонн.", src)).toEqual(["46"]);
    expect(unsupportedNumbers("Таких машин построили около четырёх тысяч.", src)).toEqual(["4000"]);
    expect(unsupportedNumbers("Выпустили полторы тысячи машин.", "1,500 vehicles")).toEqual([]);
    expect(unsupportedNumbers("Двести пятьдесят танков.", "two hundred and fifty tanks")).toEqual([]);
  });

  it("обороты речи - не числа", () => {
    expect(unsupportedNumbers("Тысячи солдат и сотни машин, десятки орудий.", "")).toEqual([]);
    expect(unsupportedNumbers("Один из пяти экипажей вернулся с семьёй.", "")).toEqual([]);
    // год словами - всё равно год, его держит validateYears
    expect(unsupportedNumbers("В тысяча девятьсот сорок первом.", "")).toEqual([]);
  });

  it("множитель после цифр: «47 тысяч» равно «47,000» источника", () => {
    expect(unsupportedNumbers("Погибли 47 тысяч человек.", "about 47,000 dead")).toEqual([]);
    expect(unsupportedNumbers("Тираж 1,5 млн экземпляров.", "1.5 million copies")).toEqual([]);
    expect(unsupportedNumbers("Погибли 50 тысяч человек.", "about 47,000 dead")).toEqual(["50000"]);
  });

  it("плохая правка редактора уступает первому заходу, плохой первый заход - снимается", () => {
    const first = { caption: "Т.", quote: "Самоходка весила 47,3 тонны.", quote_kind: "context" as const, quote_place: "Будапешт, 1956 год." };
    const edited = { ...first, quote: "Самоходка весила 46 тонн." };
    const src = "weighed 47.3 tonnes";
    expect(guardNumbers({ caption: edited, rewritten: true }, first, src)).toMatchObject({
      outcome: "editor_rejected",
      caption: first,
    });
    expect(guardNumbers({ caption: edited, rewritten: false }, edited, src)).toMatchObject({
      outcome: "quote_dropped",
      caption: { quote: "Будапешт, 1956 год.", quote_place: undefined },
    });
  });
});
