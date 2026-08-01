/**
 * Проверка энциклопедического контекста Commons: берёт последние карточки
 * этого источника из базы и печатает, какую справку к ним нашёл details().
 * Нужна, чтобы видеть материал для развёрнутых цитат до сбора.
 */
import { getDb } from "../src/db.js";
import { commons } from "../src/sources/commons.js";
import type { RawItem } from "../src/sources/types.js";

async function main() {
  const limit = Number(process.argv[2]) || 6;
  const { data, error } = await getDb()
    .from("candidates")
    .select("id, source_id, raw_title")
    .eq("source", "commons")
    .order("id", { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);

  for (const c of data ?? []) {
    const ctx = await commons.details?.({ sourceId: c.source_id } as RawItem);
    console.log("═".repeat(70));
    console.log(`#${c.id} ${c.raw_title}`);
    console.log(ctx ? ctx.slice(0, 600) : "(контекста нет)");
  }
}

main().catch((err) => {
  console.error("probe-context упал:", err);
  process.exit(1);
});
