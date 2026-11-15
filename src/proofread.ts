/**
 * Ночная вычитка резерва (редакция 15.11: «максимально тонкая работа, а
 * не на беглую руку»). Сбор пишет подписи под давлением квоты и времени,
 * и в резерв доходят опечатки: «палатью» вместо «палаткой» в карточке
 * Terra Nova (#672). Ночью, без спешки, полноценная модель перечитывает
 * посты, которые выйдут ближайшими, и правит только язык.
 *
 * Корректор не редактор: факты, числа, имена и порядок слов - не его
 * дело. Страховка ниже отбрасывает любую правку, которая тронула числа,
 * латиницу или названия в кавычках либо переписала текст сильнее, чем
 * исправление опечаток.
 */
import { splitFooter } from "../supabase/functions/_shared/edit_caption.js";

/** Доля символов, которую правка может изменить: больше - это уже переписывание. */
export const MAX_EDIT_SHARE = 0.12;

export type Segment = { raw: string; text: string };

function decode(html: string): string {
  return html
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

export function encode(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Текстовые куски подписи, которые можно вычитывать: описание до цитат и
 * текст каждой цитаты. Футер (атрибуция, подпись канала) не трогаем;
 * кусок с разметкой внутри (ссылка, жирный) - тоже, чтобы не сломать HTML.
 */
export function textSegments(captionHtml: string): Segment[] {
  const { body } = splitFooter(captionHtml);
  const out: Segment[] = [];
  const parts = body.split(/(<blockquote[^>]*>[\s\S]*?<\/blockquote>)/);
  for (const part of parts) {
    const inner = part.match(/^<blockquote[^>]*>([\s\S]*?)<\/blockquote>$/)?.[1] ?? part;
    for (const line of inner.split("\n")) {
      const raw = line.trim();
      if (!raw || raw.includes("<")) continue;
      out.push({ raw, text: decode(raw) });
    }
  }
  return out;
}

/** Расстояние Левенштейна - сколько символов правка меняет. */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j]! + 1,
        cur[j - 1]! + 1,
        prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[b.length]!;
}

const digits = (s: string) => (s.match(/\d+/g) ?? []).join(" ");
const latin = (s: string) => (s.match(/[A-Za-z][A-Za-z0-9.-]*/g) ?? []).join(" ");
const quoted = (s: string) => (s.match(/«[^»]*»/g) ?? []).join(" ");

/**
 * Годится ли правка корректора. Причина отказа - строкой, для лога;
 * undefined - правку можно применять.
 */
export function rejectFix(before: string, after: string): string | undefined {
  if (!after.trim()) return "пустой ответ";
  if (digits(before) !== digits(after)) return "изменены числа";
  if (latin(before) !== latin(after)) return "изменена латиница";
  if (quoted(before) !== quoted(after)) return "изменены названия в кавычках";
  const share = editDistance(before, after) / Math.max(1, before.length);
  if (share > MAX_EDIT_SHARE) return `переписано ${Math.round(share * 100)}% текста`;
  return undefined;
}

/** Заменить в подписи выверенные куски; футер остаётся как был. */
export function applyFixes(captionHtml: string, fixes: Array<{ raw: string; text: string }>): string {
  const { body, footer } = splitFooter(captionHtml);
  let next = body;
  for (const f of fixes) next = next.replace(f.raw, () => encode(f.text));
  return footer ? `${next}\n\n${footer}` : next;
}

export function buildProofreadPrompt(segments: string[]): string {
  return `Ты корректор русскоязычного исторического Telegram-канала. Вычитай куски текста поста.

Исправляй ТОЛЬКО язык: опечатки и искажённые слова, орфографию, пунктуацию, согласование падежей, родов и чисел.
НЕЛЬЗЯ: менять факты, числа, даты, имена, названия, порядок мыслей и стиль; переписывать фразы «покрасивее»; добавлять или убирать сведения; менять тире и кавычки, если они верны.
Если в куске ошибок нет - верни его без единого изменения.

Куски (JSON-массив):
${JSON.stringify(segments)}

Ответь JSON: {"segments": [ ...то же число кусков, в том же порядке... ]}`;
}
