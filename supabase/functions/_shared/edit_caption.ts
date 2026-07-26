/**
 * Правки подписи от редакторов: замена цитаты или всего тела поста.
 * Футер (атрибуция + подпись канала) всегда сохраняется как есть.
 *
 * Файл без импортов: используется и Node-скриптами, и Deno Edge Function.
 */

function escape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Футер — последний блок подписи (после \n\n), содержащий ссылку-подпись
 * канала; строка атрибуции живёт в том же блоке строкой выше.
 */
export function splitFooter(captionHtml: string): { body: string; footer: string } {
  const idx = captionHtml.lastIndexOf("\n\n");
  if (idx !== -1 && captionHtml.slice(idx).includes("<a href=")) {
    return { body: captionHtml.slice(0, idx), footer: captionHtml.slice(idx + 2) };
  }
  return { body: captionHtml, footer: "" };
}

/** /quote <текст> — заменить только цитату (текст приходит без тегов). */
export function replaceQuote(captionHtml: string, newQuote: string): string {
  const { body, footer } = splitFooter(captionHtml);
  const quoteHtml = `<blockquote>${escape(newQuote.trim())}</blockquote>`;

  const replaced = /<blockquote>[\s\S]*?<\/blockquote>/.test(body)
    ? body.replace(/<blockquote>[\s\S]*?<\/blockquote>/, quoteHtml)
    : `${body}\n\n${quoteHtml}`;

  return footer ? `${replaced}\n\n${footer}` : replaced;
}

/** Реплай текстом — заменить подпись целиком (кроме футера). */
export function replaceBody(captionHtml: string, newBodyHtml: string): string {
  const { footer } = splitFooter(captionHtml);
  return footer ? `${newBodyHtml.trim()}\n\n${footer}` : newBodyHtml.trim();
}
