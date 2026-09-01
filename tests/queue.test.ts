import { describe, expect, it } from "vitest";
import { buildAnalysisQueue } from "../src/queue.js";

type Item = {
  source: string;
  sourceId: string;
  title?: string;
  year?: number;
  attribution?: string;
  imageUrl: string;
  sourceUrl: string;
  license: string;
  lang: string;
};

let seq = 0;
const make = (over: Partial<Item>): Item => ({
  source: "commons",
  sourceId: `id-${seq++}`,
  title: `frame ${seq}`,
  year: 1916,
  attribution: "IWM",
  imageUrl: "u",
  sourceUrl: "s",
  license: "pd",
  lang: "en",
  ...over,
});

describe("buildAnalysisQueue", () => {
  it("дубль названия слота не получает", () => {
    // живая очередь 31.08: «Citation winners...» занял три слота из тридцати
    const items = [
      make({ title: "Citation winners in the war production drive" }),
      make({ title: "Citation winners in the war production drive" }),
      make({ title: "Citation Winners in the War Production Drive!" }), // регистр и знаки не спасают
      make({ title: "другой кадр" }),
    ];
    const { queue, cuts } = buildAnalysisQueue(items, 10);
    expect(queue).toHaveLength(2);
    expect(cuts.duplicates).toBe(2);
  });

  it("кадры без названия не считаются дублями друг друга", () => {
    const items = [make({ title: undefined }), make({ title: "" }), make({ title: undefined })];
    const { queue, cuts } = buildAnalysisQueue(items, 10);
    expect(queue).toHaveLength(3);
    expect(cuts.duplicates).toBe(0);
  });

  it("один архив не занимает больше своей доли, его лишнее уступает другим", () => {
    // LOC брал 7 мест из 30 при трети сырья - другие архивы ждали в хвосте
    const loc = Array.from({ length: 10 }, (_, i) =>
      make({ attribution: "Library of Congress", title: `loc ${i}` }),
    );
    const others = Array.from({ length: 10 }, (_, i) =>
      make({ attribution: `archive-${i}`, title: `other ${i}` }),
    );
    const { queue } = buildAnalysisQueue([...loc, ...others], 12);
    const locCount = queue.filter((i) => i.attribution === "Library of Congress").length;
    expect(locCount).toBe(2); // ceil(12/6)
    expect(queue).toHaveLength(12);
  });

  it("ВМВ не занимает больше половины очереди, пока есть другие эпохи", () => {
    // резерв 31.08: десять постов ВМВ подряд в плане - монокультура
    // начинается в очереди анализа, а не в планировщике
    const ww2 = Array.from({ length: 8 }, (_, i) =>
      make({ year: 1943, attribution: `w-${i}`, title: `ww2 ${i}` }),
    );
    const ww1 = Array.from({ length: 8 }, (_, i) =>
      make({ year: 1916, attribution: `o-${i}`, title: `ww1 ${i}` }),
    );
    const { queue } = buildAnalysisQueue([...ww2, ...ww1], 8);
    const ww2Count = queue.filter((i) => i.year === 1943).length;
    expect(ww2Count).toBe(4);
    expect(queue).toHaveLength(8);
  });

  it("потолки мягкие: без другого материала очередь добирается придержанными", () => {
    const ww2 = Array.from({ length: 6 }, (_, i) =>
      make({ year: 1944, attribution: `a-${i}`, title: `only ww2 ${i}` }),
    );
    const { queue, cuts } = buildAnalysisQueue(ww2, 6);
    expect(queue).toHaveLength(6); // лучше полная партия ВМВ, чем пустые слоты
    expect(cuts.ww2Capped).toBeGreaterThan(0);
  });

  it("порядок перемешивания сохраняется у прошедших", () => {
    const items = [
      make({ title: "первый", attribution: "A" }),
      make({ title: "второй", attribution: "B" }),
      make({ title: "третий", attribution: "C" }),
    ];
    const { queue } = buildAnalysisQueue(items, 3);
    expect(queue.map((i) => i.title)).toEqual(["первый", "второй", "третий"]);
  });
});
