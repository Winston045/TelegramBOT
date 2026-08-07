import { Api } from "grammy";
import { env } from "./env.js";

let api: Api | undefined;

export function getTelegram(): Api {
  if (!api) api = new Api(env.botToken);
  return api;
}

export type InlineKeyboard = {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
};

/**
 * Шлёт фото по URL (изображения у себя не храним — SPEC).
 * Телеграм сам скачивает картинку; если она больше лимита или недоступна —
 * бросаем, вызывающий решает, что делать.
 */
export async function sendPhotoHtml(
  chatId: string | number,
  photoUrl: string,
  captionHtml: string,
  replyMarkup?: InlineKeyboard,
): Promise<number> {
  const msg = await getTelegram().sendPhoto(chatId, photoUrl, {
    caption: captionHtml,
    parse_mode: "HTML",
    reply_markup: replyMarkup,
  });
  return msg.message_id;
}

export async function sendMessageHtml(
  chatId: string | number,
  html: string,
): Promise<number> {
  const msg = await getTelegram().sendMessage(chatId, html, {
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
  });
  return msg.message_id;
}

/**
 * Ошибка отправки фото, означающая мёртвую ссылку у архива, а не временный
 * сбой Телеграма. Такого кандидата надо помечать браком, а не ретраить.
 */
export function isDeadImageError(message: string): boolean {
  return /failed to get http url content|wrong type of the web page content|wrong file identifier|photo_invalid/i.test(
    message,
  );
}

/**
 * Удаление сообщения без исключений: старше 48 часов Телеграм не отдаёт,
 * чужие без прав не удалить - для автоочистки это не ошибка.
 */
export async function tryDeleteMessage(
  chatId: string | number,
  messageId: number,
): Promise<boolean> {
  try {
    await getTelegram().deleteMessage(chatId, messageId);
    return true;
  } catch {
    return false;
  }
}
