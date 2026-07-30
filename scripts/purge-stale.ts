/**
 * Одноразовая чистка резерва после смены стиля подписей (29.07.2026).
 *
 * Автопостинг берёт кандидатов без глаз редактора, поэтому в резерве
 * не должно быть: (а) карточек, проанализированных до финального промпта -
 * у них старый стиль подписи; (б) дубликатов уже вышедшего в канал -
 * старые партии собирались, когда база дедупа ещё не была заполнена
 * бэкфиллом. И то и другое помечаем rejected.
 */
import { getDb } from "../src/db.js";
import { isDuplicate } from "../src/dhash.js";

// финальный стиль подписей доехал коммитом ea7b037 29.07.2026 15:08 UTC
const STYLE_CUTOFF = "2026-07-29T15:10:00Z";

async function main() {
  const db = getDb();

  const { data: stale, error: staleErr } = await db
    .from("candidates")
    .select("id")
    .in("status", ["new", "shown"])
    .lt("created_at", STYLE_CUTOFF);
  if (staleErr) throw new Error(`чтение старых: ${staleErr.message}`);
  const staleIds = (stale ?? []).map((r) => r.id);

  if (staleIds.length) {
    const { error } = await db
      .from("candidates")
      .update({ status: "rejected" })
      .in("id", staleIds);
    if (error) throw new Error(`пометка старых: ${error.message}`);
  }
  console.log(`старый стиль (до ${STYLE_CUTOFF}): отклонено ${staleIds.length}`);

  const [restRes, seenRes] = await Promise.all([
    db.from("candidates").select("id, image_hash").in("status", ["new", "shown"]),
    db.from("seen_hashes").select("image_hash"),
  ]);
  if (restRes.error) throw new Error(`чтение резерва: ${restRes.error.message}`);
  if (seenRes.error) throw new Error(`чтение seen_hashes: ${seenRes.error.message}`);
  const seenHashes = (seenRes.data ?? []).map((r) => r.image_hash as string);

  const dupIds = (restRes.data ?? [])
    .filter((c) => seenHashes.some((h) => isDuplicate(h, c.image_hash as string)))
    .map((c) => c.id);
  if (dupIds.length) {
    const { error } = await db
      .from("candidates")
      .update({ status: "rejected" })
      .in("id", dupIds);
    if (error) throw new Error(`пометка дубликатов: ${error.message}`);
  }
  console.log(`дубликаты вышедшего: отклонено ${dupIds.length}`);
  console.log(`итого отклонено: ${staleIds.length + dupIds.length}`);
}

main().catch((err) => {
  console.error("чистка резерва упала:", err);
  process.exit(1);
});
