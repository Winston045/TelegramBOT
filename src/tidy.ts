/**
 * Автоочистка чата редакторов со стороны кронов.
 *
 * Вебхук помечает служебные сообщения временем смерти (таблица
 * chat_cleanup), а публикатор - он и так просыпается каждые 15 минут -
 * удаляет созревшие. Скрипты тоже помечают свои подтверждения через
 * rememberEphemeral, если автоочистка включена (/tidy в боте).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { tryDeleteMessage } from "./telegram.js";

const SETTING_KEY = "chat_ttl_hours";
/** По умолчанию служебное живёт 6 часов; 0 = автоочистка выключена. */
export const DEFAULT_TTL_HOURS = 6;

export async function loadTtlHours(db: SupabaseClient): Promise<number> {
  const { data, error } = await db
    .from("settings")
    .select("value")
    .eq("key", SETTING_KEY)
    .maybeSingle();
  if (error || !data) return DEFAULT_TTL_HOURS;
  const n = Number(data.value);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_TTL_HOURS;
}

/** Пометить сообщение на удаление, если автоочистка включена. */
export async function rememberEphemeral(
  db: SupabaseClient,
  chatId: string | number,
  messageId: number,
): Promise<void> {
  const ttl = await loadTtlHours(db);
  if (!ttl) return;
  await db.from("chat_cleanup").upsert({
    chat_id: Number(chatId),
    message_id: messageId,
    delete_after: new Date(Date.now() + ttl * 3600_000).toISOString(),
  });
}

/** Удалить созревшие сообщения. Возвращает, сколько убрано. */
export async function cleanupChat(db: SupabaseClient): Promise<number> {
  const { data, error } = await db
    .from("chat_cleanup")
    .select("chat_id, message_id")
    .lte("delete_after", new Date().toISOString())
    .limit(100);
  if (error || !data?.length) return 0;

  let deleted = 0;
  for (const row of data) {
    if (await tryDeleteMessage(row.chat_id, row.message_id)) deleted++;
    // запись убираем в любом случае: недоступное сообщение (старше 48 ч,
    // нет прав) не должно застревать в очереди навсегда
    await db
      .from("chat_cleanup")
      .delete()
      .eq("chat_id", row.chat_id)
      .eq("message_id", row.message_id);
  }
  return deleted;
}
