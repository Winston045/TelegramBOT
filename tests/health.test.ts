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
