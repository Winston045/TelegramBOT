/**
 * Одноразовая чистка резерва от перекоса в раннюю эпоху: ротация лет
 * несколько прогонов подряд сидела в 1916-1918, и резерв стал сплошной
 * ПМВ. Отклоняем готовые кандидаты старше 1939 года - свежий сбор
 * наполнит резерв по перемешанной ротации.
 *
 * Одобренное редактором не трогаем: его выбирали глазами.
 */
import { getDb } from "../src/db.js";

const OLD_PERIODS = new Set([
  "pre_ww1",
  "WW1",
  "russian_civil_war",
  "interwar",
  "spanish_civil_war",
]);

async function main() {
  const db = getDb();
  const { data, error } = await db
    .from("candidates")
    .select("id, year, tags")
    .in("status", ["new", "shown"]);
  if (error) throw new Error(error.message);

  const old = (data ?? []).filter((c) => {
    const period = (c.tags as { period?: string } | null)?.period;
    return (period && OLD_PERIODS.has(period)) || (c.year != null && c.year < 1939);
  });

  for (const c of old) {
    await db.from("candidates").update({ status: "rejected" }).eq("id", c.id);
    console.log(`  отклонён #${c.id} (год ${c.year ?? "?"})`);
  }
  console.log(`отклонено ранней эпохи: ${old.length} из ${data?.length ?? 0} готовых`);
}

main().catch((err) => {
  console.error("purge-old-era упал:", err);
  process.exit(1);
});
