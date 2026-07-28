import type { AppConfig } from "./config.js";
import type { RawItem } from "./sources/types.js";
import { geminiJson, imagePart } from "./gemini.js";

export type GeneratedCaption = {
  caption: string; // "<b>Подлежащее</b> описание. <i>1945 год.</i>"
  quote: string;
  quote_kind: "observation" | "context";
};

export const FEW_SHOT = `Примеры эталонного стиля (регистр речи держать такой же):

Пример 1:
caption: <b>Солдаты-мусульмане</b> Российской императорской армии на утренней молитве. <i>1915 год.</i>
quote: По разным данным, общая численность мусульман в армии Российской империи во время Первой мировой войны составляла от 800 тысяч до 1,5 млн человек.
quote_kind: context

Пример 2:
caption: <b>Танкисты</b> 61-й гвардейской Свердловской танковой бригады у танка Т-34-85 № 3-716 с личным именем «Партизан». <i>1945 год.</i>
quote: Надпись на стволе пушки — «Победа за нами». У машины отсутствует третий каток ходовой части.
quote_kind: observation`;

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
5. Формат caption: жирным (<b>) — только подлежащее, одно-два слова.
   Год курсивом (<i>) в конце: «<i>${item.year} год.</i>».
   Разрешённые теги: <b>, <i>. Никакого markdown.
6. quote — это мини-справка для человека, который ЛЮБИТ ИСТОРИЮ и
   хочет узнать что-то новое: судьба людей или техники, цифры, контекст
   события, редкость момента, значение детали. Если из фото — quote_kind:
   "observation", если из метаданных — "context". В quote тегов нет.
   КАТЕГОРИЧЕСКИ ЗАПРЕЩЕНО в quote:
   - опись видимого («на заднем плане...», «слева виден...», «на фото
     изображено...») без объяснения, ЧЕМ это важно или необычно;
   - пересказ caption другими словами;
   - технические сведения о негативе, съёмке, архиве.
   Правило простое: если цитата не учит читателя ничему новому —
   верни quote: "" (пустую строку). Пост без цитаты лучше поста с пустой.`;
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
