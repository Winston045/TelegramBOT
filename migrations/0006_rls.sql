-- Защита REST-доступа: без RLS любые таблицы читаются и пишутся анонимным
-- ключом проекта через PostgREST. Политик не создаём - бот ходит сервисным
-- ключом (service_role), который RLS обходит; анонимному доступу - отказ.
alter table if exists candidates enable row level security;
alter table if exists seen_hashes enable row level security;
alter table if exists heartbeats enable row level security;
alter table if exists source_cursors enable row level security;
alter table if exists settings enable row level security;
