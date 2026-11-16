import { describe, expect, it } from "vitest";
import { SERVICE_WINDOW, STORY_BONUS, planAuto, rank, type PlanCandidate } from "../src/plan.js";
import { archiveWeights, type YieldRow } from "../src/yield.js";

/** Сетка ленты по типам сюжетов (редакция 15.11). */
const cap = (body: string) => `${body}\n<blockquote expandable>Карелия, 1942 год.</blockquote>`;
const post = (id: number, story: string, score = 60, extra: Partial<PlanCandidate> = {}): PlanCandidate => ({
  id,
  caption_html: cap(`Пост ${id}.`),
  score,
  tags: { subject: `s${id}`, period: `p${id}`, story },
  attribution: `a${id}`,
  ...extra,
});

describe("сетка ленты: будни армии и истории", () => {
  it("будни армии - не чаще раза в три поста", () => {
    expect(SERVICE_WINDOW).toBe(3);
    const pool = [post(1, "service", 90), post(2, "daily", 50)];
    // будни армии были постом раньше - второй такой не встаёт
    const [pick] = planAuto(pool, { subjects: [], civilian: false, stories: ["oddity", "service"] }, 1);
    expect(pick?.id).toBe(2);
    // через два поста - уже можно
    const [later] = planAuto(pool, { subjects: [], civilian: false, stories: ["oddity", "daily", "service"] }, 1);
    expect(later?.id).toBe(1);
  });

  it("план на день не ставит двое будней армии подряд", () => {
    const pool = [post(1, "service", 90), post(2, "service", 88), post(3, "service", 86), post(4, "disaster", 50)];
    const picks = planAuto(pool, { subjects: [], civilian: false }, 3).map((c) => c.tags?.story);
    expect(picks.slice(0, 2)).toEqual(["service", "disaster"]);
  });

  it("человек, поворот и событие идут вперёд при равном качестве, будни армии уступают", () => {
    expect(rank(post(1, "human")) - rank(post(2, "oddity"))).toBe(STORY_BONUS);
    expect(rank(post(1, "twist"))).toBeGreaterThan(rank(post(2, "service")));
    const [pick] = planAuto([post(1, "service", 64), post(2, "human", 60)], { subjects: [], civilian: false }, 1);
    expect(pick?.id).toBe(2);
  });

  it("если в резерве одни будни армии, слот не пустеет (лестница добора)", () => {
    const picks = planAuto([post(1, "service")], { subjects: [], civilian: false, stories: ["service"] }, 1);
    expect(picks).toHaveLength(1);
  });
});

describe("сбор под заказ: архив голодной рубрики получает больше квоты", () => {
  const rows = (attribution: string, feeds: string[]): YieldRow[] =>
    feeds.map((feed) => ({ attribution, status: "published", tags: { feed } }));
  const history = [
    ...rows("NHHC", ["navy", "navy", "navy", "navy", "navy", "navy"]),
    ...rows("SA-kuva", ["ground", "ground", "ground", "ground", "ground", "ground"]),
    // одинаковый выход: у каждого 6 прошедших и 6 отсеянных
    ...Array.from({ length: 6 }, () => ({ attribution: "NHHC", status: "rejected" })),
    ...Array.from({ length: 6 }, () => ({ attribution: "SA-kuva", status: "rejected" })),
  ];

  it("при равном выходе вперёд архив, который кормит рубрику с недобором", () => {
    // флота в резерве нет, техника сыта
    const w = archiveWeights(history, new Map([["navy", 2], ["ground", 0]]));
    expect(w.get("nhhc")!).toBeGreaterThan(w.get("sa-kuva")!);
    expect(w.get("sa-kuva")!).toBeLessThan(1);
  });

  it("без недобора веса как раньше - только по выходу", () => {
    const w = archiveWeights(history);
    expect(w.get("nhhc")).toBe(w.get("sa-kuva"));
  });
});
