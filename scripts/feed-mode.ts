/**
 * Режим сетки рубрик в settings.feed_mode: on - выбирает сетка, shadow -
 * выбирает старый планировщик, сетка пишет в лог, off - выключена.
 *   npx tsx scripts/feed-mode.ts on|shadow|off
 */
import { getDb } from "../src/db.js";

async function main() {
  const mode = process.argv[2];
  if (mode !== "on" && mode !== "shadow" && mode !== "off") throw new Error("режим: on | shadow | off");
  const db = getDb();
  const { error } = await db
    .from("settings")
    .upsert({ key: "feed_mode", value: mode, updated_at: new Date().toISOString() });
  if (error) throw new Error(error.message);
  console.log(`feed_mode = ${mode}`);
}

main().catch((err) => {
  console.error("режим сетки не записан:", err);
  process.exit(1);
});
