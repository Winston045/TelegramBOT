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
  /**
   * Дополнительный документальный контекст (полное описание с карточки
   * архива, справка из Википедии) - тот же легальный источник фактов,
   * что и метаданные. Без него валидатор браковал изюминки с датой из
   * справки: промпт разрешал «факты строго из метаданных И контекста»,
   * а проверка лет знала только метаданные.
   */
  context?: string;
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
    if (!closing && tag === "blockquote" && attrs.trim() !== "" && attrs.trim() !== "expandable") {
      return { ok: false, reason: "у <blockquote> допустим только expandable" };
    }
    if (!closing && tag !== "a" && tag !== "blockquote" && attrs.trim() !== "") {
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
 * Шифр единицы хранения: три и больше групп через дефис - «Bild
 * 183-1985-0110-500», «LC-USZ62-12345». Цифры внутри шифра - не год
 * снимка: у Бундесархива «1985» там - год регистрации негатива, а сам
 * кадр сорок второго. Шифром считаем только цепочку хотя бы с двумя
 * числовыми группами: «Juni-Juli-1944» - это слова, а не шифр. Дата
 * вида 1944-06-06 или 06-12-1944 - тоже не шифр, её оставляем.
 */
const CATALOG_ID_RE = /[A-Za-z0-9]+(?:-[A-Za-z0-9]+){2,}/g;

function isCatalogId(token: string): boolean {
  const groups = token.split("-");
  const numeric = groups.filter((g) => /\d/.test(g));
  if (numeric.length < 2) return false;
  const isDate =
    groups.every((g) => /^\d+$/.test(g)) &&
    groups.filter((g) => g.length === 4).length === 1 &&
    groups.every((g) => g.length === 4 || g.length <= 2);
  return !isDate;
}

/** Годы, которые метаданные действительно называют. */
export function knownYears(sourceText: string): Set<string> {
  const text = sourceText.replace(CATALOG_ID_RE, (id) => (isCatalogId(id) ? " " : id));
  // год может быть частью "1930s", "1930-е", "30.12.1939", поэтому \b не
  // годится; но и цифрами внутри длинного номера («NARA 519838») он быть
  // не должен - иначе любой номер описи «подтверждал» случайный год
  return new Set([...text.matchAll(/(?<!\d)(1[89]\d{2}|20\d{2})(?!\d)/g)].map((m) => m[0]));
}

/**
 * Каждый год, упомянутый в подписи, должен присутствовать во входных
 * метаданных — иначе модель что-то выдумала.
 */
export function validateYears(html: string, meta: CaptionMeta): ValidationResult {
  const sourceText = `${meta.title ?? ""} ${meta.description ?? ""} ${meta.year ?? ""} ${meta.place ?? ""} ${meta.context ?? ""}`;
  const known = knownYears(sourceText);
  for (const m of html.replace(/<[^>]+>/g, " ").matchAll(YEAR_RE)) {
    if (!known.has(m[0])) {
      return { ok: false, reason: `год ${m[0]} отсутствует в метаданных` };
    }
  }
  return { ok: true };
}

/** Цифры подряд, с разделителями разрядов и дробей склеенными: «1 600» → 1600, «4,5» → 45. */
function numberTokens(text: string): string[] {
  return [...text.replace(/(\d)[\s\u00a0.,](?=\d)/g, "$1").matchAll(/\d{2,}/g)].map((m) => m[0]);
}

/**
 * Числа изюминки, которых нет в источниках: метаданных и справках.
 * Годы не считаем - их держит validateYears. Прогон 22.10: облегчённая
 * модель без справки дописала ИСУ-152 вес «сорок шесть тонн» - число
 * верное, но взято из головы модели, а правило канала - только из
 * источников. Числа словами эта проверка не видит; цифрами - да.
 */
export function unsupportedNumbers(text: string, sources: string): string[] {
  const known = new Set(numberTokens(sources));
  return numberTokens(text).filter((n) => !/^(1[89]\d{2}|20\d{2})$/.test(n) && !known.has(n));
}

/**
 * Видимый текст тела поста - без цитат и без футера с подписью канала.
 * Пустое тело - пост из одной цитаты и ссылки, такого в канале не бывает.
 */
export function bodyText(captionHtml: string): string {
  const idx = captionHtml.lastIndexOf("\n\n");
  const body =
    idx !== -1 && captionHtml.slice(idx).includes("<a href=") ? captionHtml.slice(0, idx) : captionHtml;
  return body
    .replace(/<blockquote[^>]*>[\s\S]*?<\/blockquote>/g, "")
    .replace(/<[^>]+>/g, "")
    .trim();
}

export function validateCaption(captionHtml: string, meta: CaptionMeta): ValidationResult {
  if (visibleLength(captionHtml) > CAPTION_LIMIT) {
    return { ok: false, reason: `подпись длиннее ${CAPTION_LIMIT} символов` };
  }
  if (!bodyText(captionHtml)) return { ok: false, reason: "у поста нет текста - только цитата" };
  const htmlCheck = validateHtml(captionHtml);
  if (!htmlCheck.ok) return htmlCheck;
  return validateYears(captionHtml, meta);
}
