import { describe, expect, it } from "vitest";
import { archiveWeights, MAX_WEIGHT, MIN_WEIGHT, type YieldRow } from "../src/yield.js";
import { interleaveBySource } from "../src/sources/index.js";

/** n кадров архива, из них ok прошли сито. */
function rows(attribution: string, n: number, ok: number): YieldRow[] {
  return Array.from({ length: n }, (_, i) => ({
    attribution,
    source: "commons",
    status: i < ok ? "published" : "rejected",
  }));
}

describe("вес архива по выходу (разбор 15.11)", () => {
  // цифры отчёта yield:30 от 15.11
  const history = [
    ...rows("Europeana 1914-1918", 28, 1),
    ...rows("Agence Rol", 22, 4),
    ...rows("IWM", 10, 6),
    ...rows("Евгений Халдей", 10, 6),
    ...rows("Аркадий Шайхет", 6, 5),
    ...rows("Bundesarchiv", 14, 7),
  ];
  const w = archiveWeights(history);

  it("архив с выходом 4% уходит в хвост, с выходом 60-80% - в голову", () => {
    expect(w.get("europeana 1914-1918")!).toBeLessThan(0.5);
    expect(w.get("agence rol")!).toBeLessThan(1);
    expect(w.get("iwm")!).toBeGreaterThan(1);
    expect(w.get("аркадий шайхет")!).toBeGreaterThan(w.get("bundesarchiv")!);
  });

  it("вес в рамках: хвост не умирает, лидер не забирает очередь", () => {
    for (const v of w.values()) {
      expect(v).toBeGreaterThanOrEqual(MIN_WEIGHT);
      expect(v).toBeLessThanOrEqual(MAX_WEIGHT);
    }
  });

  it("сбой подписи (failed) не портит выход архива", () => {
    const withFailed = archiveWeights([...history, ...rows("IWM", 0, 0), { attribution: "IWM", status: "failed" }]);
    expect(withFailed.get("iwm")).toBe(w.get("iwm"));
  });

  it("без истории весов нет - очередь чередует поровну, как раньше", () => {
    expect(archiveWeights([]).size).toBe(0);
  });

  it("очередь: первым встаёт кадр архива с высоким выходом", () => {
    const item = (attribution: string, id: number) => ({ source: "commons", attribution, sourceId: `${attribution}-${id}` });
    const pool = [
      item("Europeana 1914-1918", 1),
      item("Europeana 1914-1918", 2),
      item("IWM", 1),
      item("IWM", 2),
    ];
    const flat = interleaveBySource(pool).map((i) => i.attribution);
    // без весов - поровну, по алфавиту корзин
    expect(flat[0]).toBe("Europeana 1914-1918");
    const weighted = interleaveBySource(pool, w).map((i) => i.attribution);
    expect(weighted.slice(0, 2)).toEqual(["IWM", "IWM"]);
  });
});
