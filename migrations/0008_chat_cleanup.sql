-- Автоочистка чата редакторов: служебные ответы бота (/status, /queue,
-- подтверждения) помечаются временем смерти, публикатор их удаляет.
-- Карточки кандидатов сюда не попадают - они живут до решения редактора.
create table if not exists chat_cleanup (
  chat_id      bigint not null,
  message_id   bigint not null,
  delete_after timestamptz not null,
  primary key (chat_id, message_id)
);

create index if not exists chat_cleanup_due_idx on chat_cleanup (delete_after);

alter table if exists chat_cleanup enable row level security;
