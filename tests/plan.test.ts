import { describe, expect, it } from "vitest";
import {
  buildPlan,
  planAuto,
  quoteLength,
  rank,
  upcomingSlots,
  type PlanCandidate,
} from "../src/plan.js";

const cap = (text: string, quote = "СССР, 1943 год.") =>
  `${text}\n<blockquote expandable>${quote}</blockquote>\n\n<a href="https://t.me/x">X</a>`;

const LONG =
  "Кухонные дебаты - серия импровизированных диалогов между вице-президентом США " +
  "Ричардом Никсоном и председателем Совета Министров СССР Никитой Хрущёвым, " +
  "состоявшихся 24 июля 1959 года на открытии выставки в Москве.";

function cand(
  id: number,
  score: number,
  subject?: string,
  opts: { long?: boolean; military?: boolean } = {},
): PlanCandidate {
  return {
    id,
    caption_html: cap(`Пост ${id}`, opts.long ? LONG : "СССР, 1943 год."),
    score,
    tags: { subject, military: opts.military ?? true },
  };
}

const TZ = "+03:00";
const noRecent = { subjects: [], civilian: false };
/** 1 августа 2026, 10:00 МСК (07:00 UTC). */
const NOW = new Date("2026-08-01T07:00:00Z");

describe("rank", () => {
  it("развёрнутая цитата даёт бонус, но не переворачивает отбор", () => {
    expect(rank(cand(1, 70, "armor", { long: true }))).toBe(75);
    expect(rank(cand(2, 70, "armor"))).toBe(70);
    // разрыв в 10 баллов бонусом не перебивается
    expect(rank(cand(3, 80, "armor"))).toBeGreaterThan(rank(cand(4, 70, "armor", { long: true })));
  });
  it("считает длину цитаты без тегов", () => {
    expect(quoteLength(cap("Текст", LONG))).toBeGreaterThanOrEqual(180);
    expect(quoteLength(cap("Текст"))).toBeLessThan(180);
  });

  it("эпохи до ВМВ уступают при равном качестве", () => {
    const ww1 = { ...cand(1, 72, "infantry"), tags: { subject: "infantry", period: "WW1", action: true } };
    const ww2 = { ...cand(2, 70, "armor"), tags: { subject: "armor", period: "WW2", action: true } };
    expect(rank(ww2)).toBeGreaterThan(rank(ww1));
  });

  it("но сильная история старой эпохи всё равно выходит", () => {
    // ПМВ с высокой оценкой и развёрнутой цитатой против среднего ВМВ
    const ww1Story = {
      id: 1,
      caption_html: cap("Пост 1", LONG),
      score: 85,
      tags: { subject: "infantry", period: "WW1", action: true },
    };
    const ww2Plain = { ...cand(2, 68, "armor"), tags: { subject: "armor", period: "WW2", action: true } };
    expect(rank(ww1Story)).toBeGreaterThan(rank(ww2Plain));
    expect(planAuto([ww1Story, ww2Plain], noRecent, 1)[0]?.id).toBe(1);
  });

  it("подлинный цвет даёт фору, но не перекрывает большой разрыв", () => {
    const colorShot = { ...cand(1, 70, "armor"), tags: { subject: "armor", color: true } };
    const bw = { ...cand(2, 74, "navy"), tags: { subject: "navy", color: false } };
    const strongBw = { ...cand(3, 85, "aviation"), tags: { subject: "aviation" } };
    expect(rank(colorShot)).toBeGreaterThan(rank(bw));
    expect(rank(strongBw)).toBeGreaterThan(rank(colorShot));
  });
});

