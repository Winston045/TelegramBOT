import { describe, expect, it } from "vitest";
import type { AppConfig } from "../src/config.js";
import { planAuto, RUBRIC_WEEKLY_CAP, weekShares, type PlanCandidate } from "../src/plan.js";
import { rejectReason } from "../src/prefilter.js";
import { buildAnalysisQueue } from "../src/queue.js";
import { RUBRICS, rubricCaptionFlaw, rubricTablesMismatch } from "../src/rubrics.js";
import { buildAnalysisPrompt } from "../src/analyze.js";
import type { RawItem } from "../src/sources/types.js";

const cap = (text: string) =>
  `${text}\n<blockquote expandable>СССР, 1943 год.</blockquote>\n\n<a href="https://t.me/x">X</a>`;

function post(id: number, score: number, tags: PlanCandidate["tags"]): PlanCandidate {
  return { id, caption_html: cap(`Пост ${id}`), score, tags, attribution: `Архив ${id}` };
}

const cfg = {
  collect: { min_image_width: 700, min_year: 1850, max_year: 1999 },
  filters: { stop_words: [] },
} as unknown as AppConfig;

const frame = (over: Partial<RawItem>): RawItem => ({
  sourceId: "1",
  sourceUrl: "https://x",
  imageUrl: "https://x.jpg",
  title: "Soldiers at rest",
  lang: "en",
  year: 1943,
  place: "Kursk",
  license: "PD",
  imageWidth: 1200,
  ...over,
});

describe("таблицы рубрик", () => {
  it("у каждой рубрики сбора есть недельный потолок, и наоборот", () => {
    expect(rubricTablesMismatch()).toEqual([]);
  });

  it("рубрики вместе - не больше трети недели при трёх постах в день", () => {
    const total = Object.values(RUBRIC_WEEKLY_CAP).reduce((a, b) => a + b, 0);
    expect(total).toBeLessThanOrEqual(Math.floor((3 * 7) / 3) + 1);
    expect(RUBRIC_WEEKLY_CAP.poster).toBe(1);
  });
});

describe("планировщик и рубрики", () => {
  it("плакат, уже вышедший на этой неделе, не выходит даже лучшим кадром", () => {
    const pool = [
      post(1, 95, { subject: "poster", rubric: "poster", military: true }),
      post(2, 60, { subject: "armor", military: true }),
    ];
    const [pick] = planAuto(pool, { subjects: [], civilian: false, rubricWeek: { poster: 1 } }, 1);
    expect(pick?.id).toBe(2);
  });

  it("сверх потолка рубрика не проходит и аварийным добором - слот пустеет", () => {
    const pool = [post(1, 95, { subject: "poster", rubric: "poster" })];
    expect(planAuto(pool, { subjects: [], civilian: false, rubricWeek: { poster: 1 } }, 1)).toEqual([]);
  });

  it("потолок считает и посты того же плана: два плаката за план не встают", () => {
    const pool = [
      post(1, 95, { subject: "poster", rubric: "poster" }),
      post(2, 94, { subject: "poster2", rubric: "poster" }),
      post(3, 50, { subject: "armor" }),
      post(4, 49, { subject: "navy" }),
    ];
    const plan = planAuto(pool, { subjects: [], civilian: false }, 4);
    expect(plan.filter((c) => c.tags?.rubric === "poster")).toHaveLength(1);
  });

  it("две рубрики подряд не идут - между ними военное ядро", () => {
    const pool = [
      post(1, 95, { subject: "aviation", rubric: "modern" }),
      post(2, 94, { subject: "armor", rubric: "modern" }),
      post(3, 50, { subject: "navy" }),
    ];
    const plan = planAuto(pool, { subjects: [], civilian: false }, 3);
    expect(plan.map((c) => c.id)).toEqual([1, 3, 2]);
  });

  it("недельный счётчик рубрик берётся из вышедших постов", () => {
    const week = weekShares([
      { tags: { rubric: "poster" } },
      { tags: { rubric: "modern" } },
      { tags: { rubric: "modern" } },
      { tags: { subject: "armor" } },
    ]);
    expect(week.rubricWeek).toEqual({ poster: 1, modern: 2 });
  });
});

