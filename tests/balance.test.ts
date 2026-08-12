import { describe, expect, it } from "vitest";
import { pickBalanced } from "../src/balance.js";
import { buildServiceLine, parseCandidateId } from "../src/service_line.js";

const item = (id: number, subject?: string, period?: string) => ({
  id,
  tags: subject || period ? { subject, period } : null,
});

describe("pickBalanced", () => {
  it("режет тему, выбранную чаще maxPerTag, и добирает другими", () => {
    const items = [
      item(1, "armor"),
      item(2, "armor"),
      item(3, "armor"),
      item(4, "armor"),
      item(5, "aviation"),
      item(6, "street"),
    ];
    const picked = pickBalanced(items, new Map(), 5, 3);
    expect(picked.map((i) => i.id)).toEqual([1, 2, 3, 5, 6]);
  });

  it("учитывает показы прошлой недели: подходящие идут первыми", () => {
    const items = [item(1, "armor"), item(2, "aviation")];
    const picked = pickBalanced(items, new Map([["armor", 3]]), 5, 3);
    expect(picked.map((i) => i.id)).toEqual([2, 1]);
  });

  it("лимиты не могут обнулить партию: добираем повторами тем", () => {
    const items = [item(1, "armor"), item(2, "armor"), item(3, "navy")];
    const exhausted = new Map([
      ["armor", 3],
      ["navy", 3],
    ]);
    // все темы выбраны за неделю - но чат не должен остаться пустым
    expect(pickBalanced(items, exhausted, 2, 3).map((i) => i.id)).toEqual([1, 2]);
  });

  it("добор не превышает limit и не дублирует карточки", () => {
    const items = [item(1, "armor"), item(2, "armor")];
    const picked = pickBalanced(items, new Map([["armor", 5]]), 5, 3);
    expect(picked.map((i) => i.id)).toEqual([1, 2]);
  });

  it("кандидаты без темы не ограничиваются", () => {
    const items = [item(1), item(2), item(3)];
    expect(pickBalanced(items, new Map(), 5, 1)).toHaveLength(3);
  });

  it("соблюдает limit", () => {
    const items = [item(1, "a"), item(2, "b"), item(3, "c")];
    expect(pickBalanced(items, new Map(), 2, 3)).toHaveLength(2);
  });

  it("одна эпоха не занимает больше половины партии", () => {
    const items = [
      item(1, "armor", "WW1"),
      item(2, "navy", "WW1"),
      item(3, "aviation", "WW1"),
      item(4, "infantry", "WW2"),
    ];
    // партия из 3: максимум 2 ПМВ, третьим войдёт ВМВ
    const picked = pickBalanced(items, new Map(), 3, 5);
    expect(picked.map((i) => i.id)).toEqual([1, 2, 4]);
  });

  it("если других эпох нет - партия всё равно набирается", () => {
    const items = [item(1, "armor", "WW1"), item(2, "navy", "WW1"), item(3, "aviation", "WW1")];
    expect(pickBalanced(items, new Map(), 3, 5)).toHaveLength(3);
  });
});

describe("служебная строка", () => {
  it("строится и парсится обратно", () => {
    const line = buildServiceLine({ id: 123, source: "loc", quote_kind: "observation" });
    expect(line).toBe("<i>#123 · loc · observation</i>");
    expect(parseCandidateId("Подпись...\n\n#123 · loc · observation")).toBe(123);
  });

  it("не путает # в остальном тексте", () => {
    expect(parseCandidateId("танк № 3-716 #45 без разделителя")).toBeUndefined();
    expect(parseCandidateId(undefined)).toBeUndefined();
  });
});

describe("шахматный порядок архивов в партии", () => {
  const card = (id: number, archive: string, subject: string) => ({
    id,
    tags: { subject },
    attribution: `${archive}, Фотограф / CC BY-SA`,
  });

  it("партия из трёх - три разных архива, даже если лучшие все из одного", () => {
    const items = [
      card(1, "Bundesarchiv", "armor"),
      card(2, "Bundesarchiv", "navy"),
      card(3, "Bundesarchiv", "aviation"),
      card(4, "IWM", "infantry"),
      card(5, "РИА Новости", "artillery"),
    ];
    const picked = pickBalanced(items, new Map(), 3, 3);
    const archives = picked.map((c) => c.attribution.split(",")[0]);
    expect(new Set(archives).size).toBe(3);
    expect(picked[0]?.id).toBe(1); // внутри архива - лучший
  });

  it("если разных архивов меньше, чем нужно - добираем повторами, но не пусто", () => {
    const items = [
      card(1, "Bundesarchiv", "armor"),
      card(2, "Bundesarchiv", "navy"),
      card(3, "IWM", "infantry"),
    ];
    expect(pickBalanced(items, new Map(), 3, 3)).toHaveLength(3);
  });

  it("кадры без архива не ломают чередование", () => {
    const items = [
      { id: 1, tags: { subject: "armor" } },
      card(2, "IWM", "navy"),
    ];
    expect(pickBalanced(items as never, new Map(), 2, 3)).toHaveLength(2);
  });
});

describe("looksLikeLeader (разметка старых вождей)", async () => {
  const { looksLikeLeader } = await import("../scripts/tag-leaders.js");

  it("узнаёт вождя в теле поста", () => {
    expect(looksLikeLeader("Адольф Гитлер и Ева Браун на террасе Бергхофа.\n<blockquote>1942</blockquote>")).toBe(true);
    expect(looksLikeLeader("Автоколонна кортежа Адольфа Гитлера въезжает в Вену.")).toBe(true);
  });

  it("имя только в справке героем кадра не делает", () => {
    expect(
      looksLikeLeader(
        "Немецкие горные егеря на привале.\n<blockquote expandable>Приказ подписал Гитлер.</blockquote>",
      ),
    ).toBe(false);
  });

  it("обычный кадр не помечает", () => {
    expect(looksLikeLeader("Расчёт 88-мм зенитного орудия на пароме.")).toBe(false);
    expect(looksLikeLeader(null)).toBe(false);
  });
});
