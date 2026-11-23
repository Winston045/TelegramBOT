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
      "id, source, source_id, source_url, image_url, raw_title, raw_desc, raw_lang, year, place, license, attribution, caption_html, tags",
    )
    .not("caption_html", "is", null);
  const { data, error } = ids.length
    ? await query.in(byMessage ? "channel_msg_id" : "id", ids)
    : await query
        .in("status", ["new", "shown", "approved"])
        .order("id", { ascending: false })
        .limit(all ? 200 : 6);
  if (error) throw new Error(error.message);

  for (const r of (data ?? []) as Row[]) {
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
      const res = await fetch(r.image_url, {
        headers: { "user-agent": "story-team-bot/0.1 (Telegram history channel; contact via t.me/Story_Teams)" },
        signal: AbortSignal.timeout(60_000),
      });
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
    await new Promise((res) => setTimeout(res, 4000));
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
