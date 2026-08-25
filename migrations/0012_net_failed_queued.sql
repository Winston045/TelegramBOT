-- Два уточнения истории прогонов по итогам утра 25.08:
-- net_failed: сбои сети и перегрузка Gemini (503, таймауты) - не брак
--   подписи и не квота; сводка выдавала их за «брак подписи»
-- queued: реальная очередь анализа (после лимита партии и дедупа);
--   сводка считала «недождавшихся» от всего префильтра - 62 вместо 28
alter table collect_runs add column if not exists net_failed int not null default 0;
alter table collect_runs add column if not exists queued int;
