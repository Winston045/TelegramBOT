/**
 * План публикаций - единственный источник правды о том, что и когда выйдет.
 *
 * Раньше автопостинг был пристройкой к ручному режиму: публикатор сам решал,
 * кого взять, а команда /queue показывала только одобренное - в авторежиме
 * она всегда была пуста, хотя посты выходили. Теперь и публикатор, и бот
 * зовут один и тот же планировщик, поэтому предпросмотр совпадает с тем,
 * что реально уедет в канал.
 *
 * Файл без импортов: используется и Node-скриптами, и Deno Edge Function.
 */

export type PlanTags = {
  subject?: string;
  region?: string;
  period?: string;
  military?: boolean;
  action?: boolean;
  color?: boolean;
} | null;

export type PlanCandidate = {
  id: number;
  caption_html: string | null;
  score?: number | null;
  tags?: PlanTags;
  scheduled_at?: string | null;
  /** Архив-поставщик («Bundesarchiv», «IWM», «РИА Новости»...). */
  attribution?: string | null;
  /** Источник («commons», «loc», «pastvu») - запасной ключ чередования
   *  для старых кандидатов, собранных без архива. */
  source?: string | null;
};

/** Откуда пост попал в план - это видно редактору в /queue. */
export type PlanKind = "scheduled" | "approved" | "auto";

export type PlanEntry = {
  candidate: PlanCandidate;
  kind: PlanKind;
  /** Человеческая метка времени: "сегодня 18:00", "сейчас", "02.08 09:30". */
  when: string;
  /** true - слот уже наступил, пост уедет ближайшим заходом публикатора. */
  due: boolean;
};

/** Насколько развёрнутая цитата поднимает пост в очереди автовыбора. */
export const QUOTE_BONUS = 5;
/** Длина цитаты, с которой она считается познавательной справкой. */
export const LONG_QUOTE = 180;
/** Сколько последних постов помним для правил разнообразия. */
export const RECENT_WINDOW = 4;
/**
 * Насколько статика уступает живому кадру при равном качестве. Оценка за
 * постановочность больше не штрафуется (это делала модель и выбрасывала
 * целые архивы), но в ленте движение идёт вперёд.
 */
export const STATIC_PENALTY = 12;
/**
 * Подлинный цвет эпохи - редкость, читатели такое любят: небольшая фора,
 * чтобы цветной кадр выигрывал у равного чёрно-белого, но не у лучшего.
 */
export const COLOR_BONUS = 8;
/**
 * Эпохи до ВМВ уступают при равном качестве: снимки тех лет часто сильно
 * повреждены, упор канала - ВМВ и вторая половина XX века. Это скидка,
 * а не запрет: старый кадр с сильной историей (высокая оценка, развёрнутая
 * цитата) перевешивает её и выходит.
 */
export const OLD_ERA_PENALTY = 8;
export const OLD_PERIODS = new Set([
  "pre_ww1",
  "WW1",
  "russian_civil_war",
  "interwar",
  "spanish_civil_war",
]);
/** Сколько статичных кадров допускаем на окно из RECENT_WINDOW постов. */
export const MAX_STATIC_IN_WINDOW = 1;
/**
 * Развёрнутая цитата - изюминка ленты, а не норма: основная масса постов
 * короткие, и длинные справки не должны идти подряд. Одна на окно.
 */
export const MAX_LONG_IN_WINDOW = 1;
/**
 * Канал про войну: мирный сюжет уступает боевому при равном качестве,
 * но яркий мирный кадр (высокая оценка) штраф перевешивает и выходит.
 */
export const CIVILIAN_PENALTY = 6;
/** Сколько мирных кадров допускаем на окно из RECENT_WINDOW постов. */
export const MAX_CIVILIAN_IN_WINDOW = 1;
/**
 * Шахматный порядок архивов: два поста подряд из одного архива не идут.
 * Состав резерва зависит от того, кто в этот день отдал больше, и лента
 * качалась от «одних немцев» к «одним британцам»; веса источников тут
 * бессильны - перекос просто меняет флаг, поэтому чередуем на отборе.
 * Окно короткое (соседний пост), иначе при трёх живых архивах лента
 * упиралась бы в правило и шла по запасному пути.
 */
