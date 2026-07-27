/**
 * Разовое восстановление подписей, случайно перезаписанных реплаями
 * (подписи взяты из логов сбора, где они были сгенерированы).
 * Обновляет базу и редактирует подписи уже опубликованных постов в канале.
 */
import { getDb } from "../src/db.js";
import { env } from "../src/env.js";
import { getTelegram } from "../src/telegram.js";

const FIXES: Array<{ id: number; caption: string }> = [
  {
    id: 13,
    caption:
      "<b>Солдаты</b> 2-го Род-Айлендского пехотного полка и военный оркестр во время построения в поле. <i>1861 год.</i>\n\n" +
      "<blockquote>Слева от шеренги пехоты выстроен оркестр с большим бас-барабаном, а на правом фланге стоят офицеры верхом на лошадях.</blockquote>\n\n" +
      '<a href="https://t.me/Story_Teams">STORY | TEAM</a>',
  },
  {
    id: 14,
    caption:
      "<b>Церемония открытия</b> мемориальной доски в память об американских участниках Первой мировой войны. <i>1921 год.</i>\n\n" +
      '<a href="https://t.me/Story_Teams">STORY | TEAM</a>',
  },
];

async function main() {
  const db = getDb();
  const api = getTelegram();

  for (const fix of FIXES) {
    const { data, error } = await db
      .from("candidates")
      .select("id, status, channel_msg_id")
      .eq("id", fix.id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) {
      console.log(`#${fix.id}: не найден, пропуск`);
      continue;
    }

    const { error: updErr } = await db
      .from("candidates")
      .update({ caption_html: fix.caption })
      .eq("id", fix.id);
    if (updErr) throw new Error(updErr.message);
    console.log(`#${fix.id}: подпись в базе восстановлена`);

    if (data.status === "published" && data.channel_msg_id) {
      await api.editMessageCaption(env.channelId, Number(data.channel_msg_id), {
        caption: fix.caption,
        parse_mode: "HTML",
      });
      console.log(`#${fix.id}: подпись поста в канале исправлена`);
    }
  }
}

main().catch((err) => {
  console.error("восстановление упало:", err);
  process.exit(1);
});
