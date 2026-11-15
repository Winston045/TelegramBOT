/**
 * Выход архивов: сколько кадров каждого архива ушло на анализ (то есть
 * съело квоту Gemini), сколько прошло сито и сколько вышло в канал.
 *
 * Разбор 15.11: бот работает на автопилоте, а резерв живёт впритык -
 * приток около кадра в день при расходе три в день, сито отсеивает
 * четыре из пяти. Чтобы решить, кому из архивов давать слоты анализа,
 * нужны цифры, а не впечатления.
 *
 * Запуск: npx tsx scripts/yield.ts [дней, по умолчанию 30]
 */
import { getDb } from "../src/db.js";
import { archiveKey } from "../src/plan.js";

const DAYS = Number(process.argv[2]) || 30;

type Row = {
  status: string;
  attribution: string | null;
  source: string | null;
  created_at: string;
  tags: { gate?: string } | null;
};

async function main() {
  const db = getDb();
  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();
  const rows: Row[] = [];
  // постранично: Supabase отдаёт по тысяче строк
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db
      .from("candidates")
      .select("status, attribution, source, created_at, tags")
      .gte("created_at", since)
      .order("id", { ascending: true })
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    rows.push(...((data ?? []) as Row[]));
    if (!data || data.length < 1000) break;
  }
  console.log(`ВЫХОД АРХИВОВ за ${DAYS} дн.: ${rows.length} кадров прошли анализ\n`);

  const passed = (s: string) => ["new", "shown", "approved", "published"].includes(s);
  const by = new Map<string, Row[]>();
  for (const r of rows) {
    const key = archiveKey(r.attribution) || r.source || "?";
    by.set(key, [...(by.get(key) ?? []), r]);
  }
  const lines = [...by.entries()]
    .map(([key, list]) => {
      const ok = list.filter((r) => passed(r.status)).length;
      const pub = list.filter((r) => r.status === "published").length;
      const gates = new Map<string, number>();
      for (const r of list) {
        if (r.status !== "rejected") continue;
        const g = r.tags?.gate ?? "?";
        gates.set(g, (gates.get(g) ?? 0) + 1);
      }
      const top = [...gates.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([g, n]) => `${g}×${n}`)
        .join(", ");
      return { key, n: list.length, ok, pub, top };
    })
    .sort((a, b) => b.n - a.n);
  console.log("архив: анализ → прошло сито → вышло | почему отсеяны");
  for (const l of lines) {
    const rate = l.n ? Math.round((100 * l.ok) / l.n) : 0;
    console.log(
      `  ${l.key}: ${l.n} → ${l.ok} (${rate}%) → ${l.pub}${l.top ? ` | ${l.top}` : ""}`,
    );
  }

  const total = rows.length;
  const ok = rows.filter((r) => passed(r.status)).length;
  console.log(`\nвсего: ${total} → ${ok} (${total ? Math.round((100 * ok) / total) : 0}%)`);

  // приток по дням: сколько анализов и сколько годных в день
  console.log("\nПО ДНЯМ: анализ → годных");
  const days = new Map<string, { n: number; ok: number }>();
  for (const r of rows) {
    const d = r.created_at.slice(0, 10);
    const cur = days.get(d) ?? { n: 0, ok: 0 };
    cur.n++;
    if (passed(r.status)) cur.ok++;
    days.set(d, cur);
  }
  for (const [d, v] of [...days.entries()].sort()) console.log(`  ${d}: ${v.n} → ${v.ok}`);
}

main().catch((err) => {
  console.error("отчёт упал:", err);
  process.exit(1);
});
