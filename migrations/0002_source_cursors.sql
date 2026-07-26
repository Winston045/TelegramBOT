-- Курсоры пагинации по источникам: без них каждый запуск сбора приносит
-- одну и ту же первую страницу выдачи, и после дедупа не остаётся ничего.

create table if not exists source_cursors (
  source     text not null,            -- 'loc' | 'bundesarchiv' | ...
  query      text not null,            -- запрос/категория из config
  cursor     int  not null default 0,  -- страница (loc) или смещение (commons)
  updated_at timestamptz default now(),
  primary key (source, query)
);
