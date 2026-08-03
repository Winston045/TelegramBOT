/**
 * Сброс суточного счётчика автодобора. Нужен, когда дневные заходы
 * сгорели впустую (бан архива, пустая квота) и предохранитель мешает
 * добрать уже на свежей квоте.
 */
import { getDb } from "../src/db.js";

async function main() {
  const { error } = await getDb().from("settings").delete().eq("key", "topup_runs");
  if (error) throw new Error(error.message);
  console.log("счётчик автодобора сброшен");
}

main().catch((err) => {
  console.error("reset-topup упал:", err);
  process.exit(1);
});
