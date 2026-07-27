-- Перенос времени публикации: пост из очереди можно запланировать
-- на конкретный слот, публикатор уважает это время.

alter table candidates add column if not exists scheduled_at timestamptz;
