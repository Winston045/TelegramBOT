-- История прогонов сбора: воронка по этапам и состояние источников.
-- Нужна, чтобы бот сам замечал, что контент перестал доходить до резерва,
-- и мог объяснить это редактору человеческими словами.
create table if not exists collect_runs (
  id          bigserial primary key,
  started_at  timestamptz not null default now(),
  raw         int not null default 0,   -- пришло из источников
  prefiltered int not null default 0,   -- пережило дешёвый префильтр
  analyzed    int not null default 0,   -- дошло до Gemini
  written     int not null default 0,   -- записано в резерв
  junk        int not null default 0,   -- отсеяно порогом качества
  broken      int not null default 0,   -- брак подписи
  sources     jsonb                     -- {"loc": 27, "commons": 54, ...}
);

create index if not exists collect_runs_started_idx on collect_runs (started_at desc);

alter table if exists collect_runs enable row level security;
