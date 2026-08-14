import { Api, InputFile } from "grammy";
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
  const options = {
    caption: captionHtml,
    parse_mode: "HTML" as const,
    reply_markup: replyMarkup,
  };
  try {
    const msg = await getTelegram().sendPhoto(chatId, photoUrl, options);
    return msg.message_id;
  } catch (err) {
    const message = (err as Error).message;
    if (!isDeadImageError(message)) throw err;
    // Телеграм не смог скачать файл сам - это не всегда мёртвая ссылка:
    // архив может резать чужие качалки или отвечать слишком медленно
    // (живой случай 14.08: две карточки LOC подряд). Пробуем скачать
    // сами и отдать байтами. Файл нигде не сохраняем - только в памяти
    const buffer = await downloadImage(photoUrl);
    if (!buffer) throw err;
    console.warn(`  Телеграм не забрал ссылку сам, отправляю файлом: ${photoUrl}`);
    const msg = await getTelegram().sendPhoto(chatId, new InputFile(buffer), options);
    return msg.message_id;
  }
}

/** Скачивание картинки в память для повторной отправки файлом. */
async function downloadImage(url: string): Promise<Buffer | undefined> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(45_000),
      headers: {
        "user-agent":
          "story-team-bot/0.1 (Telegram history channel; contact via t.me/Story_Teams)",
        accept: "image/*",
      },
    });
    if (!res.ok) return undefined;
    const buffer = Buffer.from(await res.arrayBuffer());
    // лимит Телеграма на фото - 10 МБ; больше отдавать бессмысленно
    return buffer.length && buffer.length <= 10 * 1024 * 1024 ? buffer : undefined;
  } catch {
    return undefined;
  }
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