describe("префильтр и рубрики", () => {
  it("у рубрики своё окно лет: современная армия после 1999-го проходит", () => {
    expect(rejectReason(frame({ year: 2004 }), cfg)).toBe("year_out_of_range");
    expect(rejectReason(frame({ year: 2004, rubric: "modern" }), cfg)).toBeNull();
    // текущие войны - мимо даже в рубрике
    expect(rejectReason(frame({ year: 2022, rubric: "modern" }), cfg)).toBe("year_out_of_range");
    // и ВМВ в рубрике современной армии - чужая
    expect(rejectReason(frame({ year: 1943, rubric: "modern" }), cfg)).toBe("year_out_of_range");
  });

  it("плакат в своей рубрике - не брак, в ядре - брак", () => {
    const poster = { description: "1 print (poster) : lithograph, color.", title: "Buy war bonds" };
    expect(rejectReason(frame({ ...poster, description: "1 poster : lithograph" }), cfg)).toBe("not_photo");
    expect(rejectReason(frame({ ...poster, description: "1 poster : lithograph", rubric: "poster" }), cfg)).toBeNull();
  });

  it("снимок, попавший в плакатную выдачу, - чужой", () => {
    expect(
      rejectReason(
        frame({ rubric: "poster", description: "1 photographic print. | Soldiers putting up posters" }),
        cfg,
      ),
    ).toBe("not_artwork");
  });

  it("опечатка в имени рубрики не превращает кадр в ядро молча", () => {
    expect(rejectReason(frame({ rubric: "posters" }), cfg)).toBe("unknown_rubric");
  });
});

describe("очередь анализа и рубрики", () => {
  const item = (i: number, rubric?: string) => ({
    ...frame({ sourceId: String(i), title: `Frame ${i}`, attribution: `Archive ${i % 10}`, year: 1950 }),
    source: "commons",
    ...(rubric ? { rubric } : {}),
  });

  it("одна рубрика - не больше двух слотов из тридцати, все вместе - не больше четверти", () => {
    const items = [
      ...Array.from({ length: 6 }, (_, i) => item(i, "poster")),
      ...Array.from({ length: 6 }, (_, i) => item(10 + i, "culture")),
      ...Array.from({ length: 6 }, (_, i) => item(20 + i, "social")),
      ...Array.from({ length: 6 }, (_, i) => item(30 + i, "modern")),
      ...Array.from({ length: 6 }, (_, i) => item(40 + i, "ussr_daily")),
      ...Array.from({ length: 40 }, (_, i) => item(100 + i)),
    ];
    const { queue } = buildAnalysisQueue(items, 30);
    const counts = new Map<string, number>();
    for (const q of queue) if (q.rubric) counts.set(q.rubric, (counts.get(q.rubric) ?? 0) + 1);
    for (const n of counts.values()) expect(n).toBeLessThanOrEqual(2);
    expect([...counts.values()].reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(7);
    expect(queue).toHaveLength(30);
  });
});

describe("подпись рубрики", () => {
  it("повседневность без факта - не изюминка, не в резерв", () => {
    const r = RUBRICS.ussr_daily!;
    expect(rubricCaptionFlaw(r, { caption: "Очередь у магазина.", quote: "Москва, 1965 год." })).toBeDefined();
    expect(rubricCaptionFlaw(r, { caption: "Очередь у магазина.", quote: "" })).toBeDefined();
    expect(
      rubricCaptionFlaw(r, {
        caption: "Очередь у ГУМа.",
        quote: "В день открытия после реконструкции в 1953 году универмаг принял больше 100 тысяч покупателей.",
      }),
    ).toBeUndefined();
  });

  it("плакат обязан назвать жанр", () => {
    const r = RUBRICS.poster!;
    expect(rubricCaptionFlaw(r, { caption: "Солдат зовёт покупать облигации.", quote: "США, 1942 год." })).toBeDefined();
    expect(
      rubricCaptionFlaw(r, { caption: "Американский плакат зовёт покупать облигации.", quote: "США, 1942 год." }),
    ).toBeUndefined();
  });

  it("в промпт уходит постановка рубрики, у ядра - нет", () => {
    expect(buildAnalysisPrompt(frame({ rubric: "poster" }), {})).toContain("РУБРИКА «ПЛАКАТЫ И КАРИКАТУРЫ»");
    expect(buildAnalysisPrompt(frame({}), {})).not.toContain("РУБРИКА");
  });
});
