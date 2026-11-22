import { describe, expect, it } from "vitest";
import {
  FEED_RUBRICS,
  feedDeficits,
  feedOf,
  inferFeed,
  markBlocked,
  marksOf,
  planGrid,
  weeklyTargets,
  type FeedPost,
  type GridCandidate,
} from "../src/feed.js";

const now = new Date("2026-11-16T12:00:00Z");
const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000).toISOString();
const post = (feed: string, d: number, extra: Partial<FeedPost> = {}): FeedPost => ({
  feed,
  marks: [],
  nation: "",
  events: [],
  at: daysAgo(d),
  ...extra,
});
const cand = (id: number, feed: string, score = 60, extra: Partial<GridCandidate> & { nation?: string; event?: string } = {}) => ({
  id,
  caption_html: extra.caption_html ?? `Пост ${id}.`,
  score,
  tags: { feed, ...(extra.tags ?? {}) },
  priority: extra.priority,
  nation: extra.nation ?? "",
  event: extra.event ?? "",
});
type C = ReturnType<typeof cand>;
const helpers = {
  now,
  nationOf: (c: C) => c.nation,
  eventsOf: (c: C) => (c.event ? [c.event] : []),
  homeNation: "ussr",
  postsPerWeek: 21,
};

describe("рубрики и метки", () => {
  it("норма недели складывается в число постов", () => {
    const t = weeklyTargets(21);
    const sum = [...t.values()].reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(21);
    expect(t.get("person")!).toBeGreaterThan(t.get("color")!);
    expect(FEED_RUBRICS.map((r) => r.key)).toContain("navy");
  });

  it("рубрика по старым тегам: цвет выше всего, потом событие, человек, диковина", () => {
    expect(inferFeed({ color: true, subject: "armor", story: "human" })).toBe("color");
    expect(inferFeed({ story: "landmark", subject: "infantry" })).toBe("event");
    expect(inferFeed({ story: "human", subject: "armor" })).toBe("person");
    expect(inferFeed({ subject: "armor", period: "WW2" })).toBe("ground");
    expect(inferFeed({ subject: "armor", period: "cold_war" })).toBe("coldwar");
    expect(inferFeed({ subject: "navy" })).toBe("navy");
    expect(inferFeed({ subject: "pow" })).toBe("combat");
    expect(inferFeed({ rubric: "poster" })).toBe("poster");
    expect(inferFeed(null)).toBe("combat");
  });

  it("рубрика модели важнее тегов, незнакомая - по тегам", () => {
    expect(feedOf({ tags: { feed: "navy", subject: "armor" } })).toBe("navy");
    expect(feedOf({ tags: { feed: "space", subject: "armor" } })).toBe("ground");
  });

  it("пленные узнаются и по теме, и по тексту подписи", () => {
    expect(marksOf({ tags: { subject: "pow" }, caption_html: "Колонна." })).toContain("pow");
    expect(marksOf({ tags: {}, caption_html: "Немецкие пленные с завязанными глазами под конвоем." })).toContain("pow");
    expect(marksOf({ tags: {}, caption_html: "Колонна немецких военнопленных в Нормандии." })).toContain("pow");
    expect(marksOf({ tags: {}, caption_html: "Солдаты вернулись из плена." })).toContain("pow");
    expect(marksOf({ tags: {}, caption_html: "Расчёт выкатывает орудие на прямую наводку." })).toEqual([]);
    expect(marksOf({ tags: { subject: "leader" }, caption_html: "" })).toContain("leader");
    expect(marksOf({ tags: {}, caption_html: "Вид на руины Сталинграда." })).toContain("ruins");
  });

  it("лимиты меток: пленные раз в 14 дней, руины не больше двух за 7", () => {
    expect(markBlocked("pow", [post("combat", 13, { marks: ["pow"] })], now)).toBe(true);
    expect(markBlocked("pow", [post("combat", 15, { marks: ["pow"] })], now)).toBe(false);
    expect(markBlocked("ruins", [post("city", 1, { marks: ["ruins"] })], now)).toBe(false);
    expect(markBlocked("ruins", [post("city", 1, { marks: ["ruins"] }), post("city", 3, { marks: ["ruins"] })], now)).toBe(true);
  });
});

