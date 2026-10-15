/**
 * Чистка резерва и очереди от не-фотографий: рисунков, плакатов, гравюр.
 *
 * Префильтр теперь не пускает их в анализ, но те, что прошли раньше, уже
 * лежат готовыми постами (живой случай 15.10: #408, фронтовой рисунок
 * Говарда Броди с подписью «Боец на ночном дежурстве в окопе»). Судим по
 * тому же правилу, что и префильтр, - по физическому описанию архива.
 * Опубликованное не трогаем: удалять посты из канала - решение редактора.
 *
 * Запуск: маркер purgenonphoto в .github/report.trigger.
 */
import { getDb } from "../src/db.js";
import { isNonPhotoRecord } from "../src/prefilter.js";

async function main() {
  const db = getDb();
  const { data, error } = await db
    .from("candidates")
    .select("id, status, source, source_id, raw_title, raw_desc")
    .in("status", ["new", "shown", "approved"]);
  if (error) throw new Error(error.message);

  const victims = (data ?? []).filter((c) => isNonPhotoRecord(c.raw_title, c.raw_desc));
  console.log(`проверено готовых постов: ${data?.length ?? 0}, не-фотографий: ${victims.length}`);
  for (const c of victims) {
    const { error: updErr } = await db
      .from("candidates")
      .update({ status: "rejected" })
      .eq("id", c.id)
      .eq("status", c.status); // не перетираем, если статус успел смениться
    if (updErr) throw new Error(`#${c.id}: ${updErr.message}`);
    console.log(
      `  снят #${c.id} (${c.status}) [${c.source} ${c.source_id}] ${(c.raw_title ?? "").slice(0, 70)}`,
    );
    console.log(`     ${(c.raw_desc ?? "").replace(/\s+/g, " ").slice(0, 120)}`);
  }
}

main().catch((err) => {
  console.error("purge-nonphoto упал:", err);
  process.exit(1);
});
