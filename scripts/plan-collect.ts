/**
 * Планировщик дневного сбора: считает, сколько фото брать на анализ,
 * чтобы держать запас на несколько дней и не копить лишнего.
 *
 * Пишет в $GITHUB_OUTPUT: need=true|false и keep=<число>.
 * Сбой планировщика не должен оставить канал без свежего материала,
 * поэтому при ошибке возвращаемся к обычному размеру партии из config.
 */
import { appendFileSync } from "node:fs";
import { loadConfig } from "../src/config.js";
import { planReserve } from "../src/reserve.js";

function emit(need: boolean, keep: number, reason: string) {
  console.log(`${need ? `собираем ${keep}` : "сбор не нужен"}: ${reason}`);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `need=${need}\nkeep=${keep}\n`);
  }
}

async function main() {
  const cfg = loadConfig();
  const plan = await planReserve(cfg);
  if (plan.keep === 0) {
    emit(false, 0, `готовых ${plan.available} при запасе ${plan.target} - хватает`);
    return;
  }
  emit(true, plan.keep, `готовых ${plan.available} при запасе ${plan.target}`);
}

main().catch((err) => {
  console.error("планировщик сбора упал:", err);
  const fallback = loadConfig().collect.prefilter_keep;
  emit(true, fallback, "планировщик недоступен - обычная партия");
});