describe("planAuto", () => {
  it("берёт лучших по оценке", () => {
    const picked = planAuto([cand(1, 60, "a"), cand(2, 90, "b"), cand(3, 75, "c")], noRecent, 2);
    expect(picked.map((c) => c.id)).toEqual([2, 3]);
  });

  it("не ставит одну тему подряд внутри плана", () => {
    const picked = planAuto(
      [cand(1, 90, "navy"), cand(2, 85, "navy"), cand(3, 70, "armor")],
      noRecent,
      2,
    );
    expect(picked.map((c) => c.id)).toEqual([1, 3]);
  });

  it("учитывает темы уже вышедших постов", () => {
    const picked = planAuto(
      [cand(1, 90, "navy"), cand(2, 70, "armor")],
      { subjects: ["navy"], civilian: false },
      1,
    );
    expect(picked[0]?.id).toBe(2);
  });

  it("два мирных кадра подряд не идут", () => {
    const picked = planAuto(
      [cand(1, 90, "street", { military: false }), cand(2, 88, "city", { military: false }), cand(3, 60, "armor")],
      noRecent,
      2,
    );
    expect(picked.map((c) => c.id)).toEqual([1, 3]);
  });

  it("если других тем нет - лучше повтор темы, чем пустой слот", () => {
    const picked = planAuto([cand(1, 90, "navy"), cand(2, 80, "navy")], noRecent, 2);
    expect(picked.map((c) => c.id)).toEqual([1, 2]);
  });

  it("пустой резерв - пустой план", () => {
    expect(planAuto([], noRecent, 3)).toEqual([]);
  });

  it("живой кадр обгоняет статику при близком качестве", () => {
    const staticShot = { ...cand(1, 80, "armor"), tags: { subject: "armor", action: false } };
    const alive = { ...cand(2, 72, "navy"), tags: { subject: "navy", action: true } };
    expect(planAuto([staticShot, alive], noRecent, 1)[0]?.id).toBe(2);
  });

  it("но сильная статика всё же выходит вперёд слабого движения", () => {
    const staticShot = { ...cand(1, 95, "armor"), tags: { subject: "armor", action: false } };
    const alive = { ...cand(2, 60, "navy"), tags: { subject: "navy", action: true } };
    expect(planAuto([staticShot, alive], noRecent, 1)[0]?.id).toBe(1);
  });

  it("две статики подряд в план не идут", () => {
    const s1 = { ...cand(1, 90, "armor"), tags: { subject: "armor", action: false } };
    const s2 = { ...cand(2, 88, "navy"), tags: { subject: "navy", action: false } };
    const alive = { ...cand(3, 50, "aviation"), tags: { subject: "aviation", action: true } };
    expect(planAuto([s1, s2, alive], noRecent, 2).map((c) => c.id)).toEqual([1, 3]);
  });

  it("статика в недавних постах придерживает следующую", () => {
    const s1 = { ...cand(1, 90, "armor"), tags: { subject: "armor", action: false } };
    const alive = { ...cand(2, 50, "navy"), tags: { subject: "navy", action: true } };
    const picked = planAuto([s1, alive], { subjects: [], civilian: false, statics: 1 }, 1);
    expect(picked[0]?.id).toBe(2);
  });

  it("после двух постов одной эпохи третий - из другой", () => {
    const ww1a = { ...cand(1, 90, "armor"), tags: { subject: "armor", period: "WW1", action: true } };
    const ww1b = { ...cand(2, 85, "navy"), tags: { subject: "navy", period: "WW1", action: true } };
    const ww2 = { ...cand(3, 60, "aviation"), tags: { subject: "aviation", period: "WW2", action: true } };
    const picked = planAuto([ww1a, ww1b, ww2], noRecent, 3);
    // первые два - ПМВ по оценке, третьим обязан войти ВМВ
    expect(picked.map((c) => c.id)).toEqual([1, 2, 3]);
    expect(picked[2]?.tags?.period).toBe("WW2");
  });

  it("эпохи вышедших постов тоже учитываются", () => {
    const ww1 = { ...cand(1, 90, "armor"), tags: { subject: "armor", period: "WW1", action: true } };
    const ww2 = { ...cand(2, 60, "navy"), tags: { subject: "navy", period: "WW2", action: true } };
    const picked = planAuto(
      [ww1, ww2],
      { subjects: [], periods: ["WW1", "WW1"], civilian: false },
      1,
    );
    expect(picked[0]?.id).toBe(2);
  });

  it("одна эпоха в резерве - лента не останавливается", () => {
    const a = { ...cand(1, 90, "armor"), tags: { subject: "armor", period: "WW1", action: true } };
    const b = { ...cand(2, 80, "navy"), tags: { subject: "navy", period: "WW1", action: true } };
    const c = { ...cand(3, 70, "aviation"), tags: { subject: "aviation", period: "WW1", action: true } };
    expect(planAuto([a, b, c], noRecent, 3)).toHaveLength(3);
  });

  it("если в резерве только статика - слот всё равно закрывается", () => {
    const s1 = { ...cand(1, 90, "armor"), tags: { subject: "armor", action: false } };
    const s2 = { ...cand(2, 80, "navy"), tags: { subject: "navy", action: false } };
    expect(planAuto([s1, s2], noRecent, 2).map((c) => c.id)).toEqual([1, 2]);
  });

  it("изюминки не идут подряд: после длинной цитаты - короткий пост", () => {
    const long1 = cand(1, 90, "armor", { long: true });
    const long2 = cand(2, 88, "navy", { long: true });
    const short = cand(3, 70, "aviation");
    // long2 обгоняет short по рангу, но окно изюминок его отодвигает
    expect(planAuto([long1, long2, short], noRecent, 3).map((c) => c.id)).toEqual([1, 3, 2]);
  });

  it("вышедшая только что изюминка отодвигает следующую", () => {
    const long1 = cand(1, 90, "armor", { long: true });
    const short = cand(2, 60, "navy");
    const picked = planAuto([long1, short], { subjects: [], civilian: false, longs: 1 }, 1);
    expect(picked[0]?.id).toBe(2);
  });

  it("если в резерве одни изюминки - слоты всё равно закрываются", () => {
    const long1 = cand(1, 90, "armor", { long: true });
    const long2 = cand(2, 80, "navy", { long: true });
    expect(planAuto([long1, long2], noRecent, 2).map((c) => c.id)).toEqual([1, 2]);
  });
});