export const MAX_SAME_ARCHIVE_IN_WINDOW = 1;
export const ARCHIVE_WINDOW = 2;
/**
 * Вожди и церемонии с ними («leader») - самые «фотогеничные» кадры в
 * архивах, модель щедра к ним на оценку, и лента превращалась в галерею
 * Гитлера. Держим их редкой краской: не чаще одного на окно.
 */
export const LEADER_PENALTY = 10;
export const MAX_LEADERS_IN_WINDOW = 1;

/**
 * Имя архива из строки атрибуции. В базе она вида
 * «Bundesarchiv, Koch / CC BY-SA 3.0 de» - с фотографом и лицензией,
 * поэтому сравнивать строки целиком нельзя: они уникальны у каждого
 * кадра, и правила баланса по архиву не срабатывали ни разу.
 */
export function archiveKey(attribution?: string | null): string {
  if (!attribution) return "";
  return (attribution.split("/")[0] ?? "").split(",")[0]!.trim().toLowerCase();
}

/** Видимая длина цитаты внутри blockquote. */
export function quoteLength(captionHtml: string | null): number {
  const m = captionHtml?.match(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/);
  return m?.[1]?.replace(/<[^>]+>/g, "").trim().length ?? 0;
}

/** Первая строка подписи без тегов - заголовок для списков. */
export function headline(captionHtml: string | null, limit = 70): string {
  if (!captionHtml) return "(без подписи)";
  const text = captionHtml.replace(/<[^>]+>/g, "").split("\n")[0] ?? "";
  return text.length > limit ? `${text.slice(0, limit - 3)}...` : text;
}

/**
 * Место в очереди: качество кадра плюс редакционные предпочтения.
 * Оценка отвечает за качество, здесь - за характер ленты.
 */
export function rank(c: PlanCandidate): number {
  const quote = quoteLength(c.caption_html ?? null) >= LONG_QUOTE ? QUOTE_BONUS : 0;
  const staticShot = c.tags?.action === false ? STATIC_PENALTY : 0;
  const color = c.tags?.color === true ? COLOR_BONUS : 0;
  const oldEra = c.tags?.period && OLD_PERIODS.has(c.tags.period) ? OLD_ERA_PENALTY : 0;
  const civilian = c.tags?.military === false ? CIVILIAN_PENALTY : 0;
  const leader = c.tags?.subject === "leader" ? LEADER_PENALTY : 0;
  return (c.score ?? 0) + quote + color - staticShot - oldEra - civilian - leader;
}

export type RecentContext = {
  /** Темы последних постов, свежие первыми. */
  subjects: string[];
  /** Эпохи последних постов, свежие первыми. */
  periods?: string[];
  /** Был ли мирный кадр среди последних постов. */
  civilian: boolean;
  /** Сколько статичных кадров было среди последних постов. */
  statics?: number;
  /** Сколько постов с развёрнутой цитатой было среди последних. */
  longs?: number;
  /** Архивы последних постов, свежие первыми. */
  archives?: string[];
};

/** Сколько постов одной эпохи подряд допускаем, прежде чем сменить её. */
export const MAX_SAME_PERIOD_STREAK = 2;

/**
 * Жадный подбор из резерва: каждый следующий пост учитывает не только
 * вышедшее раньше, но и то, что уже попало в этот же план. Иначе три
 * одинаковых парома встают подряд именно в предпросмотре.
 *
 * Если подходящих нет вовсе, берём лучший оставшийся - пустой слот хуже
 * повтора темы.
 */
