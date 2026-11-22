/**
 * Страховка изюминки от выдуманных чисел - общая для сбора и
 * предпросмотра, чтобы предпросмотр показывал ровно то, что уйдёт в базу.
 */
import { FEW_SHOT, type GeneratedCaption } from "./caption.js";
import { unsupportedNumbers } from "./validate.js";

export type NumbersVerdict = {
  caption: GeneratedCaption;
  /** что случилось: ok, правка редактора отклонена или изюминка снята */
  outcome: "ok" | "editor_rejected" | "quote_dropped";
  /** числа, которых нет в источниках */
  bad: string[];
};

/**
 * Отклонённая правка цитаты откатывает ТОЛЬКО цитату: текст поста мог
 * быть исправлен редактором по правилу ЛЮДИ (пояснил, кто назван), и эта
 * правка проверена отдельно (acceptBody).
 */
function firstPassQuote(reviewed: GeneratedCaption, firstPass: GeneratedCaption): GeneratedCaption {
  return {
    ...reviewed,
    quote: firstPass.quote,
    quote_place: firstPass.quote_place,
    quote_kind: firstPass.quote_kind,
  };
}

/**
 * Числа изюминки должны быть в источниках. Не прошла правка редактора -
 * берём версию первого захода; не прошла и она - пост обычный, с местом
 * и годом: лучше без изюминки, чем с выдумкой.
 */
export function guardNumbers(
  reviewed: { caption: GeneratedCaption; rewritten: boolean },
  firstPass: GeneratedCaption,
  sources: string,
): NumbersVerdict {
  const bad = unsupportedNumbers(reviewed.caption.quote, sources);
  if (!bad.length) return { caption: reviewed.caption, outcome: "ok", bad };
  if (reviewed.rewritten && !unsupportedNumbers(firstPass.quote, sources).length) {
    return { caption: firstPassQuote(reviewed.caption, firstPass), outcome: "editor_rejected", bad };
  }
  return {
    caption: {
      ...reviewed.caption,
      quote: reviewed.caption.quote_place ?? "",
      quote_place: undefined,
      quote_kind: "context",
    },
    outcome: "quote_dropped",
    bad,
  };
}

