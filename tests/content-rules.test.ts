import { describe, expect, it } from "vitest";
import { captionRules, FEW_SHOT } from "../src/caption.js";
import { buildPrompt } from "../src/critic.js";
import { buildAnalysisPrompt } from "../src/analyze.js";
import { clicheIn, guardCliches } from "../src/factcheck.js";
import { EVENT_MEMORY_DAYS, eventKey, eventKeys, planAuto, recentEvents, weekShares, type PlanCandidate } from "../src/plan.js";

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

  it("ключей у кадра два: статья и город с годом (разбор 15.11)", () => {
    const withWiki = post(1, "Морпехи у берега.", "Севастополь, Крымская АССР. 1944 год.", { event_wiki: "Crimean offensive" });
    expect(eventKeys(withWiki)).toEqual(["crimean offensive", "севастополь|1944"]);
    expect(eventKey(withWiki)).toBe("crimean offensive");
    expect(eventKeys(post(2, "Подводники.", "СССР, 1942 год."))).toEqual([]);
  });

  it("Севастополь-1944: статья у одного поста, город у другого - всё равно повтор", () => {
    // 13.11 вышел пост со статьёй о Крымской операции, 14.11 - пост о
    // том же Севастополе без статьи: ключи не сошлись, правило молчало
    const published = post(1, "Морпехи у берега.", "Севастополь, Крымская АССР. 1944 год.", { event_wiki: "Crimean offensive" });
    const pool = [post(2, "Пленные на склоне.", "Севастополь, 1944 год."), post(3, "Финские лыжники.", "Карелия, 1940 год.")];
    pool[0]!.score = 90;
    const [pick] = planAuto(pool, { subjects: [], civilian: false, weekEvents: recentEvents([published]) }, 1);
    expect(pick?.id).toBe(3);
  });

  it("одна статья о событии при разных городах - тоже повтор", () => {
    const published = post(1, "Пленные в Риме.", "Рим, Италия, 1944 год.", { event_wiki: "Battle of Anzio" });
    const pool = [
      post(2, "Парашютисты в окопе.", "Италия, 1944 год.", { event_wiki: "Battle of Anzio" }),
      post(3, "Финские лыжники.", "Карелия, 1940 год."),
    ];
    pool[0]!.score = 90;
    const [pick] = planAuto(pool, { subjects: [], civilian: false, weekEvents: recentEvents([published]) }, 1);
    expect(pick?.id).toBe(3);
  });

  it("аварийный добор событие не повторяет: лучше пустой слот", () => {
    // единственный кандидат - снова Будапешт-1956; раньше добор его ставил
    const pool = [post(1, "Церковь после боёв.", "Будапешт, Венгрия, 1956 год.")];
    const picks = planAuto(pool, { subjects: [], civilian: false, weekEvents: ["будапешт|1956"] }, 1);
    expect(picks).toEqual([]);
  });

  it("добор виден: planAuto сообщает, что кадр взят вне правил", () => {
    // обе темы уже были в окне - под правила не подходит никто
    const pool = [post(1, "Пехота.", "Карелия, 1940 год."), post(2, "Танк.", "Карелия, 1941 год.")];
    const forced: number[] = [];
    const picks = planAuto(pool, { subjects: ["s1", "s2"], civilian: false }, 1, (c) => forced.push(c.id));
    expect(picks).toHaveLength(1);
    expect(forced).toEqual([picks[0]!.id]);
    const none: number[] = [];
    planAuto([post(3, "Лыжники.", "Карелия, 1942 год.")], { subjects: [], civilian: false }, 1, (c) => none.push(c.id));
    expect(none).toEqual([]);
  });

  it("недельные доли несут все ключи событий; память - две недели", () => {
    const rows = [post(1, "Морпехи.", "Севастополь, 1944 год.", { event_wiki: "Crimean offensive" })];
    expect(weekShares(rows).weekEvents).toEqual(["crimean offensive", "севастополь|1944"]);
    expect(EVENT_MEMORY_DAYS).toBe(14);
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

describe("что считать событием кадра (предпросмотр 08.11)", async () => {
  const { GENERIC_EVENT } = await import("../src/analyze.js");
  it("войны, кампании и театры - не событие: их справка даёт учебный обзор", () => {
    for (const t of ["World War II", "Winter War", "Korean War", "Mesopotamian campaign", "Pacific War", "Eastern Front (World War II)"]) {
      expect(GENERIC_EVENT.test(t), t).toBe(true);
    }
  });
  it("обозримое событие - событие", () => {
    for (const t of ["Warsaw Pact invasion of Czechoslovakia", "Terra Nova Expedition", "Battle of Stalingrad", "Hungarian Revolution of 1956", "Hindenburg disaster"]) {
      expect(GENERIC_EVENT.test(t), t).toBe(false);
    }
  });
  it("перечень применений - тоже пересказ энциклопедии", () => {
    expect(clicheIn("Этот самолёт применялся не только для разведки и связи, но и для патрулирования моря.")).toBeTruthy();
  });
});

describe("сравнение с аналогами - тоже энциклопедия (предпросмотр 08.11)", () => {
  it("ловится страховкой", () => {
    expect(clicheIn("Её снаряды были тяжелее немецких и французских аналогов.")).toBeTruthy();
    expect(clicheIn("Снаряд весил больше, чем у соседей по фронту, и это решило бой.")).toBeUndefined();
  });
});
