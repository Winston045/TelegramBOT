import type { AppConfig } from "./config.js";
import type { RawItem } from "./sources/types.js";
import { geminiJson, imagePart } from "./gemini.js";

export type GeneratedCaption = {
  caption: string; // "<b>Подлежащее</b> описание. <i>1945 год.</i>"
  quote: string;
  quote_kind: "observation" | "context";
};

const FEW_SHOT = `Примеры эталонного стиля (регистр речи держать такой же):

Пример 1:
caption: <b>Солдаты-мусульмане</b> Российской императорской армии на утренней молитве. <i>1915 год.</i>
quote: По разным данным, общая численность мусульман в армии Российской империи во время Первой мировой войны составляла от 800 тысяч до 1,5 млн человек.
quote_kind: context

Пример 2:
caption: <b>Танкисты</b> 61-й гвардейской Свердловской танковой бригады у танка Т-34-85 № 3-716 с личным именем «Партизан». <i>1945 год.</i>
quote: Надпись на стволе пушки — «Победа за нами». У машины отсутствует третий каток ходовой части.
quote_kind: observation`;

export function buildCaptionPrompt(item: RawItem, glossary: Record<string, string>): string {
  const glossaryLines = Object.entries(glossary)
    .map(([from, to]) => `  "${from}" → "${to}"`)
    .join("\n");

  return `Ты готовишь подпись к исторической фотографии для русскоязычного телеграм-канала.

Исходные метаданные (язык: ${item.lang}):
- заголовок: ${item.title ?? "(нет)"}
- описание: ${item.description ?? "(нет)"}
- год: ${item.year ?? "(нет)"}
- место: ${item.place ?? "(нет)"}

Жёсткие правила:
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
6. quote — одна дополнительная деталь. Если она видна на самом фото —
   quote_kind: "observation". Если это внешний контекст из метаданных —
   quote_kind: "context". В quote тегов нет.

${FEW_SHOT}

Верни строго JSON без обёрток и без markdown:
{"caption": "...", "quote": "...", "quote_kind": "observation" | "context"}`;
}

export async function generateCaption(
  item: RawItem,
  cfg: AppConfig,
  image?: Buffer,
): Promise<GeneratedCaption> {
  const img = await imagePart(image ?? item.imageUrl);
  return geminiJson<GeneratedCaption>([
    { text: buildCaptionPrompt(item, cfg.glossary) },
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
  const parts = [generated.caption];
  if (generated.quote) parts.push(`<blockquote>${generated.quote}</blockquote>`);
  const footer: string[] = [];
  if (item.attribution && needsAttribution(item.license)) {
    footer.push(item.attribution);
  }
  footer.push(`<a href="${channel.signature_url}">${channel.signature}</a>`);
  parts.push(footer.join("\n"));
  return parts.join("\n\n");
}
