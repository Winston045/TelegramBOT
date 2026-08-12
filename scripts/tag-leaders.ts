/**
 * Проставляет тег subject="leader" старым кандидатам: тег появился
 * 11.08, и снимки вождей, собранные раньше, не придерживались
 * планировщиком - лента шла «Гитлер за Гитлером».
 *
 * ИИ не зовём (квота дорога): узнаём вождей по именам в подписи -
 * этого достаточно, кадр без имени в подписи вождём и не читается.
 * Публикатор смотрит на тег, поэтому правка мгновенно влияет на ленту.
 */
import { getDb } from "../src/db.js";

/** Имена, при которых кадр считается «портретом вождя». */
const LEADERS = [
  "гитлер",
  "сталин",
  "черчилл",
  "муссолини",
  "геббельс",
  "гиммлер",
  "геринг",
  "риббентроп",
  "рузвельт",
  "де голл",
  "франко",
  "тито",
  "хрущёв",
  "хрущев",
  "брежнев",
  "молотов",
  "эйзенхауэр",
  "макартур",
  "жуков",
  "роммель",
  "паулюс",
];

export function looksLikeLeader(captionHtml: string | null): boolean {
  if (!captionHtml) return false;
  // смотрим только тело поста: в цитате-справке имя может быть
  // упомянуто вскользь, а героем кадра будет что-то другое
  const body = captionHtml.split("<blockquote")[0]?.replace(/<[^>]+>/g, " ").toLowerCase() ?? "";
  return LEADERS.some((name) => body.includes(name));
}

async function main() {
  const db = getDb();
  const { data, error } = await db
    .from("candidates")
    .select("id, caption_html, tags, status")
    .in("status", ["new", "shown", "approved"]);
  if (error) throw new Error(error.message);

  let tagged = 0;
  for (const c of data ?? []) {
    const tags = (c.tags ?? {}) as { subject?: string };
    if (tags.subject === "leader") continue;
    if (!looksLikeLeader(c.caption_html)) continue;
    const { error: updErr } = await db
      .from("candidates")
      .update({ tags: { ...tags, subject: "leader" } })
      .eq("id", c.id);
    if (updErr) throw new Error(`#${c.id}: ${updErr.message}`);
    tagged++;
    const head = (c.caption_html ?? "").replace(/<[^>]+>/g, "").slice(0, 60);
    console.log(`  #${c.id} → leader: ${head}`);
  }
  console.log(`размечено вождей: ${tagged} из ${data?.length ?? 0} кандидатов резерва`);
}

import { pathToFileURL } from "node:url";
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error("tag-leaders упал:", err);
    process.exit(1);
  });
}