describe("выбор по сетке", () => {
  it("слот берёт рубрику с наибольшим недобором, а не самую высокую оценку", () => {
    const history = [post("ground", 0.2), post("ground", 1), post("ground", 2), post("combat", 3)];
    const pool = [cand(1, "ground", 90), cand(2, "navy", 55)];
    const [pick] = planGrid(pool, history, 1, helpers);
    expect(pick!.id).toBe(2);
  });

  it("одна рубрика два раза подряд не идёт, если есть другая", () => {
    const pool = [cand(1, "person", 90), cand(2, "aviation", 50)];
    const [pick] = planGrid(pool, [post("person", 0.1)], 1, helpers);
    expect(pick!.id).toBe(2);
  });

  it("пленные не выходят чаще раза в 14 дней - даже при пустом остальном резерве", () => {
    const pow = cand(1, "combat", 95, { caption_html: "Колонна немецких пленных." });
    const history = [post("navy", 3, { marks: ["pow"] })];
    expect(planGrid([pow], history, 1, helpers)).toEqual([]);
    const other = cand(2, "rear", 40);
    expect(planGrid([pow, other], history, 1, helpers).map((c) => c.id)).toEqual([2]);
  });

  it("одно событие - не чаще раза в 14 дней, и в одном плане тоже", () => {
    const a = cand(1, "event", 80, { event: "будапешт|1956" });
    const b = cand(2, "city", 79, { event: "будапешт|1956" });
    const c = cand(3, "navy", 50);
    const picks = planGrid([a, b, c], [], 3, helpers).map((x) => x.id);
    expect(picks).toContain(1);
    expect(picks).not.toContain(2);
  });

  it("страна - не больше двух на шесть постов подряд, своя страна внутри рубрики впереди", () => {
    const history = [post("navy", 0.1, { nation: "usa" }), post("combat", 0.5, { nation: "usa" })];
    const pool = [cand(1, "aviation", 80, { nation: "usa" }), cand(2, "aviation", 60, { nation: "uk" })];
    expect(planGrid(pool, history, 1, helpers)[0]!.id).toBe(2);
    const soviet = [cand(3, "ground", 60, { nation: "ussr" }), cand(4, "ground", 66, { nation: "germany" })];
    expect(planGrid(soviet, [], 1, helpers)[0]!.id).toBe(3);
  });

  it("ручное сильнее сетки: одобренный идёт первым, даже если рубрика повторяется", () => {
    const pool = [cand(1, "person", 40, { priority: 1 }), cand(2, "navy", 90)];
    const picks = planGrid(pool, [post("person", 0.1)], 2, helpers).map((c) => c.id);
    expect(picks).toEqual([1, 2]);
  });

  it("пустой резерв мягких правил не оставляет слот пустым - снимает их", () => {
    let fallback = 0;
    const pool = [cand(1, "person", 70)];
    const picks = planGrid(pool, [post("person", 0.1)], 1, { ...helpers, onFallback: () => fallback++ });
    expect(picks.map((c) => c.id)).toEqual([1]);
    expect(fallback).toBe(1);
  });

  it("за неделю лента расходится по рубрикам, а не по оценке", () => {
    const pool: C[] = [];
    let id = 1;
    // перекошенный резерв: 15 сильных «техник», по 2 средних других рубрик
    for (let i = 0; i < 15; i++) pool.push(cand(id++, "ground", 85));
    for (const f of ["person", "navy", "aviation", "rear", "event", "combat", "oddity"]) {
      pool.push(cand(id++, f, 55), cand(id++, f, 54));
    }
    const picks = planGrid(pool, [], 21, helpers);
    const ground = picks.filter((c) => c.tags.feed === "ground").length;
    expect(ground).toBeLessThanOrEqual(7);
    const feeds = new Set(picks.map((c) => c.tags.feed));
    expect(feeds.size).toBeGreaterThanOrEqual(7);
    for (let i = 1; i < picks.length; i++) {
      // подряд одна рубрика - только когда других уже не осталось
      if (picks[i]!.tags.feed === picks[i - 1]!.tags.feed) {
        const rest = picks.slice(i).map((c) => c.tags.feed);
        expect(new Set(rest).size).toBe(1);
      }
    }
  });
});

describe("сбор под заказ", () => {
  it("недобор и потолок запаса по рубрикам", () => {
    const reserve = [
      ...Array.from({ length: 6 }, () => ({ tags: { feed: "ground" } })),
      { tags: { feed: "navy" } },
    ];
    const d = new Map(feedDeficits(reserve, 21).map((r) => [r.key, r]));
    expect(d.get("ground")!.full).toBe(true);
    expect(d.get("ground")!.deficit).toBe(0);
    expect(d.get("navy")!.deficit).toBeGreaterThan(0);
    expect(d.get("person")!.stock).toBe(0);
    expect(d.get("person")!.full).toBe(false);
  });
});

describe("вкус редакции по её удалениям", async () => {
  const { tasteMap, tasteKeys, tastePenalty, isEditorReject } = await import("../src/feed.js");
  const row = (archive: string, status: string, extra: Record<string, unknown> = {}) => ({
    status,
    caption_html: "Пост.",
    tags: { subject: "culture", ...extra } as Record<string, unknown>,
    archive,
  });
  it("удаление редакцией отличается от отсева сбора", () => {
    expect(isEditorReject({ status: "rejected", caption_html: "x", tags: {} })).toBe(true);
    expect(isEditorReject({ status: "rejected", caption_html: "x", tags: { gate: "hookless" } })).toBe(false);
    expect(isEditorReject({ status: "rejected", caption_html: null, tags: {} })).toBe(false);
    expect(isEditorReject({ status: "rejected", caption_html: "x", tags: { gate: "old_reserve", editor: "skip" } })).toBe(true);
  });
  it("архив, который удаляют чаще среднего, получает штраф; любимый - нет", () => {
    const rows = [
      ...Array.from({ length: 11 }, () => row("anefo", "rejected")),
      ...Array.from({ length: 2 }, () => row("anefo", "published")),
      ...Array.from({ length: 20 }, () => row("риа новости", "published", { subject: "armor" })),
      ...Array.from({ length: 4 }, () => row("iwm", "rejected", { subject: "armor" })),
      ...Array.from({ length: 10 }, () => row("iwm", "published", { subject: "armor" })),
    ];
    const map = tasteMap(rows, (r) => tasteKeys(r, r.archive));
    expect(map.get("a:anefo")).toBeGreaterThanOrEqual(10);
    expect(map.get("a:риа новости") ?? 0).toBe(0);
    expect(tastePenalty(map, ["a:anefo", "s:culture"])).toBeGreaterThan(tastePenalty(map, ["a:iwm", "s:armor"]));
  });
});
