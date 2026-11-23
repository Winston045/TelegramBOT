/**
 * Предпросмотр подписей на новых промптах - «было → стало» по готовым
 * кадрам из базы, без записи в базу и без публикации.
 *
 * Правка промптов меняет то, что уйдёт в канал, поэтому сначала её видно
 * на живых кадрах: картинка заново скачивается, проходит анализ, справку
 * о предмете в кадре и редактора цитаты - ровно как в сборе.
 *
 * Запуск: npx tsx scripts/caption-preview.ts 445,419,446
 * или по номерам постов канала: npx tsx scripts/caption-preview.ts msg:7187,7179
 * (без номеров - шесть свежих кадров резерва с подписью).
 *
 * Переписать резерв (22.11: общеизвестное в цитатах - брак):
 *   npx tsx scripts/caption-preview.ts all --apply
 * all - весь неопубликованный резерв; --apply - записать новую подпись в
 * базу, если валидатор её пропускает. Без --apply база не трогается.
 *
 * Переписать последние вышедшие посты - и в канале (23.11):
 *   npx tsx scripts/caption-preview.ts recent:10 --apply
 * Подпись меняется, только если редактор цитат отработал, валидатор
 * пропускает и цитата стала другой.
 *
 * Доводка подписи - тот же конвейер, что у сбора (src/pipeline.ts): что
 * показал предпросмотр, то и уйдёт в канал.
 */
import { loadConfig } from "../src/config.js";
import { getDb } from "../src/db.js";
import { ADAPTERS } from "../src/sources/index.js";
import { analyzeImage } from "../src/analyze.js";
import { assembleCaptionHtml } from "../src/caption.js";
import { GeminiBusyError } from "../src/gemini.js";
import { finishCaption } from "../src/pipeline.js";
import { rubricOf } from "../src/rubrics.js";
import type { RawItem } from "../src/sources/types.js";
import { env } from "../src/env.js";
import { WIKIMEDIA_UA } from "../src/wiki.js";
import { retryAfterMs } from "../src/hostguard.js";

/**
 * Скачивание как у сбора (scripts/collect.ts): правильный User-Agent для
 * Викимедиа и ожидание по Retry-After. Первый прогон резерва 22.11 качал
 * своим заголовком без ожидания - 15 кадров из 27 упали на HTTP 429.
 */
async function fetchImage(url: string): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      headers: { "user-agent": WIKIMEDIA_UA, accept: "image/*" },
      signal: AbortSignal.timeout(60_000),
    });
    if (res.status !== 429 || attempt >= 2) return res;
    const wait = Math.min(retryAfterMs(res.headers.get("retry-after")), 120_000);
    console.log(`  429: жду ${Math.round(wait / 1000)} с и повторяю`);
    await new Promise((ok) => setTimeout(ok, wait));
  }
}
import { getTelegram } from "../src/telegram.js";

type Row = {
  id: number;
  source: string;
  source_id: string;
  source_url: string;
  image_url: string;
  raw_title: string | null;
  raw_desc: string | null;
  raw_lang: string | null;
  year: number | null;
  place: string | null;
  license: string | null;
  attribution: string | null;
  caption_html: string | null;
  tags: { rubric?: string } | null;
  status?: string;
  channel_msg_id?: number | null;
};

/** Подпись без футера канала, цитаты - строками «» с отступом. */
const plain = (html: string | null) => {
  const raw = html ?? "";
  // футер - последний блок после пустой строки со ссылкой канала; режем
  // его ДО разметки цитат, иначе перенос перед цитатой съедал и их
  const cut = raw.lastIndexOf("\n\n");
  const body = cut !== -1 && raw.slice(cut).includes("<a href=") ? raw.slice(0, cut) : raw;
  return body
    .replace(/\n?<blockquote[^>]*>/g, "\n  » ")
    .replace(/<[^>]+>/g, "")
    .trim();
};

