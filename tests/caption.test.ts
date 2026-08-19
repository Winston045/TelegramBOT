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

  it("описывает крючки поста примерами из ручной редактуры канала", () => {
    const prompt = buildAnalysisPrompt(
      { sourceId: "1", sourceUrl: "https://x", imageUrl: "https://x.jpg", lang: "en", license: "PD" },
      {},
    );
    expect(prompt).toContain('"hook"');
    for (const hook of ["trophy", "wreck", "moment", "rare", "oddity", "human", "action", "none"]) {
      expect(prompt).toContain(hook);
    }
    // поза не мешает трофею: так отбирала живая редакция
    expect(prompt).toContain("Поза тут не мешает");
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

describe("описание в одно предложение", async () => {
  const { descriptiveSentences } = await import("../src/caption.js");

  it("сегодняшние хорошие посты - ровно одно предложение", () => {
    expect(
      descriptiveSentences("Женщина с двумя дочерьми смотрит на руины своего сожжённого дома."),
    ).toBe(1);
    expect(
      descriptiveSentences("Тело генерала пехоты вермахта Антона Достлера у столба сразу после расстрела."),
    ).toBe(1);
  });

  it("строка места и года в теле изюминки за предложение не считается", () => {
    expect(
      descriptiveSentences(
        "Британский самолет-тральщик Vickers Wellington DWI Mark II на аэродроме в Исмаилии.\nЕгипет, 1940 год.",
      ),
    ).toBe(1);
    // эталон 6 из промпта: год стоит в той же строке, а не отдельной
    expect(
      descriptiveSentences(
        "Колонна немецких средних Pz.III J и Pz.III L из 12-й танковой дивизии вермахта зимой на Восточном фронте. 1942 г.",
      ),
    ).toBe(1);
  });

  it("вьетнамский пост ловится: справка уехала во второе предложение", () => {
    expect(
      descriptiveSentences(
        "Бойцы роты C 502-го пехотного полка 101-й воздушно-десантной дивизии США поднимаются по крутому склону в поисках сил Вьетконга. " +
          "Снимок сделан во время операции «Харрисон» в горном районе близ Туихоа.",
      ),
    ).toBe(2);
  });
});

describe("правила подписи закрывают дыры вьетнамского поста", () => {
  const prompt = buildAnalysisPrompt(
    { sourceId: "1", sourceUrl: "https://x", imageUrl: "https://x.jpg", lang: "en", license: "PD" },
    {},
  );

  it("описание - одно предложение, а не два", () => {
    expect(prompt).toContain("ОДНО ёмкое предложение");
    expect(prompt).toContain("описание в ОДНО предложение");
    expect(prompt).not.toContain("МАКСИМУМ в два предложения");
  });

  it("номенклатура ограничена одной ступенью", () => {
    expect(prompt).toContain("ОДНА СТУПЕНЬ, НЕ ЦЕПОЧКА");
  });

  it("«снимок сделан» в списке запрещённых штампов", () => {
    expect(prompt).toContain("снимок сделан во");
  });

  it("место не называется дважды", () => {
    expect(prompt).toContain("МЕСТО НАЗЫВАЕТСЯ ОДИН РАЗ");
  });
});

describe("длинные тире не уходят в Телеграм", async () => {
  const { plainDashes } = await import("../src/telegram.js");

  it("меняет все виды длинного тире на дефис", () => {
    expect(plainDashes("Берлин — 1945")).toBe("Берлин - 1945");
    expect(plainDashes("1941–1945")).toBe("1941-1945");
    expect(plainDashes("шкала −5")).toBe("шкала -5");
    expect(plainDashes("текст ― вставка")).toBe("текст - вставка");
  });

  it("обычный дефис и минус в числах не трогает", () => {
    expect(plainDashes("Т-34-85, 8,8-см")).toBe("Т-34-85, 8,8-см");
  });

  it("сборка подписи не оставляет длинных тире", () => {
    const html = assembleCaptionHtml(
      {
        caption: "Танкисты — на трофейном «Тигре».",
        quote: "Курская дуга — июль 1943 года.",
        quote_kind: "context",
      },
      { license: "PD" },
      channel,
    );
    expect(html).not.toMatch(/[‒–—―−]/);
  });
});
