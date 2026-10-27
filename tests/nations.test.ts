import { describe, expect, it } from "vitest";
import {
  captionNation,
  NATION_WINDOW,
  planAuto,
  postNation,
  rank,
  weekShares,
  type PlanCandidate,
} from "../src/plan.js";
import { buildAnalysisQueue } from "../src/queue.js";
import type { RawItem } from "../src/sources/types.js";

const cap = (body: string, quote = "Франция, 1944 год.") =>
  `${body}\n<blockquote expandable>${quote}</blockquote>\n\n<a href="https://t.me/x">X</a>`;

function post(id: number, body: string, attribution: string, subject = `s${id}`): PlanCandidate {
  return { id, caption_html: cap(body), score: 60, tags: { subject, period: `p${id % 3}` }, attribution };
}

describe("о ком пост", () => {
  it("страна, названная в описании первой", () => {
    expect(captionNation(cap("Американские солдаты осматривают подбитый немецкий танк."))).toBe("usa");
    expect(captionNation(cap("Немецкий танк, подбитый американскими солдатами."))).toBe("germany");
    expect(captionNation(cap("Пехотинцы 35-й дивизии армии США продвигаются по улице."))).toBe("usa");
    expect(captionNation(cap("Бойцы Красной армии под прикрытием дымовой завесы."))).toBe("ussr");
    expect(captionNation(cap("Британские солдаты готовят к подъёму аэростат."))).toBe("uk");
  });

  it("цитата и подпись канала на страну не влияют", () => {
    expect(captionNation(cap("Колонна на марше.", "США, 1944 год."))).toBe("");
  });

  it("подпись важнее архива: американцы из британского архива - это США", () => {
    expect(postNation({ caption_html: cap("Американские морпехи на берегу."), attribution: "IWM" })).toBe("usa");
    // страны в тексте нет - остаётся страна архива
    expect(postNation({ caption_html: cap("Колонна на марше."), attribution: "IWM" })).toBe("uk");
  });
});

describe("чередование стран по смыслу поста", () => {
  it("американец из чужого архива не встаёт сразу после американца", () => {
    const pool = [
      post(1, "Американский плакат времён Второй мировой.", "WWII posters"),
      post(2, "Финские лыжники на привале.", "SA-kuva"),
    ];
    pool[0]!.score = 90;
    const [pick] = planAuto(pool, { subjects: [], civilian: false, nations: ["usa"] }, 1);
    expect(pick?.id).toBe(2);
  });

  it("одна страна - не чаще раза в три поста", () => {
    expect(NATION_WINDOW).toBe(3);
    const pool = [
      post(1, "Американские пехотинцы в Арденнах.", "NARA"),
      post(2, "Американские танкисты у «Шермана».", "Library of Congress"),
      post(3, "Немецкие сапёры наводят мост.", "Bundesarchiv"),
      post(4, "Финские лыжники на привале.", "SA-kuva"),
      post(5, "Польские уланы на марше.", "Narodowe Archiwum Cyfrowe"),
    ];
    const plan = planAuto(pool, { subjects: [], civilian: false }, 5);
    const nations = plan.map((c) => postNation(c));
    for (let i = 1; i < nations.length; i++) {
      const window = nations.slice(Math.max(0, i - (NATION_WINDOW - 1)), i);
      if (nations[i] === "usa") expect(window).not.toContain("usa");
    }
  });

  it("страна, занявшая больше пятой части недели, уступает равному кадру", () => {
    const us = post(1, "Американские пехотинцы в Арденнах.", "NARA");
    const fi = post(2, "Финские лыжники на привале.", "SA-kuva");
    const week = weekShares([
      { caption_html: cap("Американские лётчики."), attribution: "NARA" },
      { caption_html: cap("Американские моряки."), attribution: "NHHC" },
      { caption_html: cap("Немецкие сапёры."), attribution: "Bundesarchiv" },
    ]);
    expect(week.nationShare.usa).toBeCloseTo(2 / 3);
    expect(rank(us, undefined, undefined, undefined, week.nationShare)).toBeLessThan(
      rank(fi, undefined, undefined, undefined, week.nationShare),
    );
  });
});

