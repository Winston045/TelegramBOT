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
import { EVENT_MEMORY_DAYS, archiveKey, archiveNation, eventKeys, postNation } from "../src/plan.js";
import { storyLine } from "../src/story.js";

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
    event_wiki?: string;
    story?: string;
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

  // страна архива - то, что видит правило чередования; «о ком пост» -
  // то, что видит читатель: британский архив тоже снимал американцев
  const nations = rows.map((r) => archiveNation(r.attribution, r.source) || "(страна не задана)");
  const postNations = rows.map((r) => postNation(r) || "(не названа)");
  console.log("\nСТРАНЫ ПОСТОВ (о ком подпись, иначе страна архива)");
  spread(postNations).forEach((l) => console.log(l));
  console.log("\nсерии подряд:");
  runs(postNations, "страна поста").forEach((l) => console.log(l));
  console.log("\nСТРАНЫ АРХИВОВ");
  spread(nations).forEach((l) => console.log(l));
  console.log("\nсерии подряд:");
  runs(nations, "страна").forEach((l) => console.log(l));
  const aboutUs = rows.filter((r) => /американ|США|U\.S\.|US Army/i.test(r.caption_html ?? "")).length;
  console.log(
    `\nО КОМ ПОСТ: в подписи американцы или США - ${aboutUs} из ${rows.length} ` +
      `(${Math.round((aboutUs / rows.length) * 100)}%)`,
  );

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

  // одно событие в памяти планировщика (EVENT_MEMORY_DAYS): что всё же
  // вышло повтором и по какому ключу его можно было узнать
  console.log(`\nПОВТОРЫ СОБЫТИЙ (ближе ${EVENT_MEMORY_DAYS} дней)`);
  const keysOf = rows.map((r) => eventKeys(r));
  const repeats: string[] = [];
  rows.forEach((r, i) => {
    const at = r.published_at ? Date.parse(r.published_at) : NaN;
    for (let j = 0; j < i; j++) {
      const prev = rows[j]!;
      const gap = (at - Date.parse(prev.published_at ?? "")) / 86_400_000;
      if (!(gap <= EVENT_MEMORY_DAYS)) continue;
      const common = keysOf[i]!.filter((k) => keysOf[j]!.includes(k));
      if (!common.length) continue;
      repeats.push(
        `  посты ${j + 1} и ${i + 1} (через ${gap.toFixed(1)} дн.): ${common.join(" / ")}` +
          ` [ключи: ${keysOf[j]!.join(", ")} | ${keysOf[i]!.join(", ")}]`,
      );
    }
  });
  if (repeats.length) repeats.forEach((l) => console.log(l));
  else console.log("  повторов нет");

  // типы сюжетов (src/story.ts): про что лента, а не откуда кадры
  console.log("\nСЮЖЕТЫ");
  console.log(
    "  " +
      storyLine(rows.map((r) => ({ story: r.tags?.story, color: r.tags?.color, nation: postNation(r) }))),
  );

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
      `  ${String(i + 1).padStart(2)}. ${when} [${archives[i] || "?"}] ${periods[i] || "?"}/${subjects[i] || "?"}` +
        `${r.tags?.story ? ` <${r.tags.story}>` : ""} - ${head}` +
        (keysOf[i]!.length ? `  {${keysOf[i]!.join(" / ")}}` : ""),
    );
  });
}

main().catch((err) => {
  console.error("разбор упал:", err);
  process.exit(1);
});
