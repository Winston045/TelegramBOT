import { describe, expect, it } from "vitest";
import { applyFixes, buildProofreadPrompt, rejectFix, textSegments } from "../src/proofread.js";

const terraNova =
  "Временная стоянка экспедиции «Терра Нова» с ездовыми собаками, палатью и оборудованием.\n" +
  "<blockquote expandable>Антарктида, 1910 год.</blockquote>\n\n" +
  'Library of Congress\n<a href="https://t.me/Story_Teams">STORY | TEAM</a>';

describe("ночная вычитка: куски текста", () => {
  it("берёт описание и цитаты, но не футер", () => {
    const segs = textSegments(terraNova).map((s) => s.text);
    expect(segs).toEqual([
      "Временная стоянка экспедиции «Терра Нова» с ездовыми собаками, палатью и оборудованием.",
      "Антарктида, 1910 год.",
    ]);
  });

  it("сущности раскодированы для модели и закодированы обратно", () => {
    const html = "Танк M4 &amp; экипаж.\n<blockquote>Нормандия, 1944 год.</blockquote>";
    const [seg] = textSegments(html);
    expect(seg!.text).toBe("Танк M4 & экипаж.");
    const fixed = applyFixes(html, [{ raw: seg!.raw, text: "Танк M4 & экипаж!" }]);
    expect(fixed).toContain("Танк M4 &amp; экипаж!");
  });
});

describe("ночная вычитка: страховка", () => {
  it("опечатку («палатью» → «палаткой») пропускает", () => {
    const before = "Временная стоянка экспедиции «Терра Нова» с ездовыми собаками, палатью и оборудованием.";
    const after = "Временная стоянка экспедиции «Терра Нова» с ездовыми собаками, палаткой и оборудованием.";
    expect(rejectFix(before, after)).toBeUndefined();
    const fixed = applyFixes(terraNova, [{ raw: before, text: after }]);
    expect(fixed).toContain("палаткой");
    expect(fixed).toContain('<a href="https://t.me/Story_Teams">STORY | TEAM</a>');
  });

  it("числа, латиница и названия в кавычках неприкосновенны", () => {
    expect(rejectFix("Сбили 5156 самолётов.", "Сбили 5165 самолётов.")).toBe("изменены числа");
    expect(rejectFix("Истребитель F6F на палубе.", "Истребитель F6 на палубе.")).toBe("изменена латиница");
    expect(rejectFix("Барк «Терра Нова» во льдах.", "Барк «Терранова» во льдах.")).toBe(
      "изменены названия в кавычках",
    );
  });

  it("переписывание вместо корректуры отклоняется", () => {
    expect(rejectFix("Колонна пленных идёт по дороге.", "Пленных солдат ведут колонной вдоль шоссе.")).toMatch(
      /переписано/,
    );
    expect(rejectFix("Текст.", "")).toBe("пустой ответ");
  });

  it("промпт запрещает факты и стиль, просит тот же порядок кусков", () => {
    const p = buildProofreadPrompt(["a", "b"]);
    expect(p).toContain("Исправляй ТОЛЬКО язык");
    expect(p).toContain("НЕЛЬЗЯ: менять факты, числа");
    expect(p).toContain('["a","b"]');
  });
});
