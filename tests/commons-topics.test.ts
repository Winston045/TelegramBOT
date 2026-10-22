import { describe, expect, it } from "vitest";
import { COMMONS_ONLY_CATEGORY } from "../src/sources/commons.js";

describe("темы файла для справки о событии", () => {
  it("категории-пересечения Викисклада в Википедию не ходят", () => {
    // все из полного сбора 22.10 - каждая ушла в 429 впустую
    for (const cat of [
      "1944 in Mulhouse",
      "M1 helmet in French service",
      "Willys MB during World War II",
      "Black and white photographs of Berlin",
      "Construction workers in Berlin (East) 1968",
      "Construction of the Berliner Fernsehturm in 1968",
      "Photographs by Horst Sturm",
    ]) {
      expect(COMMONS_ONLY_CATEGORY.test(cat), cat).toBe(true);
    }
  });

  it("настоящие статьи остаются", () => {
    for (const cat of [
      "Battle of the Vosges (1944)",
      "1st Armored Division (France)",
      "USS Little (DD-79)",
      "Hindenburg disaster",
      "Fore River Shipyard",
      "Boulton Paul Defiant",
    ]) {
      expect(COMMONS_ONLY_CATEGORY.test(cat), cat).toBe(false);
    }
  });
});
