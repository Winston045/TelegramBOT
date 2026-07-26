/**
 * Валидация подписи после генерации/правки.
 * Файл без импортов: используется и Node-скриптами, и Deno Edge Function.
 */

export const CAPTION_LIMIT = 1024; // лимит телеграма на подпись под фото

const ALLOWED_TAGS = new Set(["b", "i", "blockquote", "a"]);
const YEAR_RE = /\b(1[89]\d{2}|20\d{2})\b/g;

export type CaptionMeta = {
  title?: string;
  description?: string;
  year?: number;
  place?: string;
};

export type ValidationResult = { ok: true } | { ok: false; reason: string };

/** Видимый текст без тегов — лимит телеграма считается по нему. */
export function visibleLength(html: string): number {
  return html.replace(/<[^>]+>/g, "").length;
}

/** Только разрешённые теги, все закрыты, без вложенного мусора. */
export function validateHtml(html: string): ValidationResult {
  const stack: string[] = [];
  const tagRe = /<(\/?)([a-zA-Z0-9]+)((?:\s+[^<>]*?)?)>/g;
  let cursor = 0;

  for (const m of html.matchAll(tagRe)) {
    // '<' вне распознанного тега — битый HTML
    const between = html.slice(cursor, m.index);
    if (between.includes("<") || between.includes(">")) {
      return { ok: false, reason: "битый HTML: '<' или '>' вне тега" };
    }
    cursor = m.index + m[0].length;

    const closing = m[1] === "/";
    const tag = m[2]!.toLowerCase();
    const attrs = m[3] ?? "";

    if (!ALLOWED_TAGS.has(tag)) {
      return { ok: false, reason: `запрещённый тег <${tag}>` };
    }
    if (!closing && tag === "a" && !/^\s+href="[^"]+"$/.test(attrs)) {
      return { ok: false, reason: "у <a> допустим только href в кавычках" };
    }
    if (!closing && tag !== "a" && attrs.trim() !== "") {
      return { ok: false, reason: `атрибуты у <${tag}> запрещены` };
    }

    if (closing) {
      if (stack.pop() !== tag) {
        return { ok: false, reason: `незакрытый или лишний </${tag}>` };
      }
    } else {
      stack.push(tag);
    }
  }

  const tail = html.slice(cursor);
  if (tail.includes("<") || tail.includes(">")) {
    return { ok: false, reason: "битый HTML: '<' или '>' вне тега" };
  }
  if (stack.length > 0) {
    return { ok: false, reason: `незакрытый тег <${stack[stack.length - 1]}>` };
  }
  return { ok: true };
}

/**
 * Каждый год, упомянутый в подписи, должен присутствовать во входных
 * метаданных — иначе модель что-то выдумала.
 */
export function validateYears(html: string, meta: CaptionMeta): ValidationResult {
  const sourceText = `${meta.title ?? ""} ${meta.description ?? ""} ${meta.year ?? ""} ${meta.place ?? ""}`;
  const known = new Set([...sourceText.matchAll(YEAR_RE)].map((m) => m[0]));
  for (const m of html.replace(/<[^>]+>/g, " ").matchAll(YEAR_RE)) {
    if (!known.has(m[0])) {
      return { ok: false, reason: `год ${m[0]} отсутствует в метаданных` };
    }
  }
  return { ok: true };
}

export function validateCaption(captionHtml: string, meta: CaptionMeta): ValidationResult {
  if (visibleLength(captionHtml) > CAPTION_LIMIT) {
    return { ok: false, reason: `подпись длиннее ${CAPTION_LIMIT} символов` };
  }
  const htmlCheck = validateHtml(captionHtml);
  if (!htmlCheck.ok) return htmlCheck;
  return validateYears(captionHtml, meta);
}
