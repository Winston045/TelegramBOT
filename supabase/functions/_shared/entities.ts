/**
 * Конвертация телеграмного форматирования (message.entities) в HTML один в один.
 * Редакторы не пишут теги руками — жирный/курсив/цитата/ссылка приходят
 * сущностями, всё остальное форматирование опускается до простого текста.
 *
 * Файл без импортов: используется и Node-скриптами, и Deno Edge Function.
 */

export type MessageEntity = {
  type: string;
  offset: number; // в UTF-16 code units — совпадает с индексами строк JS
  length: number;
  url?: string;
};

const TAG_BY_TYPE: Record<string, string> = {
  bold: "b",
  italic: "i",
  blockquote: "blockquote",
  expandable_blockquote: "blockquote",
};

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function entitiesToHtml(text: string, entities: MessageEntity[] = []): string {
  const supported = entities
    .filter((e) => TAG_BY_TYPE[e.type] || (e.type === "text_link" && e.url))
    .sort((a, b) => a.offset - b.offset || b.length - a.length);

  function render(start: number, end: number, ents: MessageEntity[]): string {
    let out = "";
    let cursor = start;
    let i = 0;
    while (i < ents.length) {
      const e = ents[i]!;
      if (e.offset < cursor) {
        // пересечение без вложенности — телеграм такого не шлёт, пропускаем
        i++;
        continue;
      }
      out += escapeHtml(text.slice(cursor, e.offset));
      const entEnd = e.offset + e.length;

      // сущности, целиком вложенные в текущую
      const inner: MessageEntity[] = [];
      let j = i + 1;
      while (j < ents.length && ents[j]!.offset < entEnd) {
        if (ents[j]!.offset + ents[j]!.length <= entEnd) inner.push(ents[j]!);
        j++;
      }

      const content = render(e.offset, entEnd, inner);
      if (e.type === "text_link") {
        out += `<a href="${escapeHtml(e.url!)}">${content}</a>`;
      } else {
        const tag = TAG_BY_TYPE[e.type]!;
        out += `<${tag}>${content}</${tag}>`;
      }

      cursor = entEnd;
      i = j;
    }
    out += escapeHtml(text.slice(cursor, end));
    return out;
  }

  return render(0, text.length, supported);
}