describe("upcomingSlots", () => {
  const times = ["09:00", "12:00", "18:00"];

  it("показывает оставшиеся слоты сегодня, потом завтрашние", () => {
    const slots = upcomingSlots({ now: NOW, tzOffset: TZ, times, publishedToday: 1 }, 3);
    expect(slots.map((s) => s.label)).toEqual(["сегодня 12:00", "сегодня 18:00", "завтра 09:00"]);
  });

  it("пропущенный слот отдаётся ближайшим заходом публикатора", () => {
    // 10:00 МСК, слот 09:00 прошёл, а постов сегодня нет
    const slots = upcomingSlots({ now: NOW, tzOffset: TZ, times, publishedToday: 0 }, 2);
    expect(slots[0]).toEqual({ label: "ближайшим заходом", due: true });
    expect(slots[1]?.label).toBe("сегодня 12:00");
  });

  it("без расписания слотов нет", () => {
    expect(upcomingSlots({ now: NOW, tzOffset: TZ, times: [], publishedToday: 0 }, 3)).toEqual([]);
  });
});

describe("buildPlan", () => {
  const base = {
    now: NOW,
    tzOffset: TZ,
    times: ["09:00", "12:00", "18:00"],
    publishedToday: 1,
    recent: noRecent,
    formatScheduled: (iso: string) => `на ${iso}`,
  };

  it("порядок приоритетов: время → одобренные → автовыбор", () => {
    const plan = buildPlan(
      {
        ...base,
        scheduled: [{ id: 10, caption_html: cap("Запланированный"), scheduled_at: "2026-08-01T15:00:00Z" }],
        approved: [{ id: 20, caption_html: cap("Одобренный") }],
        reserve: [cand(30, 90, "armor")],
        autoPublish: true,
      },
      5,
    );
    expect(plan.map((e) => [e.candidate.id, e.kind])).toEqual([
      [10, "scheduled"],
      [20, "approved"],
      [30, "auto"],
    ]);
  });

  it("без автопостинга резерв в план не попадает", () => {
    const plan = buildPlan(
      {
        ...base,
        scheduled: [],
        approved: [{ id: 20, caption_html: cap("Одобренный") }],
        reserve: [cand(30, 95, "armor")],
        autoPublish: false,
      },
      5,
    );
    expect(plan.map((e) => e.candidate.id)).toEqual([20]);
  });

  it("посты раскладываются по ближайшим слотам", () => {
    const plan = buildPlan(
      {
        ...base,
        scheduled: [],
        approved: [],
        reserve: [cand(1, 90, "a"), cand(2, 80, "b"), cand(3, 70, "c")],
        autoPublish: true,
      },
      3,
    );
    expect(plan.map((e) => e.when)).toEqual(["сегодня 12:00", "сегодня 18:00", "завтра 09:00"]);
  });

  it("план не длиннее запрошенного", () => {
    const reserve = Array.from({ length: 20 }, (_, i) => cand(i + 1, 90 - i, `t${i}`));
    const plan = buildPlan(
      { ...base, scheduled: [], approved: [], reserve, autoPublish: true },
      4,
    );
    expect(plan).toHaveLength(4);
  });
});

describe("военный уклон", () => {
  it("мирный кадр уступает боевому при равном качестве", () => {
    const civ = { ...cand(1, 70, "street", { military: false }) };
    const mil = { ...cand(2, 70, "armor") };
    expect(rank(mil)).toBeGreaterThan(rank(civ));
  });

  it("мирных не больше одного на окно - второй ждёт", () => {
    const civ1 = cand(1, 90, "street", { military: false });
    const civ2 = cand(2, 88, "portrait", { military: false });
    const mil = cand(3, 60, "armor");
    expect(planAuto([civ1, civ2, mil], noRecent, 3).map((c) => c.id)).toEqual([1, 3, 2]);
  });

  it("если в резерве одни мирные - слоты всё равно закрываются", () => {
    const civ1 = cand(1, 90, "street", { military: false });
    const civ2 = cand(2, 80, "portrait", { military: false });
    expect(planAuto([civ1, civ2], noRecent, 2).map((c) => c.id)).toEqual([1, 2]);
  });
});

