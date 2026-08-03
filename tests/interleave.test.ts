import { describe, expect, it } from "vitest";
import { interleaveBySource } from "../src/sources/index.js";

const make = (source: string, n: number) =>
  Array.from({ length: n }, (_, i) => ({ source, sourceId: `${source}-${i}` }));

describe("interleaveBySource", () => {
  it("срез держит пропорции пулов", () => {
    // 12 commons + 6 loc + 6 pastvu, срез 8 → примерно 4/2/2, а не 8 commons
    const mixed = interleaveBySource([...make("commons", 12), ...make("loc", 6), ...make("pastvu", 6)]);
    const cut = mixed.slice(0, 8);
    const by = (s: string) => cut.filter((i) => i.source === s).length;
    expect(by("commons")).toBeGreaterThanOrEqual(3);
    expect(by("loc")).toBeGreaterThanOrEqual(2);
    expect(by("pastvu")).toBeGreaterThanOrEqual(2);
  });

  it("порядок внутри источника сохраняется", () => {
    const mixed = interleaveBySource([...make("a", 5), ...make("b", 3)]);
    const aOnly = mixed.filter((i) => i.source === "a").map((i) => i.sourceId);
    expect(aOnly).toEqual(["a-0", "a-1", "a-2", "a-3", "a-4"]);
  });

  it("один источник - порядок не меняется вовсе", () => {
    const items = make("solo", 4);
    expect(interleaveBySource(items).map((i) => i.sourceId)).toEqual(
      items.map((i) => i.sourceId),
    );
  });

  it("детерминированность: два вызова дают один результат", () => {
    const input = [...make("x", 7), ...make("y", 3)];
    expect(interleaveBySource(input)).toEqual(interleaveBySource(input));
  });
});
