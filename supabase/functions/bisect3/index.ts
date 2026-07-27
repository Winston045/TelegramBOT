// Бисекция бута вебхука, шаг 3: все общие модули _shared.
import { entitiesToHtml } from "../_shared/entities.ts";
import { parseCandidateId } from "../_shared/service_line.ts";
import { replaceBody, replaceQuote } from "../_shared/edit_caption.ts";
import { CAPTION_LIMIT, validateHtml, visibleLength } from "../_shared/validate.ts";
import { MAX_SLOTS, hourKeyboard, schedulePanelText } from "../_shared/schedule_panel.ts";
const t = [
  typeof entitiesToHtml,
  typeof parseCandidateId,
  typeof replaceBody,
  typeof replaceQuote,
  typeof validateHtml,
  typeof visibleLength,
  typeof hourKeyboard,
  typeof schedulePanelText,
].join(",");
Deno.serve(() => new Response(`ok ${CAPTION_LIMIT} ${MAX_SLOTS} ${t}`));