describe("очередь анализа: потолок страны архива", () => {
  const item = (i: number, attribution: string, source = "commons"): RawItem & { source: string } => ({
    sourceId: String(i),
    sourceUrl: "https://x",
    imageUrl: "https://x.jpg",
    title: `Frame ${i}`,
    lang: "en",
    license: "PD",
    year: 1950,
    place: "x",
    attribution,
    source,
  });

  it("США вместе - не больше четверти очереди, даже из разных архивов", () => {
    const us = ["NARA", "Library of Congress", "US Army Signal Corps", "NHHC", "USAF"];
    const others = ["Bundesarchiv", "SA-kuva", "IWM", "Anefo", "Fortepan", "AWM"];
    const items = Array.from({ length: 60 }, (_, i) =>
      i % 2 ? item(i, others[(i >> 1) % others.length]!) : item(i, us[(i >> 1) % us.length]!),
    );
    const { queue, cuts } = buildAnalysisQueue(items, 30);
    const usCount = queue.filter((q) => us.includes(q.attribution!)).length;
    expect(usCount).toBeLessThanOrEqual(7);
    expect(cuts.nationCapped).toBeGreaterThan(0);
    expect(queue).toHaveLength(30);
  });
});

describe("одобрение стареет вместе с резервом", async () => {
  const { approvedPriority, APPROVED_PRIORITY, RESERVE_TTL_DAYS } = await import("../src/plan.js");
  const now = new Date("2026-10-22T07:00:00Z");
  const daysAgo = (d: number) => new Date(now.getTime() - d * 24 * 3600 * 1000).toISOString();

  it("свежий одобренный - вперёд, старый - на общих основаниях", () => {
    expect(approvedPriority(daysAgo(2), now)).toBe(APPROVED_PRIORITY);
    expect(approvedPriority(daysAgo(RESERVE_TTL_DAYS + 1), now)).toBe(0);
    expect(approvedPriority(undefined, now)).toBe(APPROVED_PRIORITY);
  });

  it("старая американская пехота из очереди не обходит сильный свежий кадр", () => {
    const stale = { ...post(1, "Американские пехотинцы на марше.", "US Army Signal Corps"), score: 52, priority: approvedPriority(daysAgo(45), now) };
    const fresh = { ...post(2, "Подбитая советская самоходка ИСУ-152.", "Fortepan"), score: 75 };
    const [pick] = planAuto([stale, fresh], { subjects: [], civilian: false }, 1);
    expect(pick?.id).toBe(2);
  });
});

describe("своё - СССР и Россия (решение редакции 26.10)", () => {
  it("русская армия до 1917-го и российская после - тоже своё", () => {
    expect(captionNation(cap("Русские солдаты на Юго-Западном фронте."))).toBe("ussr");
    expect(captionNation(cap("Российские десантники на учениях."))).toBe("ussr");
  });

  it("свой пост может идти через один, чужой - раз в три", () => {
    const pool = [
      post(1, "Бойцы Красной армии в Сталинграде.", "РИА Новости"),
      post(2, "Финские лыжники на привале.", "SA-kuva"),
    ];
    // два поста назад был советский - для своего это не помеха
    const [pick] = planAuto(pool, { subjects: [], civilian: false, nations: ["germany", "ussr"] }, 1);
    expect(pick?.id).toBe(1);
    // но не два своих подряд
    const [next] = planAuto(pool, { subjects: [], civilian: false, nations: ["ussr"] }, 1);
    expect(next?.id).toBe(2);
  });

  it("при равном качестве своё идёт первым", () => {
    const soviet = post(1, "Советские танкисты у Т-34.", "РИА Новости");
    const us = post(2, "Американские танкисты у «Шермана».", "Library of Congress");
    expect(rank(soviet)).toBeGreaterThan(rank(us));
  });

  it("недельная доля своего мягче: штраф только после 40%", () => {
    const soviet = post(1, "Советские танкисты у Т-34.", "РИА Новости");
    const us = post(2, "Американские танкисты у «Шермана».", "Library of Congress");
    const share = { ussr: 0.35, usa: 0.35 };
    expect(rank(soviet, {}, {}, {}, share) - rank(soviet)).toBe(0);
    expect(rank(us, {}, {}, {}, share)).toBeLessThan(rank(us));
  });
});

describe("США - отдельная планка (редакция 27.10: «очень много США»)", () => {
  it("американский пост - не чаще раза в пять", () => {
    const pool = [
      post(1, "Американские пехотинцы в Арденнах.", "NARA"),
      post(2, "Финские лыжники на привале.", "SA-kuva"),
    ];
    pool[0]!.score = 95;
    const [pick] = planAuto(
      pool,
      { subjects: [], civilian: false, nations: ["germany", "uk", "ussr", "usa"] },
      1,
    );
    expect(pick?.id).toBe(2);
  });

  it("штраф за долю недели у США начинается с 10%", () => {
    const us = post(1, "Американские танкисты у «Шермана».", "Library of Congress");
    expect(rank(us, {}, {}, {}, { usa: 0.15 })).toBeLessThan(rank(us));
    const uk = post(2, "Британские танкисты у «Кромвеля».", "IWM");
    expect(rank(uk, {}, {}, {}, { uk: 0.15 })).toBe(rank(uk));
  });
});
