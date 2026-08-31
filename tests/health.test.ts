import { describe, expect, it } from "vitest";
import { findProblems } from "../src/health.js";

const run = (over: Partial<Parameters<typeof findProblems>[0]> = {}) => ({
  raw: 120,
  prefiltered: 80,
  analyzed: 20,
  written: 10,
  sources: { loc: 27, commons: 54, pastvu: 39 },
  ...over,
});

const week = Array.from({ length: 5 }, () => run());

describe("findProblems", () => {
  it("здоровый прогон - молчание", () => {
    expect(findProblems(run(), week)).toEqual([]);
  });

  it("упавший источник называется по имени", () => {
    const problems = findProblems(run({ sources: { loc: -1, commons: 54 } }), week);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.text).toContain("loc");
    expect(problems[0]?.text).toContain("не отвечает");
  });

  it("пустой источник тоже виден", () => {
    const problems = findProblems(run({ sources: { commons: 0 } }), week);
    expect(problems[0]?.text).toContain("ни одной записи");
  });

  it("всё отсеялось префильтром", () => {
    const problems = findProblems(run({ prefiltered: 0, analyzed: 0, written: 0 }), week);
    expect(problems.some((p) => p.text.includes("базовую проверку"))).toBe(true);
  });

  it("до резерва не дошло ничего", () => {
    const problems = findProblems(run({ written: 0 }), week);
    expect(problems.some((p) => p.text.includes("не дошёл до резерва"))).toBe(true);
  });

  it("партия вдвое меньше обычной", () => {
    const problems = findProblems(run({ written: 3 }), week);
    expect(problems.some((p) => p.text.includes("вдвое меньше"))).toBe(true);
  });

  it("анализ почти весь пропал без объяснения - зовём смотреть лог", () => {
    // разбивки отсева у этого прогона нет, значит потери необъяснимы
    const problems = findProblems(run({ analyzed: 8, written: 1 }), week);
    expect(problems.some((p) => p.text.includes("пропали без объяснения"))).toBe(true);
  });

  it("без истории сравнение с нормой не срабатывает - не с чем сравнивать", () => {
    const problems = findProblems(run({ written: 6 }), []);
    expect(problems.some((p) => p.text.includes("вдвое меньше"))).toBe(false);
  });
});

describe("сорванная квота не выдаётся за брак фильтров", () => {
  const run = {
    raw: 110,
    prefiltered: 41,
    analyzed: 29,
    written: 0,
    sources: { commons: 80, loc: 30 },
  };

  it("называет настоящую причину, когда кадры срывала квота", () => {
    const [first] = findProblems({ ...run, quota_failed: 4 }, []);
    expect(first?.text).toContain("сорвана лимитом Gemini");
    expect(first?.text).toContain("Квота сбрасывается в 10:00 МСК");
  });

  it("без отказов по квоте и без разбивки - сообщение без домыслов", () => {
    // разбивки в старых прогонах нет: говорим факт, а не выдумываем причину
    const [first] = findProblems({ ...run, quota_failed: 0 }, []);
    expect(first?.text).toContain("Ни один кадр партии не дошёл до резерва");
    expect(first?.text).not.toContain("брак");
  });
});

describe("диагноз называет состав отсева", () => {
  const run = { raw: 92, prefiltered: 54, analyzed: 6, written: 0, sources: { commons: 60 } };

  it("партия отсеяна ситом - объясняет, что это не поломка", () => {
    // живой прогон 16.08: 4 слабых, 1 без крючка, 1 сорван сбоем Gemini
    const [first] = findProblems({ ...run, junk: 4, hookless: 1, broken: 1, quota_failed: 0 }, []);
    expect(first?.text).toContain("4 слабых по оценке");
    expect(first?.text).toContain("1 без крючка");
    expect(first?.text).toContain("не поломка");
  });

  it("если сито ни при чём - формулировка прежняя, тревожная", () => {
    const [first] = findProblems({ ...run, junk: 0, hookless: 0, broken: 6, quota_failed: 0 }, []);
    expect(first?.text).toContain("Ни один кадр партии не дошёл до резерва");
    expect(first?.text).toContain("6 с браком подписи");
  });
});

describe("низкий выход - не повод для тревоги сам по себе", () => {
  // живой прогон 17.08: 1 из 8, но все потери объяснены отсевом
  const run = { raw: 90, prefiltered: 50, analyzed: 8, written: 1, sources: { commons: 60 } };

  it("молчит, когда потери объяснены ситом", () => {
    const problems = findProblems({ ...run, junk: 5, hookless: 2, broken: 0, quota_failed: 0 }, []);
    expect(problems.map((p) => p.text).join(" ")).not.toContain("До резерва дошло");
  });

  it("не советует добавить ключ, который давно добавлен", () => {
    const problems = findProblems({ ...run, junk: 5, hookless: 2, broken: 0, quota_failed: 0 }, []);
    expect(problems.map((p) => p.text).join(" ")).not.toContain("GEMINI_API_KEYS");
  });

  it("говорит про квоту только когда она реально сорвала кадры", () => {
    const [first] = findProblems({ ...run, junk: 3, hookless: 1, broken: 0, quota_failed: 3 }, []);
    expect(first?.text).toContain("3 кадров сорвал лимит Gemini");
  });

  it("бьёт тревогу, когда кадры пропали необъяснимо", () => {
    const [first] = findProblems({ ...run, junk: 1, hookless: 0, broken: 0, quota_failed: 0 }, []);
    expect(first?.text).toContain("пропали без объяснения");
  });
});

