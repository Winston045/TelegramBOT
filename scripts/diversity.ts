/**
 * Разбор УЖЕ ВЫШЕДШИХ постов на разнообразие: чем лента набита на самом
 * деле, а не по задумке планировщика.
 *
 * Считаем в порядке публикации, потому что читателю важны не доли за
 * месяц, а соседство: три немецких кадра подряд ощущаются как «канал про
 * немцев», даже если за месяц доля Бундесархива честная треть.
 *
 * Запуск: npx tsx scripts/diversity.ts [сколько последних]
 */
import { getDb } from "../src/db.js";
import { archiveKey } from "../src/plan.js";

const LIMIT = Number(process.argv[2]) || 60;

type Row = {
  id: number;
  published_at: string | null;
  attribution: string | null;
  source: string | null;
  tags: {
    period?: string;
    subject?: string;
    region?: string;
    hook?: string;
    military?: boolean;
    action?: boolean;
    color?: boolean;
  } | null;
  caption_html: string | null;
};

/** «bundesarchiv 12 (30%)» - распределение с долями, по убыванию. */
function spread(values: string[]): string[] {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v || "(нет)", (counts.get(v || "(нет)") ?? 0) + 1);
  const total = values.length || 1;
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `  ${k}: ${n} (${Math.round((n / total) * 100)}%)`);
}

/** Самая длинная серия одинаковых значений подряд и все серии от двух. */
function runs(values: string[], label: string): string[] {
  const out: string[] = [];
  let start = 0;
  let longest = 1;
  for (let i = 1; i <= values.length; i++) {
    if (i < values.length && values[i] && values[i] === values[i - 1]) continue;
    const len = i - start;
    if (len >= 2 && values[start]) {
      out.push(`  ${values[start]} × ${len} подряд (посты ${start + 1}-${i})`);
    }
    if (len > longest) longest = len;
    start = i;
  }
  return out.length ? out : [`  серий нет: ${label} не повторяется подряд`];
}

/** Доля значения true среди заданных тегов. */
function share(rows: Row[], pick: (r: Row) => boolean | undefined): string {
  const known = rows.filter((r) => pick(r) !== undefined);
  if (!known.length) return "нет данных";
  const yes = known.filter((r) => pick(r) === true).length;
  return `${yes} из ${known.length} (${Math.round((yes / known.length) * 100)}%)`;
}

async function main() {
  const db = getDb();
  const { data, error } = await db
    .from("candidates")
    .select("id, published_at, attribution, source, tags, caption_html")
    .eq("status", "published")
    .order("published_at", { ascending: false })
    .limit(LIMIT);
  if (error) throw new Error(error.message);
  const rows = ((data ?? []) as Row[]).reverse(); // от старых к свежим - как в ленте
  if (!rows.length) {
    console.log("опубликованных постов в базе нет");
    return;
  }

  const first = rows[0]?.published_at?.slice(0, 10) ?? "?";
  const last = rows[rows.length - 1]?.published_at?.slice(0, 10) ?? "?";
  console.log(`РАЗБОР ЛЕНТЫ: ${rows.length} постов, ${first} - ${last}\n`);

  const archives = rows.map((r) => archiveKey(r.attribution) || r.source || "");
  const periods = rows.map((r) => r.tags?.period ?? "");
  const subjects = rows.map((r) => r.tags?.subject ?? "");
  const regions = rows.map((r) => r.tags?.region ?? "");
  const hooks = rows.map((r) => r.tags?.hook ?? "(тега нет)");

  console.log("АРХИВЫ");
  spread(archives).forEach((l) => console.log(l));
  console.log("\nсерии подряд:");
  runs(archives, "архив").forEach((l) => console.log(l));

  console.log("\nЭПОХИ");
  spread(periods).forEach((l) => console.log(l));
  console.log("\nсерии подряд:");
  runs(periods, "эпоха").forEach((l) => console.log(l));

  console.log("\nТЕМЫ");
  spread(subjects).forEach((l) => console.log(l));
  console.log("\nсерии подряд:");
  runs(subjects, "тема").forEach((l) => console.log(l));

  console.log("\nРЕГИОНЫ");
  spread(regions).forEach((l) => console.log(l));

  console.log("\nКРЮЧКИ");
  spread(hooks).forEach((l) => console.log(l));

  console.log("\nХАРАКТЕР ЛЕНТЫ");
  console.log(`  военных сюжетов: ${share(rows, (r) => r.tags?.military)}`);
  console.log(`  с действием: ${share(rows, (r) => r.tags?.action)}`);
  console.log(`  подлинный цвет: ${share(rows, (r) => r.tags?.color)}`);

  // повторы темы в узком окне: читатель помнит последние 5-6 постов
  const WINDOW = 6;
  const echoes: string[] = [];
  for (let i = WINDOW; i < rows.length; i++) {
    const subject = subjects[i];
    if (!subject) continue;
    const window = subjects.slice(i - WINDOW, i);
    const same = window.filter((s) => s === subject).length;
    if (same >= 2) echoes.push(`  пост ${i + 1}: «${subject}» уже ${same} раза в предыдущих ${WINDOW}`);
  }
  console.log("\nПОВТОРЫ ТЕМЫ В ОКНЕ ИЗ ШЕСТИ");
  if (echoes.length) echoes.slice(0, 12).forEach((l) => console.log(l));
  else console.log("  повторов нет");

  console.log("\nЛЕНТА ПО ПОРЯДКУ");
  rows.forEach((r, i) => {
    const head = (r.caption_html ?? "").replace(/<[^>]+>/g, "").split("\n")[0]?.slice(0, 46) ?? "";
    // дата и время публикации: без них не отделить посты до правок от тех,
    // что вышли уже по новым правилам
    const when = r.published_at
      ? new Intl.DateTimeFormat("ru-RU", {
          timeZone: "Europe/Moscow",
          day: "2-digit",
          month: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
        }).format(new Date(r.published_at))
      : "-";
    console.log(
      `  ${String(i + 1).padStart(2)}. ${when} [${archives[i] || "?"}] ${periods[i] || "?"}/${subjects[i] || "?"} - ${head}`,
    );
  });
}

main().catch((err) => {
  console.error("разбор упал:", err);
  process.exit(1);
});