describe("баланс архивов", () => {
  const fromArchive = (id: number, score: number, subject: string, attribution: string) => ({
    ...cand(id, score, subject),
    attribution,
  });

  it("шахматка: два подряд из одного архива не идут", () => {
    const a1 = fromArchive(1, 90, "armor", "Bundesarchiv");
    const a2 = fromArchive(2, 88, "navy", "Bundesarchiv");
    const a3 = fromArchive(3, 86, "aviation", "Bundesarchiv");
    const other = fromArchive(4, 60, "infantry", "IWM");
    // после Бундесархива обязан войти другой архив, потом снова можно
    expect(planAuto([a1, a2, a3, other], noRecent, 3).map((c) => c.id)).toEqual([1, 4, 2]);
  });

  it("архивы вышедших постов учитываются", () => {
    const brit1 = fromArchive(1, 90, "armor", "IWM");
    const soviet = fromArchive(2, 60, "infantry", "РИА Новости");
    const picked = planAuto(
      [brit1, soviet],
      // в recent архивы уже нормализованы (как их кладёт публикатор)
      { subjects: [], civilian: false, archives: ["iwm", "iwm"] },
      1,
    );
    expect(picked[0]?.id).toBe(2);
  });

  it("если резерв только из одного архива - слоты всё равно закрываются", () => {
    const a1 = fromArchive(1, 90, "armor", "Bundesarchiv");
    const a2 = fromArchive(2, 80, "navy", "Bundesarchiv");
    const a3 = fromArchive(3, 70, "aviation", "Bundesarchiv");
    expect(planAuto([a1, a2, a3], noRecent, 3)).toHaveLength(3);
  });
});

describe("вожди - редкая краска", () => {
  const leader = (id: number, score: number) => ({
    ...cand(id, score, "leader"),
    tags: { subject: "leader", military: true },
  });

  it("кадр вождя уступает обычному военному при равной оценке", () => {
    expect(rank(cand(2, 75, "armor"))).toBeGreaterThan(rank(leader(1, 75)));
  });

  it("два вождя подряд не идут", () => {
    const picked = planAuto([leader(1, 95), leader(2, 92), cand(3, 60, "armor")], noRecent, 2);
    expect(picked.map((c) => c.id)).toEqual([1, 3]);
  });

  it("вождь среди вышедших придерживает следующего", () => {
    const picked = planAuto(
      [leader(1, 95), cand(2, 55, "infantry")],
      { subjects: ["leader"], civilian: false },
      1,
    );
    expect(picked[0]?.id).toBe(2);
  });
});

describe("archiveKey", () => {
  it("выделяет архив из строки с фотографом и лицензией", async () => {
    const { archiveKey } = await import("../src/plan.js");
    expect(archiveKey("Bundesarchiv, Koch / CC BY-SA 3.0 de")).toBe("bundesarchiv");
    expect(archiveKey("Bundesarchiv, Schmidt / CC BY-SA 3.0 de")).toBe("bundesarchiv");
    expect(archiveKey("IWM / PD")).toBe("iwm");
    expect(archiveKey("PastVu / Иванов")).toBe("pastvu");
    expect(archiveKey(null)).toBe("");
  });

  it("кадры одного архива с разными фотографами считаются одним архивом", () => {
    const a = { ...cand(1, 90, "armor"), attribution: "Bundesarchiv, Koch / CC BY-SA 3.0 de" };
    const b = { ...cand(2, 88, "navy"), attribution: "Bundesarchiv, Schmidt / CC BY-SA 3.0 de" };
    const c = { ...cand(3, 86, "aviation"), attribution: "Bundesarchiv, Weber / CC BY-SA 3.0 de" };
    const other = { ...cand(4, 60, "infantry"), attribution: "IWM / PD" };
    expect(planAuto([a, b, c, other], noRecent, 3).map((x) => x.id)).toEqual([1, 4, 2]);
  });
});

describe("добор при бедном резерве не ставит один архив подряд", () => {
  const a = (id: number, score: number, subject: string, archive: string) => ({
    ...cand(id, score, subject),
    attribution: `${archive}, Фотограф / CC BY-SA`,
    tags: { subject, military: true, period: "WW2" },
  });

  it("когда все правила против, всё равно чередует архивы", () => {
    // одна эпоха, одна тема - под правила не подходит никто
    const items = [
      a(1, 90, "armor", "Bundesarchiv"),
      a(2, 88, "armor", "Bundesarchiv"),
      a(3, 60, "armor", "IWM"),
      a(4, 55, "armor", "Bundesarchiv"),
    ];
    const picked = planAuto(items, noRecent, 3).map((c) => c.id);
    expect(picked).toHaveLength(3);
    // второй пост обязан быть из другого архива, хотя по рангу он слабее
    expect(picked[1]).toBe(3);
  });
});