describe("обрыв по бюджету времени называется своим именем", () => {
  // живой прогон 24.08 (вечер): Gemini перегружен, разобрано 3 из 29,
  // в резерв 1 - а сводка предложила искать просевший источник
  const evening = {
    raw: 89,
    prefiltered: 30,
    analyzed: 3,
    written: 1,
    junk: 0,
    hookless: 0,
    broken: 2,
    quota_failed: 0,
    out_of_time: true,
    sources: { commons: 73, loc: 16 },
  };
  const week = Array.from({ length: 5 }, () => ({
    raw: 120,
    prefiltered: 80,
    analyzed: 20,
    written: 10,
    sources: { loc: 27, commons: 54 },
  }));

  it("называет бюджет времени и обещает добор следующим сбором", () => {
    const texts = findProblems(evening, week).map((p) => p.text).join(" ");
    expect(texts).toContain("бюджет времени");
    expect(texts).toContain("возьмёт следующий сбор");
    expect(texts).toContain("квота при этом цела");
  });

  it("не гадает про просевший источник, когда причина известна", () => {
    const texts = findProblems(evening, week).map((p) => p.text).join(" ");
    expect(texts).not.toContain("какой источник просел");
  });

  it("без обрыва сравнение с нормой работает как раньше", () => {
    const texts = findProblems({ ...evening, out_of_time: false, analyzed: 20 }, week)
      .map((p) => p.text)
      .join(" ");
    expect(texts).toContain("вдвое меньше");
  });
});

describe("сбои сети не выдаются за брак подписи", () => {
  // живое утро 25.08: два кадра сорвали 503 и таймаут Gemini, а сводка
  // написала «2 с браком подписи»
  const morning = {
    raw: 84,
    prefiltered: 64,
    analyzed: 2,
    written: 0,
    junk: 0,
    hookless: 0,
    broken: 0,
    net_failed: 2,
    quota_failed: 0,
    out_of_time: true,
    queued: 30,
    sources: { commons: 76, loc: 8 },
  };

  it("называет сбои Gemini и сети своим именем", () => {
    const texts = findProblems(morning, []).map((p) => p.text).join(" ");
    expect(texts).toContain("2 сорваны сбоями Gemini или сети");
    expect(texts).not.toContain("браком подписи");
  });

  it("недождавшиеся считаются от очереди анализа, а не от префильтра", () => {
    const texts = findProblems(morning, []).map((p) => p.text).join(" ");
    expect(texts).toContain("~28 кадров");
    expect(texts).not.toContain("~62");
  });

  it("низкий выход с объяснёнными сетевыми потерями не пугает логом", () => {
    const ok = { ...morning, out_of_time: false, analyzed: 8, written: 2, junk: 4, net_failed: 2 };
    const texts = findProblems(ok, []).map((p) => p.text).join(" ");
    expect(texts).not.toContain("пропали без объяснения");
  });
});

describe("малая партия не сваливается на источники без разбора", () => {
  const week = Array.from({ length: 5 }, () => ({
    raw: 100,
    prefiltered: 60,
    analyzed: 20,
    written: 5,
    sources: { commons: 70, loc: 30 },
  }));

  it("сито съело партию - так и говорит, источники не обвиняет", () => {
    // живой /more 31.08: 6 скучных + 1 брак из 8, в резерв 1
    const run = {
      raw: 106, prefiltered: 60, analyzed: 8, written: 1,
      junk: 6, hookless: 0, broken: 1, net_failed: 0, quota_failed: 0,
      out_of_time: false, queued: 8, sources: { commons: 75, loc: 31 },
    };
    const texts = findProblems(run, week).map((p) => p.text).join(" ");
    expect(texts).toContain("отсеяло сито");
    expect(texts).not.toContain("какой источник просел");
  });

  it("сбои Gemini съели партию - называет их, а не источники", () => {
    const run = {
      raw: 100, prefiltered: 55, analyzed: 8, written: 1,
      junk: 1, hookless: 0, broken: 0, net_failed: 6, quota_failed: 0,
      out_of_time: false, queued: 8, sources: { commons: 70, loc: 30 },
    };
    const texts = findProblems(run, week).map((p) => p.text).join(" ");
    expect(texts).toContain("сбои Gemini или сети");
    expect(texts).not.toContain("какой источник просел");
  });

  it("потери не объяснены - прежняя догадка про источники остаётся", () => {
    const run = {
      raw: 40, prefiltered: 20, analyzed: 20, written: 2,
      junk: 1, hookless: 1, broken: 0, net_failed: 0, quota_failed: 0,
      out_of_time: false, queued: 20, sources: { commons: 30, loc: 10 },
    };
    const texts = findProblems(run, week).map((p) => p.text).join(" ");
    expect(texts).toContain("какой источник просел");
  });
});