async function main() {
  const cfg = loadConfig();
  const db = getDb();
  const arg = process.argv[2] ?? "";
  const apply = process.argv.includes("--apply");
  const all = arg === "all";
  // recent:10 - последние вышедшие посты, правка и в канале
  const recent = Number(arg.match(/^recent:(\d+)$/)?.[1] ?? 0);
  let written = 0;
  let skippedBusy = 0;
  // msg:7187,7179 - номера постов канала, а не кадров в базе
  const byMessage = arg.startsWith("msg:");
  const ids = arg
    .replace(/^msg:/, "")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
  const query = db
    .from("candidates")
    .select(
      "id, source, source_id, source_url, image_url, raw_title, raw_desc, raw_lang, year, place, license, attribution, caption_html, tags, status, channel_msg_id",
    )
    .not("caption_html", "is", null);
  const { data, error } = recent
    ? await query.eq("status", "published").not("channel_msg_id", "is", null).order("published_at", { ascending: false }).limit(recent)
    : ids.length
    ? await query.in(byMessage ? "channel_msg_id" : "id", ids)
    : await query
        .in("status", ["new", "shown", "approved"])
        .order("id", { ascending: false })
        .limit(all ? 200 : 6);
  if (error) throw new Error(error.message);

  const today = new Date().toISOString().slice(0, 10);
  for (const r of (data ?? []) as Row[]) {
    // повторный прогон резерва: уже переписанное сегодня не трогаем
    if (apply && all && (r.tags as { requoted?: string } | null)?.requoted === today) continue;
    const item: RawItem = {
      sourceId: r.source_id,
      sourceUrl: r.source_url,
      imageUrl: r.image_url,
      title: r.raw_title ?? undefined,
      description: r.raw_desc ?? undefined,
      lang: r.raw_lang ?? "en",
      year: r.year ?? undefined,
      place: r.place ?? undefined,
      license: r.license ?? "PD",
      attribution: r.attribution ?? undefined,
      rubric: r.tags?.rubric,
    };
    console.log("═".repeat(72));
    console.log(`#${r.id} [${r.source}] ${(r.raw_title ?? "").slice(0, 80)}`);
    console.log(`БЫЛО:\n  ${plain(r.caption_html)}`);
    try {
      const res = await fetchImage(r.image_url);
      if (!res.ok) throw new Error(`картинка: HTTP ${res.status}`);
      const image = Buffer.from(await res.arrayBuffer());
      const extra = await ADAPTERS[r.source]?.details?.(item).catch(() => undefined);
      const a = await analyzeImage(item, cfg, image, extra);
      console.log(
        `предмет: ${a.subject_wiki ?? "-"}; событие: ${a.event_wiki ?? "-"}; люди: ${a.people?.join(", ") || "-"}`,
      );
      let editorBusy = false;
      // первый заход отдельно: видно, кто сделал изюминку, а кто её снял
      console.log(`ПЕРВЫЙ ЗАХОД:\n  ${plain(assembleCaptionHtml(a, item, cfg.channel))}`);
      const done = await finishCaption({
        item: { ...item, source: r.source },
        cfg,
        analysis: a,
        extraContext: extra,
        rubric: rubricOf(item.rubric),
        full: true,
        // занятые модели в предпросмотре не ждём: так и пишем
        review: async (call, generated) => {
          try {
            return await call();
          } catch (err) {
            if (!(err instanceof GeminiBusyError)) throw err;
            console.log("  ! редактор пропущен: полноценные модели заняты");
            editorBusy = true;
            return { caption: generated, rewritten: false };
          }
        },
        log: (m) => console.log(m),
      });
      console.log(`СТАЛО${done.rewritten ? " (редактор переписал)" : ""}:\n  ${plain(done.html)}`);
      if (done.rubricFlaw) console.log(`  ! рубрика не пропустила бы: ${done.rubricFlaw}`);
      if (!done.check.ok) console.log(`  ! валидатор не пропустил бы: ${done.check.reason}`);
      // без редактора подпись сырая - в базу не пишем, перепроверим позже
      if (apply && editorBusy) {
        skippedBusy++;
        console.log("  не записано: редактор был занят");
      } else if (apply && recent && r.status === "published" && r.channel_msg_id) {
        const quoteOf = (h: string | null) =>
          [...(h ?? "").matchAll(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/g)].map((m) => m[1]).join("|");
        if (!done.check.ok || done.rubricFlaw) console.log("  в канале не меняю: подпись не прошла проверку");
        else if (quoteOf(done.html) === quoteOf(r.caption_html)) console.log("  в канале не меняю: цитата та же");
        else {
          try {
            await getTelegram().editMessageCaption(env.channelId, r.channel_msg_id, { caption: done.html, parse_mode: "HTML" });
            await db.from("candidates").update({ caption_html: done.html, tags: { ...(r.tags ?? {}), requoted: today } }).eq("id", r.id);
            written++;
            console.log(`  заменено в канале (пост ${r.channel_msg_id})`);
          } catch (err) {
            console.log(`  ! канал: ${(err as Error).message}`);
          }
        }
      } else if (apply && done.check.ok && !done.rubricFlaw && done.html !== r.caption_html) {
        const { error: upErr } = await db
          .from("candidates")
          .update({
            caption_html: done.html,
            tags: {
              ...(r.tags ?? {}),
              ...(a.subject_wiki ? { subject_wiki: a.subject_wiki } : {}),
              ...(a.event_wiki ? { event_wiki: a.event_wiki } : {}),
              requoted: new Date().toISOString().slice(0, 10),
            },
          })
          .eq("id", r.id)
          .in("status", ["new", "shown", "approved"]);
        if (upErr) console.log(`  ! не записано: ${upErr.message}`);
        else {
          written++;
          console.log("  записано в базу");
        }
      }
    } catch (err) {
      console.log(`  сбой: ${(err as Error).message}`);
    }
    // Викимедиа отбивает частые скачивания (HTTP 429) - пауза между кадрами
    await new Promise((res) => setTimeout(res, apply ? 10_000 : 4000));
  }
  console.log(
    apply
      ? `\nпереписано в базе: ${written}; пропущено из-за занятого редактора: ${skippedBusy}; в канал ничего не ушло`
      : "\nпредпросмотр завершён: база не тронута, в канал ничего не ушло",
  );
}

main().catch((err) => {
  console.error("предпросмотр упал:", err);
  process.exit(1);
});
