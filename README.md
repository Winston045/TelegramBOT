# STORY | TEAM — бот-контентщик

Бот раз в сутки собирает исторические фотографии из открытых архивов
(Library of Congress, Бундесархив через Wikimedia Commons), готовит посты
в формате канала, отдаёт редакторам на отбор в групповой чат и публикует
одобренное в канал по расписанию.

Бот **не придумывает факты** — только переводит и переформатирует метаданные
источника. Полная спецификация — в [SPEC.md](SPEC.md).

## Стек

TypeScript · grammY · GitHub Actions cron · Supabase (Postgres + Edge Functions) ·
Gemini Flash. Всё бесплатное; платных сервисов в проекте нет.

**Два запрета** (см. SPEC): не привязывать карту к Google Cloud проекту с Gemini
и не хранить изображения у себя — только URL и хэш.

## Как это работает

```
GitHub Actions (cron)                      Supabase
┌──────────────────────────┐              ┌──────────────────┐
│ daily-collect (06:00 МСК)│──candidates─▶│ Postgres         │
│   collect: источники →   │              │  candidates      │
│   префильтр → dHash-дедуп│              │  seen_hashes     │
│   → Gemini скоринг →     │              │  heartbeats      │
│   подписи → валидация    │              └────────▲─────────┘
│   send-candidates: 10    │                       │
│   карточек редакторам    │              ┌────────┴─────────┐
│ publish (*/15 мин)       │              │ Edge Function    │
│   слот наступил → пост   │◀── очередь ──│ tg-webhook:      │
│   в канал + хэш в seen   │              │ /ok /skip /quote │
│ heartbeat (*/6 ч)        │              │ /queue /undo,    │
│ keepalive (раз в неделю) │              │ правки реплаем   │
└──────────────────────────┘              └──────────────────┘
```

## Запуск с нуля

### 1. Секреты

Завести (см. `.env.example`): `BOT_TOKEN`, `CHANNEL_ID`, `EDITORS_CHAT_ID`,
`EDITOR_USER_IDS`, `SUPABASE_URL`, `SUPABASE_SECRET_KEY` (формат `sb_secret_...`),
`SUPABASE_DB_URL` (только для миграций), `GEMINI_API_KEY` (AI Studio, **без карты**),
опционально `TG_WEBHOOK_SECRET`.

Всё — в GitHub Secrets (для воркфлоу) и в Supabase Edge Function secrets
(для вебхука). Бота добавить в канал админом с правом публикации и в рабочий чат.

### 2. База

Любой из трёх способов — SQL идемпотентный, повторное применение безвредно:

- **Без установки чего-либо:** Supabase Dashboard → SQL Editor → вставить
  содержимое `migrations/0001_init.sql` целиком → Run.
- **Кнопкой в GitHub:** добавить секрет `SUPABASE_DB_URL` в
  Settings → Secrets and variables → Actions, затем
  Actions → `setup-db` → Run workflow.
- **Локально:**
  ```bash
  npm install
  npm run migrate
  ```
  `SUPABASE_DB_URL` — из Dashboard → Connect → **Session pooler**
  (Direct connection работает только по IPv6).

Проверка: в Table Editor появились `candidates`, `seen_hashes`, `heartbeats`.

### 3. Бэкфилл — строго до первого сбора

```bash
npm run backfill       # проходит t.me/s/<канал>, пишет ~4400 хэшей в seen_hashes
```

Иначе первая партия кандидатов будет наполовину из уже публиковавшегося.

### 4. Вебхук

```bash
supabase functions deploy tg-webhook --no-verify-jwt
curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<project>.supabase.co/functions/v1/tg-webhook&secret_token=<TG_WEBHOOK_SECRET>"
```

### 5. Готово

Дальше всё делают кроны: `daily-collect` утром привозит карточки в чат,
редакторы отвечают на них командами, `publish` раз в 15 минут проверяет слоты.

## Порядок проверки перед боевым запуском

1. **Миграции** — `npm run migrate` против живого Supabase, в дашборде
   должны появиться `candidates`, `seen_hashes`, `heartbeats`.
2. **Бэкфилл** — `npm run backfill -- --expect 4423`. Главное — не
   «отработал», а сколько записей: скрипт сам печатает итог из базы,
   предупреждает, если не дошёл до начала канала, и падает с ошибкой
   при недоборе больше 10%.
3. **Сбор всухую** — `npm run collect -- --dry`: первый реальный контакт
   с API LoC и Commons.
4. **Gemini** — `npm run collect` на малой партии, затем
   `npm run review-captions`: метаданные и подпись рядом, сверить год,
   топонимы и цитату глазами.
5. Только после этого включать `daily-collect` (до настройки секретов
   в GitHub кроны выходят без ошибки — «запуск пропущен»).

## Команды редакторов

Работают только для `EDITOR_USER_IDS`, остальные игнорируются молча.

| Команда | Где | Что делает |
|---|---|---|
| `/ok` | реплай на кандидата | в очередь публикации |
| `/skip` | реплай на кандидата | в отказ |
| `/quote <текст>` | реплай | заменить только цитату |
| *реплай текстом* | реплай | заменить подпись целиком (форматирование телеграма сохраняется) |
| `/queue` | чат | сколько постов в очереди |
| `/undo` | чат | удалить последний опубликованный |

## Скрипты

| Команда | Что делает |
|---|---|
| `npm run migrate` | миграции из `migrations/` (идемпотентно) |
| `npm run backfill` | разовый бэкфилл хэшей архива канала (`-- --dry` — без записи) |
| `npm run collect` | сбор кандидатов целиком (`-- --dry` — только источники и префильтр) |
| `npm run send-candidates` | отправить карточки редакторам |
| `npm run publish-post` | опубликовать по слоту, если пора |
| `npm test` / `npm run typecheck` | тесты и проверка типов |

Поведение (источники, лимиты, слоты, стоп-слова, глоссарий) настраивается
в `config.yaml` — код для этого трогать не нужно.