export function planAuto(
  reserve: PlanCandidate[],
  recent: RecentContext,
  count: number,
): PlanCandidate[] {
  const pool = [...reserve].sort((a, b) => rank(b) - rank(a) || a.id - b.id);
  const chosen: PlanCandidate[] = [];
  const subjects = [...recent.subjects];
  const periods = [...(recent.periods ?? [])];
  // канал про войну: мирный кадр - редкая передышка, не череда
  const civiliansWindow: boolean[] = recent.civilian ? [true] : [];
  // архивы последних постов: лента не должна быть витриной одного архива
  const archives = [...(recent.archives ?? [])];
  // окно скользит: сколько статики в последних RECENT_WINDOW постах
  const staticsWindow: boolean[] = Array.from(
    { length: Math.min(recent.statics ?? 0, RECENT_WINDOW) },
    () => true,
  );
  // то же для изюминок - постов с развёрнутой цитатой
  const longsWindow: boolean[] = Array.from(
    { length: Math.min(recent.longs ?? 0, RECENT_WINDOW) },
    () => true,
  );

  while (chosen.length < count && pool.length) {
    const staticsInWindow = staticsWindow.slice(0, RECENT_WINDOW).filter(Boolean).length;
    const longsInWindow = longsWindow.slice(0, RECENT_WINDOW).filter(Boolean).length;
    // эпоха «застряла», если ею заняты MAX_SAME_PERIOD_STREAK свежих постов
    const streak = periods.slice(0, MAX_SAME_PERIOD_STREAK);
    const stuckPeriod =
      streak.length === MAX_SAME_PERIOD_STREAK && streak.every((p) => p === streak[0])
        ? streak[0]
        : undefined;
    const civiliansInWindow = civiliansWindow.slice(0, RECENT_WINDOW).filter(Boolean).length;
    const fits = (c: PlanCandidate) => {
      const subject = c.tags?.subject;
      if (subject && subjects.slice(0, RECENT_WINDOW).includes(subject)) return false;
      if (c.tags?.military === false && civiliansInWindow >= MAX_CIVILIAN_IN_WINDOW) return false;
      // статика допустима, но редко: лента должна дышать движением
      if (c.tags?.action === false && staticsInWindow >= MAX_STATIC_IN_WINDOW) return false;
      // развёрнутая цитата - изюминка: длинные посты не идут подряд
      if (quoteLength(c.caption_html ?? null) >= LONG_QUOTE && longsInWindow >= MAX_LONG_IN_WINDOW)
        return false;
      // лента не должна неделями сидеть в одном году - эпохи чередуются
      if (stuckPeriod && c.tags?.period === stuckPeriod) return false;
      // вожди - редкая краска, а не каждый второй пост
      if (
        c.tags?.subject === "leader" &&
        subjects.slice(0, RECENT_WINDOW).filter((s) => s === "leader").length >=
          MAX_LEADERS_IN_WINDOW
      ) {
        return false;
      }
      // и не должна быть витриной одного архива: «одни немцы», «одни британцы»
      const archive = archiveKey(c.attribution) || (c.source ?? "");
      if (
        archive &&
        archives.slice(0, ARCHIVE_WINDOW).filter((a) => a === archive).length >=
          MAX_SAME_ARCHIVE_IN_WINDOW
      ) {
        return false;
      }
      return true;
    };
    let idx = pool.findIndex(fits);
    if (idx === -1) {
      // под все правила не подошёл никто (резерв беден) - берём лучшего,
      // но хотя бы не из того же архива, что предыдущий пост: слепой
      // добор давал «Бундесархив, Бундесархив, Бундесархив» подряд
      const lastArchive = archives[0];
      const other = lastArchive
        ? pool.findIndex((c) => (archiveKey(c.attribution) || (c.source ?? "")) !== lastArchive)
        : -1;
      idx = other === -1 ? 0 : other;
    }
    const [pick] = pool.splice(idx, 1);
    if (!pick) break;
    chosen.push(pick);
    if (pick.tags?.subject) subjects.unshift(pick.tags.subject);
    periods.unshift(pick.tags?.period ?? "");
    civiliansWindow.unshift(pick.tags?.military === false);
    archives.unshift(archiveKey(pick.attribution) || (pick.source ?? ""));
    staticsWindow.unshift(pick.tags?.action === false);
    longsWindow.unshift(quoteLength(pick.caption_html ?? null) >= LONG_QUOTE);
  }
  return chosen;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** "HH:MM" -> минуты от полуночи. */
function toMinutes(slot: string): number {
  const [h, m] = slot.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

export type SlotContext = {
  /** Текущее время. */
  now: Date;
  /** Смещение таймзоны канала, например "+03:00". */
  tzOffset: string;
  /** Слоты расписания "HH:MM". */
  times: string[];
  /** Сколько постов уже вышло сегодня. */
  publishedToday: number;
};

/**
 * Ближайшие моменты публикации. Первыми идут «догоняющие» слоты: если
 * сегодня прошло слотов больше, чем вышло постов, публикатор наверстает
 * их ближайшим заходом - так это и показываем.
 */
export function upcomingSlots(ctx: SlotContext, count: number): Array<{ label: string; due: boolean }> {
  const { now, tzOffset, times, publishedToday } = ctx;
  if (!times.length || count <= 0) return [];

  const local = new Date(now.getTime() + offsetMinutes(tzOffset) * 60_000);
  const nowMinutes = local.getUTCHours() * 60 + local.getUTCMinutes();
  const passed = times.filter((t) => toMinutes(t) <= nowMinutes).length;

  const out: Array<{ label: string; due: boolean }> = [];
  for (let i = 0; i < passed - publishedToday && out.length < count; i++) {
    out.push({ label: "ближайшим заходом", due: true });
  }

  for (let day = 0; day < 7 && out.length < count; day++) {
    for (const t of times) {
      if (out.length >= count) break;
      if (day === 0 && toMinutes(t) <= nowMinutes) continue;
      const when = new Date(local.getTime() + day * 24 * 3600 * 1000);
      const label =
        day === 0
          ? `сегодня ${t}`
          : day === 1
            ? `завтра ${t}`
            : `${pad(when.getUTCDate())}.${pad(when.getUTCMonth() + 1)} ${t}`;
      out.push({ label, due: false });
    }
  }
  return out;
}

function offsetMinutes(tzOffset: string): number {
  const m = tzOffset.match(/^([+-])(\d{2}):(\d{2})$/);
  if (!m) return 0;
  const sign = m[1] === "-" ? -1 : 1;
  return sign * (Number(m[2]) * 60 + Number(m[3]));
}

export type PlanInput = SlotContext & {
  /** Одобренные с назначенным временем. */
  scheduled: PlanCandidate[];
  /** Одобренные без времени, в порядке одобрения. */
  approved: PlanCandidate[];
  /** Резерв с готовой подписью (учитывается только при autoPublish). */
  reserve: PlanCandidate[];
  /** Темы и характер последних вышедших постов. */
  recent: RecentContext;
  autoPublish: boolean;
  /** Форматирование времени запланированных постов. */
  formatScheduled: (iso: string) => string;
};

/**
 * Что и когда выйдет. Порядок приоритетов тот же, что у публикатора:
 * назначенное время → одобренная очередь → автовыбор из резерва.
 */
export function buildPlan(input: PlanInput, count: number): PlanEntry[] {
  const entries: PlanEntry[] = [];

  for (const c of input.scheduled) {
    if (!c.scheduled_at) continue;
    entries.push({
      candidate: c,
      kind: "scheduled",
      when: input.formatScheduled(c.scheduled_at),
      due: new Date(c.scheduled_at).getTime() <= input.now.getTime(),
    });
  }

  const bySlot: Array<{ candidate: PlanCandidate; kind: PlanKind }> = input.approved.map((c) => ({
    candidate: c,
    kind: "approved" as const,
  }));

  const slotsLeft = Math.max(0, count - entries.length - bySlot.length);
  if (input.autoPublish && slotsLeft > 0) {
    for (const c of planAuto(input.reserve, input.recent, slotsLeft)) {
      bySlot.push({ candidate: c, kind: "auto" });
    }
  }

  const slots = upcomingSlots(input, bySlot.length);
  bySlot.forEach((item, i) => {
    const slot = slots[i];
    entries.push({
      candidate: item.candidate,
      kind: item.kind,
      when: slot?.label ?? "когда освободится слот",
      due: slot?.due ?? false,
    });
  });

  return entries.slice(0, count);
}
