/**
 * Вкус редакции по её удалениям (16-22.11: «ты видишь, какие посты я
 * отменяю сам - сделай вывод, что такой контент мне не нужен»).
 *
 * Удаление редактором - rejected с готовой подписью и без пометки отсева
 * (tags.gate ставят сбор и чистки); с 22.11 бот пишет и явную пометку
 * tags.editor. Сравнение с вышедшим за то же время по каждой оси: какая
 * доля кадров с таким признаком удалена и во сколько раз чаще среднего.
 *
 *   npx tsx scripts/editor-taste.ts [дней, по умолчанию 30]
 */
import { getDb, selectAll } from "../src/db.js";
import { archiveKey, headline, postNation } from "../src/plan.js";
import { feedLabel, feedOf, marksOf } from "../src/feed.js";

type Row = {
  id: number;
  status: string;
  created_at: string;
  published_at: string | null;
  caption_html: string | null;
  attribution: string | null;
  source: string | null;
  score: number | null;
  tags: Record<string, unknown> | null;
};

export function isEditorReject(r: Pick<Row, "status" | "caption_html" | "tags">): boolean {
  if (r.status !== "rejected" || !r.caption_html) return false;
  if (r.tags?.editor) return true;
  return !r.tags?.gate;
}

async function main() {
  const days = Number(process.argv[2]) || 30;
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const db = getDb();
  const rows = await selectAll<Row>((from, to) =>
    db
      .from("candidates")
      .select("id, status, created_at, published_at, caption_html, attribution, source, score, tags")
      .in("status", ["rejected", "published"])
      .not("caption_html", "is", null)
      .gte("created_at", since)
      .order("id")
      .range(from, to),
  );
  const del = rows.filter(isEditorReject);
  const pub = rows.filter((r) => r.status === "published");
  const all = [...del, ...pub];
  const base = del.length / Math.max(1, all.length);
  console.log(`за ${days} дн.: удалено редакцией ${del.length}, вышло ${pub.length}; доля удалений ${(base * 100).toFixed(0)}%\n`);

  const t = (r: Row, k: string) => (r.tags?.[k] as string | boolean | undefined)?.toString() ?? "-";
  const axes: Array<[string, (r: Row) => string[]]> = [
    ["рубрика", (r) => [feedLabel(feedOf(r as never))]],
    ["тема", (r) => [t(r, "subject")]],
    ["сюжет", (r) => [t(r, "story")]],
    ["крючок", (r) => [t(r, "hook")]],
    ["эпоха", (r) => [t(r, "period")]],
    ["страна", (r) => [postNation(r) || "-"]],
    ["архив", (r) => [archiveKey(r.attribution) || r.source || "-"]],
    ["метки", (r) => { const m = marksOf(r as never); return m.length ? m : ["-"]; }],
    ["военное", (r) => [t(r, "military")]],
    ["действие", (r) => [t(r, "action")]],
    ["цитата", (r) => [/<blockquote[^>]*>[^<]{90,}/.test(r.caption_html ?? "") ? "развёрнутая" : "короткая/нет"]],
  ];
  for (const [name, f] of axes) {
    const m = new Map<string, { d: number; p: number }>();
    for (const r of all) for (const v of f(r)) {
      const s = m.get(v) ?? { d: 0, p: 0 };
      if (isEditorReject(r)) s.d++;
      else s.p++;
      m.set(v, s);
    }
    const lines = [...m]
      .filter(([, s]) => s.d + s.p >= 3)
      .map(([v, s]) => ({ v, ...s, rate: s.d / (s.d + s.p) }))
      .sort((a, b) => b.rate - a.rate);
    console.log(`${name.toUpperCase()}`);
    for (const l of lines) {
      const lift = base ? l.rate / base : 0;
      console.log(`  ${l.v}: удалено ${l.d} из ${l.d + l.p} (${(l.rate * 100).toFixed(0)}%)${lift >= 1.5 ? `  ×${lift.toFixed(1)} чаще среднего` : ""}`);
    }
    console.log("");
  }
  console.log("УДАЛЁННОЕ РЕДАКЦИЕЙ, свежие первыми:");
  for (const r of del.sort((a, b) => b.id - a.id)) {
    console.log(
      `  #${r.id} ${r.created_at.slice(5, 10)} [${feedLabel(feedOf(r as never))}/${t(r, "subject")}/${t(r, "story")}] ${postNation(r) || "-"} ${archiveKey(r.attribution) || r.source} ${r.score} - ${headline(r.caption_html, 110)}`,
    );
  }
}

if (process.argv[1]?.endsWith("editor-taste.ts")) {
  main().catch((err) => {
    console.error("отчёт упал:", err);
    process.exit(1);
  });
}
