/**
 * Разовая миграция к модели 15.11 «удаляй, а не одобряй»: одобрять посты
 * больше не нужно - всё, что не удалено, уже в очереди. Одобренные без
 * назначенного времени и старше срока годности (сентябрь-октябрь: плакаты
 * и пехота США) переводятся в обычный резерв (shown). Публикатор их уже
 * не берёт, а /status и сводка больше не считают их «готовыми».
 *
 * Без --apply - только список. Посты на время не трогаются.
 *
 * Запуск: npx tsx scripts/unapprove-stale.ts [--apply]
 */
import { getDb } from "../src/db.js";
import { RESERVE_TTL_DAYS } from "../src/plan.js";

async function main() {
  const apply = process.argv.includes("--apply");
  const db = getDb();
  const before = new Date(Date.now() - RESERVE_TTL_DAYS * 86_400_000).toISOString();
  const { data, error } = await db
    .from("candidates")
    .select("id, created_at, score, caption_html")
    .eq("status", "approved")
    .is("scheduled_at", null)
    .lt("created_at", before)
    .order("id");
  if (error) throw new Error(error.message);
  const rows = data ?? [];
  console.log(`одобренных без времени старше ${RESERVE_TTL_DAYS} дней: ${rows.length}`);
  for (const r of rows) {
    const head = (r.caption_html ?? "").replace(/<[^>]+>/g, "").split("\n")[0]?.slice(0, 70);
    console.log(`  #${r.id} ${r.created_at.slice(0, 10)} score=${r.score ?? "?"} - ${head}`);
  }
  if (!apply || !rows.length) {
    if (!apply) console.log("(без apply - ничего не изменено)");
    return;
  }
  const { data: done, error: updErr } = await db
    .from("candidates")
    .update({ status: "shown" })
    .in(
      "id",
      rows.map((r) => r.id),
    )
    .eq("status", "approved")
    .is("scheduled_at", null)
    .select("id");
  if (updErr) throw new Error(updErr.message);
  console.log(`переведено в резерв: ${done?.length ?? 0}`);
}

main().catch((err) => {
  console.error("миграция упала:", err);
  process.exit(1);
});
