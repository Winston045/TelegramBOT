import { describe, expect, it } from "vitest";
import { pickBalanced } from "../src/balance.js";
import { buildServiceLine, parseCandidateId } from "../src/service_line.js";

const item = (id: number, subject?: string) => ({
  id,
  tags: subject ? { subject } : null,
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