/** Слова без пунктуации и регистра - для сравнения текстов по смыслу фраз. */
function words(text: string): string[] {
  return text.toLowerCase().replace(/ё/g, "е").split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

function shingles(text: string, n = 5): Set<string> {
  const w = words(text);
  const out = new Set<string>();
  for (let i = 0; i + n <= w.length; i++) out.add(w.slice(i, i + n).join(" "));
  return out;
}

/** Цитаты примеров из промпта - образец подачи, не источник. */
const EXAMPLE_QUOTES: Set<string>[] = FEW_SHOT.split("\n")
  .filter((l) => l.startsWith("quote: "))
  .map((l) => shingles(l.slice("quote: ".length)));

/**
 * Списана ли цитата с примера из промпта. Предпросмотр 22.10: облегчённая
 * модель вопреки прямому запрету почти дословно переписала пример про
 * «Кэмпбелтаун» в подпись того же кадра. Три общие пятёрки слов подряд -
 * это уже не совпадение формулировки, а копия.
 */
export function copiesExample(quote: string): boolean {
  const mine = shingles(quote);
  if (!mine.size) return false;
  return EXAMPLE_QUOTES.some((ex) => {
    let shared = 0;
    for (const s of mine) if (ex.has(s)) shared++;
    return shared >= 3;
  });
}

/**
 * Страховка от копии примера: правка редактора - копия, а первый заход
 * нет - берём первый заход; копия и он - пост обычный, с местом и годом.
 */
export function guardCopies(
  reviewed: { caption: GeneratedCaption; rewritten: boolean },
  firstPass: GeneratedCaption,
): NumbersVerdict {
  if (!copiesExample(reviewed.caption.quote)) return { caption: reviewed.caption, outcome: "ok", bad: [] };
  if (reviewed.rewritten && !copiesExample(firstPass.quote)) {
    return { caption: firstPassQuote(reviewed.caption, firstPass), outcome: "editor_rejected", bad: ["копия примера"] };
  }
  return {
    caption: {
      ...reviewed.caption,
      quote: reviewed.caption.quote_place ?? "",
      quote_place: undefined,
      quote_kind: "context",
    },
    outcome: "quote_dropped",
    bad: ["копия примера"],
  };
}

/**
 * Штампы пересказа энциклопедии: оценка вместо истории. Промпт подписи и
 * редактор их запрещают (правило 8), а это страховка на случай, если
 * модель всё же их пропустила: изюминка без поворота хуже обычного поста.
 * Живой брак 11.2026: «стала становым хребтом британской артиллерии»,
 * «эксперты считают её одной из лучших», «рабочая лошадка люфтваффе».
 */
const CLICHE =
  /эксперты (считают|называют|полагают)|одн(ой|им|а|у|ою) из (самых )?лучших|рабоч(ей|ая|ую|ими?) лошадк|превосход(ил|ила|ило|или) (своих )?(основных )?(конкурентов|аналог)|активно использовал|сыграл[аои]? (важную|ключевую|огромную|значительную) роль|стал[аои]? (настоящим )?символом|становы[мй] хребт|применял(ся|ась|ось|ись) не только для|использовал(ся|ась|ось|ись) не только для|(тяжелее|легче|мощнее|быстрее|точнее|дальнобойнее)[^.]{0,40}аналог/i;

/** Какой штамп нашёлся в цитате - для лога; undefined - чисто. */
export function clicheIn(quote: string): string | undefined {
  return quote.match(CLICHE)?.[0];
}

/** Изюминка-штамп: правка редактора уступает первому заходу, штамп первого захода снимается. */
/**
 * Общеизвестное (редакция 22.11): «под постом с Красной армией в Берлине -
 * тяжелейший бой, взяли Берлин, 9 мая. Это очевидно, никому не интересно,
 * аудитория продвинутая». Изюминка с фактом из школьного учебника о
 * знаменитом событии - брак, как и штамп: она снимается, остаётся место
 * и дата. Список - самые затёртые факты; тоньше ловит промпт.
 */
const BANAL = new RegExp(
  [
    "(?:взял[аи]?|взяти[еяю]|овладел\\S*|штурмом взял\\S*|пад(?:ение|ения)|пал(?!\\p{L}))[^.]{0,40}Берлин",
    "Берлин[^.]{0,40}(?:был[аи]? )?(?:взят|пал)",
    "Знам\\S* Победы[^.]{0,60}Рейхстаг|Рейхстаг[^.]{0,60}Знам\\S* Победы",
    "капитуляци\\S* (?:нацистской |фашистской |гитлеровской )?Германии",
    "(?:8|9) мая 1945",
    "День Победы",
    "22 июня 1941",
    "коренн\\S* перелом|переломн\\S* (?:момент|этап|сражени|битв)|перелом\\S* в (?:ходе )?(?:войн|Великой)",
    "крупнейш\\S* танков\\S* (?:сражени|битв)",
    "крупнейш\\S* (?:морск\\S* )?десантн\\S* операци",
    "открыти\\S* втор\\S* фронт|открыл\\S* втор\\S* фронт",
    "872 дн",
    "(?:Великая Отечественная|Вторая мировая)(?: война)? (?:длилась|шла|началась|закончилась|завершилась)",
    "атомн\\S* бомб\\S*[^.]{0,40}Хиросим",
    "сам(?:ый|ая|ое|ые|ых|ым|ой|ую|ыми) (?:кровопролитн|кровав|смертоносн|страшн|жесток)\\S*",
    "полностью (?:разгромлен|уничтожен|разбит)\\S*",
    "(?:убит|погиб|потер)\\S*[^.]{0,40}(?:более|свыше|больше|около) (?:миллиона|\\d+ миллион)",
    "(?:окруж|разгром|уничтож|гибел|капитуляц)\\S*[^.]{0,30}6-й армии",
    "(?:завершил|закончил|окончил)\\S* (?:полным )?(?:разгромом|победой|освобождением|окружением|капитуляцией|взятием)",
    "(?:восстани|революци)\\S*[^.]{0,120}подавлен\\S*",
    "(?:бои|битва|сражение|оборона|осада|наступление|операция)[^.]{0,60}(?:продолжал|длил|продлил)\\S* (?:с |более|почти|около|меньше|менее)",
    "(?:величайш|крупнейш)\\S* (?:сражени|битв)\\S* (?:в истории|Второй мировой|войны)",
    "Перл-Харбор[^.]{0,80}вступ",
  ].join("|"),
  "iu",
);

/** Общеизвестный факт в цитате - что именно (для лога) или undefined. */
export function banalIn(quote: string | undefined): string | undefined {
  if (!quote) return undefined;
  return quote.match(BANAL)?.[0];
}

/** Короче этого остаток изюминки - уже не изюминка. */
export const MIN_QUOTE_AFTER_STRIP = 60;

/**
 * Вырезать из цитаты общеизвестные предложения и оставить остальное:
 * «В подземных штольнях шили ушанки... Бои за Крым продолжались с 30
 * октября по 4 июля» - первое предложение и есть изюминка. Пусто или
 * обрывок короче MIN_QUOTE_AFTER_STRIP - значит, изюминки не было.
 */
export function stripBanal(quote: string): string {
  const sentences = quote.match(/[^.!?…]+(?:[.!?…]+|$)/g) ?? [quote];
  const kept = sentences.filter((x) => !banalIn(x)).map((x) => x.trim()).filter(Boolean);
  const out = kept.join(" ").trim();
  return out.length >= MIN_QUOTE_AFTER_STRIP ? out : "";
}

/** Изюминка из учебника снимается так же, как штамп (guardCliches). */
export function guardBanal(
  reviewed: { caption: GeneratedCaption; rewritten: boolean },
  firstPass: GeneratedCaption,
): NumbersVerdict {
  const hit = banalIn(reviewed.caption.quote);
  if (!hit) return { caption: reviewed.caption, outcome: "ok", bad: [] };
  const bad = [`общеизвестное «${hit}»`];
  if (reviewed.rewritten && firstPass.quote !== reviewed.caption.quote && !banalIn(firstPass.quote)) {
    return { caption: firstPassQuote(reviewed.caption, firstPass), outcome: "editor_rejected", bad };
  }
  // остаток без общеизвестного ещё изюминка - оставляем его
  const rest = stripBanal(reviewed.caption.quote);
  if (rest) return { caption: { ...reviewed.caption, quote: rest }, outcome: "quote_dropped", bad };
  return {
    caption: {
      ...reviewed.caption,
      quote: reviewed.caption.quote_place ?? "",
      quote_place: undefined,
      quote_kind: "context",
    },
    outcome: "quote_dropped",
    bad,
  };
}

export function guardCliches(
  reviewed: { caption: GeneratedCaption; rewritten: boolean },
  firstPass: GeneratedCaption,
): NumbersVerdict {
  const hit = clicheIn(reviewed.caption.quote);
  if (!hit) return { caption: reviewed.caption, outcome: "ok", bad: [] };
  const bad = [`штамп «${hit}»`];
  if (reviewed.rewritten && firstPass.quote !== reviewed.caption.quote && !clicheIn(firstPass.quote)) {
    return { caption: firstPassQuote(reviewed.caption, firstPass), outcome: "editor_rejected", bad };
  }
  return {
    caption: {
      ...reviewed.caption,
      quote: reviewed.caption.quote_place ?? "",
      quote_place: undefined,
      quote_kind: "context",
    },
    outcome: "quote_dropped",
    bad,
  };
}

/**
 * Запасные варианты подписи без изюминки - для кадра, чья подпись не
 * прошла проверку лет. Сбор 22.10: два годных кадра (дозаправка F-14,
 * посадка в поезд) ушли в брак целиком из-за года в изюминке, которого
 * нет в источниках, хотя тело поста было чистым. Сперва пробуем оставить
 * строку места и даты, потом - пост без цитаты. Если год сидит в самом
 * теле, не поможет ни один - и кадр уходит в брак, как раньше.
 */
export function withoutQuote(caption: GeneratedCaption): GeneratedCaption[] {
  if (!caption.quote) return [];
  const out: GeneratedCaption[] = [];
  if (caption.quote_place && caption.quote_place !== caption.quote) {
    out.push({ ...caption, quote: caption.quote_place, quote_place: undefined, quote_kind: "context" });
  }
  out.push({ ...caption, quote: "", quote_place: undefined });
  return out;
}
