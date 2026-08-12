import { describe, expect, it } from "vitest";
import { passesGate } from "../src/scoring.js";

const limits = { minScore: 40, hooklessMinScore: 85 };

/** Кадр «как из сборщика»: оценка плюс теги. */
const frame = (score: number, hook?: string) => ({ score, tags: hook ? { hook } : {} });

describe("passesGate - что попадает в предложку", () => {
  it("технический брак отсеивается по общему порогу", () => {
    expect(passesGate(frame(30, "trophy"), limits)).toEqual({ pass: false, reason: "dull" });
  });

  it("трофей проходит, даже если это позирование у захваченного танка", () => {
    // живой пример ручной редактуры: «Немцы позируют возле захваченного Mk1»
    expect(passesGate(frame(62, "trophy"), limits)).toEqual({ pass: true });
  });

  it("солдаты с девушками не проходят: крючка нет", () => {
    expect(passesGate(frame(65), limits)).toEqual({ pass: false, reason: "hookless" });
    expect(passesGate(frame(65, "none"), limits)).toEqual({ pass: false, reason: "hookless" });
  });

  it("кадр без крючка проходит только исключительным", () => {
    expect(passesGate(frame(84, "none"), limits)).toEqual({ pass: false, reason: "hookless" });
    expect(passesGate(frame(85, "none"), limits)).toEqual({ pass: true });
  });

  it("все семь крючков пускают кадр среднего качества", () => {
    for (const hook of ["trophy", "wreck", "moment", "rare", "oddity", "human", "action"]) {
      expect(passesGate(frame(50, hook), limits)).toEqual({ pass: true });
    }
  });

  it("выдуманный моделью крючок считается отсутствием крючка", () => {
    // иначе достаточно ответить любым словом, чтобы протащить кадр
    expect(passesGate(frame(60, "interesting"), limits)).toEqual({ pass: false, reason: "hookless" });
  });
});
