import { describe, expect, it } from "vitest";
import { captionRules, FEW_SHOT } from "../src/caption.js";
import { buildPrompt } from "../src/critic.js";
import { buildAnalysisPrompt } from "../src/analyze.js";
import { clicheIn, guardCliches } from "../src/factcheck.js";
import { eventKey, planAuto, type PlanCandidate } from "../src/plan.js";

/**
 * Правки контента 08.11 (редакция: «нравится, но чего-то не хватает»):
 * ставки у знаковых событий, поворот вместо пересказа энциклопедии,
 * человек важнее техники, событие раз в неделю, без адресного шума.
 */
const item = {
  sourceId: "1",
  sourceUrl: "https://x",
  imageUrl: "https://x.jpg",
  title: "Terra Nova in the ice",
  lang: "en",
  license: "PD",
  year: 1910,
  place: "Antarctica",
};

describe("правила подписи и редактора согласованы", () => {
  const rules = captionRules({});
  const critic = buildPrompt(item, { caption: "Барк «Терра Нова» во льдах.", quote: "Антарктида, 1910 год.", quote_kind: "context" });

  it("ставки знакового события - и в подписи, и у редактора", () => {
    expect(rules).toContain("ЗНАКОВОЕ СОБЫТИЕ - СО СТАВКАМИ");
    expect(critic).toContain("ЗНАКОВОЕ СОБЫТИЕ - СО СТАВКАМИ");
    // ставки - не учебник: старый запрет прописных истин на месте
    expect(rules).toContain("Сталинград стал переломом в войне");
    expect(critic).toContain("Сталинград стал переломом");
  });

  it("человек важнее техники - и там и там", () => {
    expect(rules).toContain("ЧЕЛОВЕК ВАЖНЕЕ ТЕХНИКИ");
    expect(critic).toContain("ЧЕЛОВЕК ВАЖНЕЕ ТЕХНИКИ");
  });

  it("пересказ энциклопедии - брак и в подписи, и у редактора", () => {
    expect(rules).toContain("ПЕРЕСКАЗ ЭНЦИКЛОПЕДИИ");
    expect(critic).toContain("пересказ энциклопедии");
  });

  it("адресный шум запрещён, правило ЛЮДИ на месте", () => {
    expect(rules).toContain("АДРЕСНЫЙ ШУМ - НЕ В ОПИСАНИЕ");
    expect(rules).toContain("ИМЯ БЕЗ ПОЯСНЕНИЯ - ПУСТОЙ ЗВУК");
  });

  it("эталон ставок и анти-эталон энциклопедии - в примерах", () => {
    expect(FEW_SHOT).toContain("Пример 10 (ИЗЮМИНКА-СТАВКИ");
    expect(FEW_SHOT).toContain("пересказ энциклопедии вместо истории");
    // у каждого эталона подписи - одно предложение
    const bodies = FEW_SHOT.split("\n").filter((l) => l.startsWith("caption: "));
    for (const b of bodies) expect(b.slice(9).split(/(?<=[.!?])\s+/).filter(Boolean)).toHaveLength(1);
  });

  it("анализ просит статью о событии и не путает её с войной целиком", () => {
    const prompt = buildAnalysisPrompt(item, {});
    expect(prompt).toContain("event_wiki");
    expect(prompt).toContain("World War II");
  });
});

describe("страховка от штампов", () => {
  it("ловит пересказ энциклопедии и пропускает историю", () => {
    expect(clicheIn("Эта пушка стала становым хребтом британской артиллерии.")).toBeTruthy();
    expect(clicheIn("Эксперты считают её одной из лучших конструкций.")).toBeTruthy();
    expect(clicheIn("Fw 190 стал настоящей рабочей лошадкой люфтваффе.")).toBeTruthy();
    expect(clicheIn("«Шторх» активно использовали для связи.")).toBeTruthy();
    expect(clicheIn("Спустя пару минут подполковника смертельно ранил снайпер.")).toBeUndefined();
  });

  it("штамп редактора уступает первому заходу, штамп первого захода снимается", () => {
    const first = { caption: "Пушка на позиции.", quote: "Месопотамия, 1917 год.", quote_kind: "context" as const };
    const cliche = { ...first, quote: "Эта пушка стала становым хребтом артиллерии.", quote_place: "Месопотамия, 1917 год." };
    const byEditor = guardCliches({ caption: cliche, rewritten: true }, first);
    expect(byEditor.outcome).toBe("editor_rejected");
    expect(byEditor.caption.quote).toBe("Месопотамия, 1917 год.");
    const byFirst = guardCliches({ caption: cliche, rewritten: false }, cliche);
    expect(byFirst.outcome).toBe("quote_dropped");
    expect(byFirst.caption.quote).toBe("Месопотамия, 1917 год.");
  });
});

describe("одно событие - раз в неделю", () => {
  const cap = (body: string, place: string) =>
    `${body}\n<blockquote expandable>${place}</blockquote>\n\n<a href="https://t.me/x">X</a>`;
  const post = (id: number, body: string, place: string, tags: PlanCandidate["tags"] = {}): PlanCandidate => ({
    id,
    caption_html: cap(body, place),
    score: 60,
    tags: { subject: `s${id}`, period: `p${id}`, ...tags },
    attribution: `a${id}`,
  });

  it("ключ - статья о событии, а без неё город и год", () => {
    expect(eventKey(post(1, "ИС-3 в Будапеште.", "Будапешт, Венгрия, 1956 год."))).toBe("будапешт|1956");
    expect(eventKey(post(2, "Гаубица.", "Будапешт, 1956 год."))).toBe("будапешт|1956");
    expect(eventKey(post(3, "Танк.", "Прага, август 1968 года.", { event_wiki: "Warsaw Pact invasion of Czechoslovakia" }))).toBe(
      "warsaw pact invasion of czechoslovakia",
    );
  });

  it("страна, фронт и море - не событие", () => {
    expect(eventKey(post(1, "Подводники.", "СССР, 1942 год."))).toBe("");
    expect(eventKey(post(2, "Колонна.", "Восточный фронт, 1942 г."))).toBe("");
    expect(eventKey(post(3, "Транспорт.", "Баренцево море, 13 сентября 1942 года."))).toBe("");
  });

  it("событие, уже вышедшее за неделю, план обходит", () => {
    const pool = [post(1, "БТР-40 в Будапеште.", "Будапешт, 1956 год."), post(2, "Финские лыжники.", "Карелия, 1940 год.")];
    pool[0]!.score = 90;
    const [pick] = planAuto(pool, { subjects: [], civilian: false, weekEvents: ["будапешт|1956"] }, 1);
    expect(pick?.id).toBe(2);
  });

  it("два кадра одного события в одном плане не встают", () => {
    const pool = [
      post(1, "ИС-3 в Будапеште.", "Будапешт, 1956 год."),
      post(2, "Гаубица в Будапеште.", "Будапешт, Венгрия. 31 октября 1956 года."),
      post(3, "Финские лыжники.", "Карелия, 1940 год."),
    ];
    pool[1]!.score = 80;
    const picks = planAuto(pool, { subjects: [], civilian: false }, 2);
    expect(picks.map((p) => p.id)).toEqual([2, 3]);
  });
});
