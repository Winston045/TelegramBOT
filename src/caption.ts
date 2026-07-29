import type { AppConfig } from "./config.js";
import type { RawItem } from "./sources/types.js";
import { geminiJson, imagePart } from "./gemini.js";

export type GeneratedCaption = {
  caption: string; // "<b>Подлежащее</b> описание. <i>1945 год.</i>"
  quote: string;
  quote_kind: "observation" | "context";
};

// настоящие посты канала, дословно: модель копирует их тон и структуру
export const FEW_SHOT = `Примеры - НАСТОЯЩИЕ посты канала, копируй их тон и структуру:

Пример 1 (факта нет - место и дата уходят в quote):
caption: Старший сержант Юрий Никулин с однополчанами из 72-го отдельного зенитного дивизиона.
quote: СССР, 1943 год.
quote_kind: context

Пример 2 (есть интересный факт - дата в теле, факт в quote):
caption: Дети используют салют Беллами во время ритуала произнесения клятвы верности флагу США. Коннектикут, 1942 год.
quote: Спустя год ритуал был изменён из-за сходства с нацистским приветствием.
quote_kind: context

Пример 3 (техника, факта нет):
caption: Британский тягач «Scammell Pioneer» перевозит танк «Crusader» по Каирской пустыне.
quote: 1943 год.
quote_kind: context

Пример 4 (драматичный кадр, факта нет):
caption: Турок омывает ноги для последней молитвы, в то время как болгарские солдаты готовят для него виселицу.
quote: 1913 год.
quote_kind: observation

Пример 5 (без факта, с фронтом и датой):
caption: Расстрелявший немецкую танковую колонну советский танк КВ-1С и его погибший танкист.
quote: Воронежский фронт. Февраль 1943 года.
quote_kind: context`;

/** Блок метаданных снимка — общий для промптов подписи и анализа. */
export function metadataBlock(item: RawItem, extraContext?: string): string {
  const extra = extraContext
    ? `\nПолное описание со страницы архива (тоже источник фактов, за его пределы не выходить):\n${extraContext}\n`
    : "";
  return `Исходные метаданные (язык: ${item.lang}):
- заголовок: ${item.title ?? "(нет)"}
- описание: ${item.description ?? "(нет)"}
- год: ${item.year ?? "(нет)"}
- место: ${item.place ?? "(нет)"}
${extra}`;
}

/** Жёсткие правила подписи — общий блок для промптов подписи и анализа. */
export function captionRules(item: RawItem, glossary: Record<string, string>): string {
  const glossaryLines = Object.entries(glossary)
    .map(([from, to]) => `  "${from}" → "${to}"`)
    .join("\n");
  return `Жёсткие правила подписи:
1. НЕ ДОБАВЛЯЙ фактов, которых нет во входных данных или не видно на самом фото.
   Нет точной даты — пиши «начало 1943», а не выдумывай число.
2. Топонимы — в названии, актуальном на дату снимка.
3. Глоссарий соблюдать дословно:
${glossaryLines || "  (пусто)"}
4. Исходные описания могут быть пропагандистскими, ошибочными или предвзятыми —
   перепиши нейтрально, оценочные формулировки убери.
5. Формат caption: одно-два ёмких предложения ПРОСТЫМ ТЕКСТОМ.
   Без HTML-тегов, без жирного, без курсива, без markdown.
6. quote обязателен, два варианта — как в канале:
   а) есть ПО-НАСТОЯЩЕМУ интересный факт (судьба людей или техники,
      цифры, контекст события, редкость момента) — тогда место и дата
      идут В КОНЦЕ caption («... Коннектикут, 1942 год.»), а quote — сам
      факт. Если факт виден на фото — quote_kind: "observation", если
      из метаданных — "context".
   б) факта нет — в caption дату НЕ писать, quote — только место и дата:
      «СССР, 1943 год.» или «Воронежский фронт. Февраль 1943 года.»,
      quote_kind: "context".
   КАТЕГОРИЧЕСКИ ЗАПРЕЩЕНО выдавать за интересный факт:
   - опись видимого («на заднем плане...», «слева виден...») без
     объяснения, ЧЕМ это важно или необычно;
   - пересказ caption другими словами;
   - технические сведения о негативе, съёмке, архиве.
   Сомневаешься, интересен ли факт, — выбирай вариант (б).`;
}

export function buildCaptionPrompt(
  item: RawItem,
  glossary: Record<string, string>,
  extraContext?: string,
): string {
  return `Ты готовишь подпись к исторической фотографии для русскоязычного телеграм-канала.

${metadataBlock(item, extraContext)}
${captionRules(item, glossary)}

${FEW_SHOT}

Верни строго JSON без обёрток и без markdown:
{"caption": "...", "quote": "...", "quote_kind": "observation" | "context"}`;
}

export async function generateCaption(
  item: RawItem,
  cfg: AppConfig,
  image?: Buffer,
  extraContext?: string,
): Promise<GeneratedCaption> {
  const img = await imagePart(image ?? item.imageUrl);
  return geminiJson<GeneratedCaption>([
    { text: buildCaptionPrompt(item, cfg.glossary, extraContext) },
    img,
  ]);
}

/** Требует ли лицензия строку атрибуции. PD — нет, CC-BY-* — да. */
export function needsAttribution(license: string): boolean {
  return /cc[- ]by/i.test(license);
}

/** Собирает финальный caption_html: подпись + цитата + атрибуция + подпись канала. */
export function assembleCaptionHtml(
  generated: GeneratedCaption,
  item: Pick<RawItem, "license" | "attribution">,
  channel: AppConfig["channel"],
): string {
  // цитата прижата к тексту без пустой строки — так в канале компактнее;
  // единственный двойной перенос остаётся перед футером (его ищет splitFooter)
  let body = generated.caption;
  if (generated.quote) body += `\n<blockquote>${generated.quote}</blockquote>`;
  const footer: string[] = [];
  if (item.attribution && needsAttribution(item.license)) {
    footer.push(item.attribution);
  }
  footer.push(`<a href="${channel.signature_url}">${channel.signature}</a>`);
  return `${body}\n\n${footer.join("\n")}`;
}
