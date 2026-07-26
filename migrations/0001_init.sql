-- Идемпотентно: можно выполнять и через npm run migrate, и вставив целиком
-- в Supabase SQL Editor — повторный запуск ничего не ломает.

create table if not exists candidates (
  id            bigserial primary key,
  source        text not null,          -- 'loc' | 'bundesarchiv' | 'nara'
  source_id     text not null,          -- id записи в архиве
  source_url    text not null,          -- ссылка на карточку в архиве
  image_url     text not null,
  image_hash    text not null,          -- dHash, hex
  raw_title     text,                   -- исходный заголовок, как есть
  raw_desc      text,                   -- исходное описание, как есть
  raw_lang      text,                   -- 'en' | 'de' | ...
  year          int,
  place         text,
  caption_html  text,                   -- готовая подпись, HTML
  quote_kind    text,                   -- 'observation' | 'context'
  tags          jsonb,                  -- {period, region, subject}
  score         int,                    -- 0-100 от vision
  license       text,                   -- 'PD' | 'CC-BY-SA' | ...
  attribution   text,                   -- строка атрибуции, если нужна
  status        text not null default 'new',
                -- new | shown | approved | rejected | published | failed
  shown_at      timestamptz,
  published_at  timestamptz,
  channel_msg_id bigint,
  created_at    timestamptz default now(),
  unique (source, source_id)
);

create index if not exists candidates_status_idx on candidates (status);
create index if not exists candidates_image_hash_idx on candidates (image_hash);

-- хэши всего, что уже выходило в канале (включая бэкфилл архива)
create table if not exists seen_hashes (
  image_hash text primary key,
  origin     text,              -- 'backfill' | 'published'
  created_at timestamptz default now()
);

-- отметки о том, что процессы живы
create table if not exists heartbeats (
  job        text primary key,  -- 'collector' | 'publisher'
  last_ok    timestamptz,
  last_error text
);
