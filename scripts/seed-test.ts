/**
 * Мини-тест без Gemini: берём кандидата, уже собранного из LOC
 * (Окленд, Куин-стрит, 1890 — карточка https://www.loc.gov/item/2017657811/),
 * и вручную даём ему подпись, составленную строго из метаданных карточки.
 * Кандидат переводится в status='new' и готов к отправке редакторам.
 */
import { loadConfig } from "../src/config.js";
import { getDb } from "../src/db.js";
import { assembleCaptionHtml } from "../src/caption.js";
import { validateCaption } from "../src/validate.js";

const SOURCE = "loc";
const SOURCE_ID = "2017657811";

async function main() {
  const cfg = loadConfig();

  const generated = {
    caption: "<b>Куин-стрит</b> — главная улица Окленда, Новая Зеландия. <i>1890 год.</i>",
    quote:
      "Снимок выполнен в технике фотохрома: цвет наносился литографией поверх чёрно-белого негатива.",
    quote_kind: "context" as const,
  };
  const captionHtml = assembleCaptionHtml(generated, { license: "PD" }, cfg.channel);

  const check = validateCaption(captionHtml, {
    title: "Auckland, Queen Street",
    description: "1 print : color photochrom",
    year: 1890,
    place: "queen street",
  });
  if (!check.ok) throw new Error(`подпись не прошла валидацию: ${check.reason}`);

  const db = getDb();
  const { data, error } = await db
    .from("candidates")
    .update({ caption_html: captionHtml, quote_kind: generated.quote_kind, status: "new" })
    .eq("source", SOURCE)
    .eq("source_id", SOURCE_ID)
    .select("id");
  if (error) throw new Error(error.message);
  if (!data.length) {
    throw new Error(
      `кандидата ${SOURCE}/${SOURCE_ID} нет в базе — сначала сбор (verify/collect)`,
    );
  }

  console.log(`тестовый кандидат #${data[0]!.id} готов к отправке:\n\n${captionHtml}`);
}

main().catch((err) => {
  console.error("seed-test упал:", err);
  process.exit(1);
});
