-- Настройки, которые редакторы меняют из бота (перекрывают config.yaml).
-- Пока единственный ключ: publish_times — массив "HH:MM" по Москве.
create table if not exists settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);
