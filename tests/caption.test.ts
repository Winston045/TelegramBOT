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

  it("quote_place без цитаты рендерится обычной цитатой места и года", () => {
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
    expect(html).toContain(
      "Немецкие солдаты перед расстрелом группы советских партизан.\n" +
        "<blockquote expandable>Север СССР, 1941 год.</blockquote>",
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

  it("требует обоснование балла и запрещает завышать оценку рутине", () => {
    const prompt = buildAnalysisPrompt(
      { sourceId: "1", sourceUrl: "https://x", imageUrl: "https://x.jpg", lang: "en", license: "PD" },
      {},
    );
    expect(prompt).toContain("score_why");
    expect(prompt).toContain("Средний архивный кадр это 45-55");
    expect(prompt).toContain("учения и подготовка в тылу");
  });

  it("разрешает вывести страну из описания, когда топонима нет", () => {
    const prompt = buildAnalysisPrompt(
      { sourceId: "1", sourceUrl: "https://x", imageUrl: "https://x.jpg", lang: "en", license: "PD" },
      {},
    );
    expect(prompt).toContain("Года без места быть не должно");
  });
});

describe("placeToQuote (лекарь: дата из тела в цитату)", async () => {
  const { placeToQuote, isBarePlaceDate } = await import("../scripts/fix-place.js");

  it("отличает голые место и дату от справки", () => {
    expect(isBarePlaceDate("Италия, 1943 год.")).toBe(true);
    expect(isBarePlaceDate("Район Арраса, Франция. 19 июля 1918 года.")).toBe(true);
    expect(isBarePlaceDate("Трал ПТ-3 выдерживал от пяти до десяти детонаций.")).toBe(false);
    expect(
      isBarePlaceDate(
        "В 1943 году она участвовала в строительстве бензопровода, проложенного по дну Ладожского озера и ставшего для осажденного Ленинграда артерией жизни.",
      ),
    ).toBe(false);
  });

  it("дата из последней строки тела переезжает в цитату", () => {
    const broken =
      "Немецкие солдаты перед расстрелом группы советских партизан.\n" +
      "Север СССР, 1941 год.\n\n" +
      '<a href="https://t.me/Story_Teams">STORY | TEAM</a>';
    expect(placeToQuote(broken)).toBe(
      "Немецкие солдаты перед расстрелом группы советских партизан.\n" +
        "<blockquote expandable>Север СССР, 1941 год.</blockquote>\n\n" +
        '<a href="https://t.me/Story_Teams">STORY | TEAM</a>',
    );
  });

  it("изюминку с цитатой и датой в теле не трогает", () => {
    const gem =
      "Британский танк Sherman III в районе Бенгази.\n" +
      "Ливия, декабрь 1942 года.\n" +
      "<blockquote expandable>В 1942 году Бенгази стал ареной ожесточенных боев.</blockquote>\n\n" +
      '<a href="https://t.me/Story_Teams">STORY | TEAM</a>';
    expect(placeToQuote(gem)).toBeNull();
  });

  it("описание без даты в конце не трогает", () => {
    const plain =
      "Немецкие парашютисты люфтваффе во время перекура.\n" +
      "Они находятся в Италии уже второй месяц.\n\n" +
      '<a href="https://t.me/Story_Teams">STORY | TEAM</a>';
    expect(placeToQuote(plain)).toBeNull();
  });

  it("подпись без переносов не трогает", () => {
    expect(placeToQuote('Текст.\n\n<a href="x">X</a>')).toBeNull();
  });
});

describe("страховка формата обычного поста", () => {
  it("дата последней строкой тела без цитаты уходит в цитату", () => {
    const html = assembleCaptionHtml(
      {
        caption:
          "Прибытие эшелона с венгерскими евреями в концентрационный лагерь Аушвиц.\nОсвенцим, 1944 год.",
        quote: "",
        quote_kind: "context",
      },
      { license: "PD" },
      channel,
    );
    expect(html).toBe(
      "Прибытие эшелона с венгерскими евреями в концентрационный лагерь Аушвиц.\n" +
        "<blockquote expandable>Освенцим, 1944 год.</blockquote>\n\n" +
        '<a href="https://t.me/Story_Teams">STORY | TEAM</a>',
    );
  });

  it("изюминку с датой в теле не трогает", () => {
    const html = assembleCaptionHtml(
      {
        caption: "Британский танк Sherman III в районе Бенгази.\nЛивия, декабрь 1942 года.",
        quote: "В 1942 году Бенгази стал ареной ожесточённых боёв.",
        quote_kind: "context",
      },
      { license: "PD" },
      channel,
    );
    expect(html).toContain("Ливия, декабрь 1942 года.\n<blockquote expandable>В 1942 году");
  });

  it("описание из двух предложений без даты не трогает", () => {
    const html = assembleCaptionHtml(
      {
        caption: "Немецкие парашютисты во время перекура.\nОни ждут погрузки в транспортник.",
        quote: "",
        quote_kind: "context",
      },
      { license: "PD" },
      channel,
    );
    expect(html).not.toContain("blockquote");
  });
});
