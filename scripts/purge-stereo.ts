/**
 * Одноразовая чистка резерва от стереокарточек: скачивает фото каждого
 * готового кандидата и прогоняет через детектор стереопар. Найденные
 * помечаются rejected - в канал они не пойдут.
 */
import { getDb } from "../src/db.js";
import { isStereoPair } from "../src/stereo.js";

async function main() {
  const db = getDb();
  const { data, error } = await db
    .from("candidates")
    .select("id, image_url, raw_title, raw_desc")
    .in("status", ["new", "shown", "approved"]);
  if (error) throw new Error(error.message);

  let rejected = 0;
  for (const c of data ?? []) {
    const text = `${c.raw_title ?? ""} ${c.raw_desc ?? ""}`.toLowerCase();
    let stereo = /stereograph|stereoscop|stereo card|stereo view/.test(text);
    if (!stereo) {
      try {
        const res = await fetch(c.image_url, {
          headers: { "user-agent": "story-team-bot/0.1 (contentbot)" },
          signal: AbortSignal.timeout(60_000),
        });
        if (!res.ok) continue;
        stereo = await isStereoPair(Buffer.from(await res.arrayBuffer()));
      } catch {
        continue;
      }
    }
    if (stereo) {
      await db.from("candidates").update({ status: "rejected" }).eq("id", c.id);
      console.log(`  стереопара: #${c.id} ${(c.raw_title ?? "").slice(0, 60)}`);
      rejected++;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  console.log(`отклонено стереокарточек: ${rejected} из ${data?.length ?? 0} проверенных`);
}

main().catch((err) => {
  console.error("purge-stereo упал:", err);
  process.exit(1);
});
