import { Api } from "grammy";
import { env } from "./env.js";

let api: Api | undefined;

export function getTelegram(): Api {
  if (!api) api = new Api(env.botToken);
  return api;
}

/**
 * Шлёт фото по URL (изображения у себя не храним — SPEC).
 * Телеграм сам скачивает картинку; если она больше лимита или недоступна —
 * бросаем, вызывающий решает, что делать.
 */
export async function sendPhotoHtml(
  chatId: string | number,
  photoUrl: string,
  captionHtml: string,
): Promise<number> {
  const msg = await getTelegram().sendPhoto(chatId, photoUrl, {
    caption: captionHtml,
    parse_mode: "HTML",
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
