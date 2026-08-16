import { describe, expect, it } from "vitest";
import { byPromise, promise } from "../src/promise.js";
import type { RawItem } from "../src/sources/types.js";

const frame = (title: string, description?: string, place?: string): RawItem => ({
  sourceId: title,
  sourceUrl: "https://x",
  imageUrl: "https://x.jpg",
  lang: "en",
  license: "PD",
  year: 1943,
  title,
  description,
  place,
});

describe("обещание кадра", () => {
  it("трофей и обломки обещают больше, чем церемония", () => {
    const trophy = promise(frame("Captured Tiger tank towed to the rear"));
    const dull = promise(frame("Award ceremony at the divisional headquarters"));
    expect(trophy).toBeGreaterThan(dull);
  });

  it("подлинный цвет поднимает кадр", () => {
    const color = promise(frame("Kodachrome photograph of a bomber crew"));
    const plain = promise(frame("Photograph of a bomber crew"));
    expect(color).toBeGreaterThan(plain);
  });

  it("слова-крючки узнаются и по-русски, и по-немецки", () => {
    expect(promise(frame("Подбитый советский танк на обочине"))).toBeGreaterThan(0);
    expect(promise(frame("Erbeuteter sowjetischer Panzer"))).toBeGreaterThan(0);
  });

  it("длинное описание и известное место добавляют вес", () => {
    const rich = promise(
      frame("Soldiers", "A".repeat(200), "Kursk"),
    );
    const bare = promise(frame("Soldiers"));
    expect(rich).toBeGreaterThan(bare);
  });

  it("протокол уходит в минус - но не выбрасывается", () => {
    expect(promise(frame("Portrait of the commanding officer"))).toBeLessThan(0);
  });
});

describe("сортировка очереди", () => {
  it("перспективные впереди, порядок равных не меняется", () => {
    const items = [
      frame("Meeting of the staff"),
      frame("Burning Panther after the ambush"),
      frame("Soldiers at rest"),
      frame("Wreck of a Junkers on the airfield"),
    ];
    const order = byPromise(items).map((i) => i.title);
    expect(order[0]).toBe("Burning Panther after the ambush");
    expect(order[1]).toBe("Wreck of a Junkers on the airfield");
    expect(order[3]).toBe("Meeting of the staff");
  });

  it("ничего не теряется - только переставляется", () => {
    const items = [frame("a"), frame("Captured gun"), frame("c")];
    expect(byPromise(items)).toHaveLength(3);
  });
});
