import { describe, expect, it } from "vitest";
import { STORY_SCHEMA, STORY_TYPES, normalizeStory, storyGuide, storyLine, storyTally } from "../src/story.js";
import { SCORE_FIELDS_SCHEMA } from "../src/scoring.js";
import { buildAnalysisPrompt } from "../src/analyze.js";
import { homeScreen } from "../src/menu.js";

describe("типы сюжетов (редакция 15.11)", () => {
  it("десять видов разметки: девять типов модели плюс «своё» и «цвет» поверх", () => {
    expect(STORY_TYPES.map((t) => t.key)).toEqual([
      "human",
      "twist",
      "oddity",
      "disaster",
      "landmark",
      "daily",
      "science",
      "poster",
      "service",
    ]);
  });

  it("незнакомый ответ модели не хранится", () => {
    expect(normalizeStory(" Human ")).toBe("human");
    expect(normalizeStory("battle")).toBeUndefined();
    expect(normalizeStory(undefined)).toBeUndefined();
  });

  it("анализ спрашивает тип сюжета и объясняет каждый", () => {
    expect(SCORE_FIELDS_SCHEMA).toContain(STORY_SCHEMA);
    const prompt = buildAnalysisPrompt(
      { sourceId: "1", sourceUrl: "x", imageUrl: "x", title: "t", lang: "en", license: "PD" },
      {},
    );
    expect(prompt).toContain(storyGuide());
    expect(prompt).toContain("про что пост для читателя");
  });

  it("счётчик: своё и цвет поверх типа, пустые типы видны, неразмеченные отдельно", () => {
    const rows = [
      { story: "human", nation: "ussr" },
      { story: "service", nation: "germany" },
      { story: "service", nation: "ussr", color: true },
      { nation: "uk" },
    ];
    const { parts, unknown } = storyTally(rows);
    const get = (label: string) => parts.find(([l]) => l === label)?.[1];
    expect(get("своё")).toBe(2);
    expect(get("человек")).toBe(1);
    expect(get("будни армии")).toBe(2);
    expect(get("рекорды")).toBe(0);
    expect(get("цвет")).toBe(1);
    expect(unknown).toBe(1);
    expect(storyLine(rows)).toContain("(без разметки 1)");
  });

  it("сводка в меню показывает сюжеты недели, без дефисов-тире", () => {
    const s = homeScreen({
      publishedToday: 0,
      slotsToday: 3,
      times: ["12:00"],
      ready: 5,
      stale: 0,
      autoOn: true,
      alerts: [],
      storyWeek: storyLine([{ story: "human", nation: "ussr" }]),
    });
    expect(s.text).toContain("Сюжеты за 7 дней");
    expect(s.text).toContain("своё 1, человек 1");
    expect(s.text).not.toMatch(/ - /);
  });
});
