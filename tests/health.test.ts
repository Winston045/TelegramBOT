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

  it("анализ почти весь пропал - называем квоту, а не источники", () => {
    const problems = findProblems(run({ analyzed: 8, written: 1 }), week);
    expect(problems.some((p) => p.text.includes("квота Gemini"))).toBe(true);
  });

  it("без истории сравнение с нормой не срабатывает - не с чем сравнивать", () => {
    const problems = findProblems(run({ written: 6 }), []);
    expect(problems.some((p) => p.text.includes("вдвое меньше"))).toBe(false);
  });
});
