# SPEC.md

Specification for `task.airat.top` v2: a task manager with three surfaces — the web app, a
Telegram Mini App and the Telegram bot `@airat_task_bot` — running entirely on Cloudflare.

This document is the source of truth for architecture and behaviour. The order of work lives
in `PLAN.md`. A divergence between the code and this document is either a bug or an edit to
this document that was never made; it is never silent.

Requirement words: **MUST** is required for v2; **SHOULD** is the default unless there is a
written reason; **LATER** is out of scope for v2 and recorded so the schema does not block it.

---

## 1. Purpose and scope

v1 is a local-first, browser-only task manager. Tasks live in `localStorage`, AI features
called Gemini directly from the browser with a key compiled into the bundle (the key has been
revoked).

v2 keeps that app and adds:

- an account, signed in with Telegram;
- tasks stored in D1 and shared across the web app, the Mini App and the bot;
- a bot that turns text and voice messages into tasks, subtasks and tags, and closes tasks
  it is told are done;
- AI on Workers AI, called only from the server, only for signed-in users.

**The bar.** The bot and the Mini App should feel like something Telegram itself could have
shipped: fast, quiet, native controls, no chat spam, every action reversible. Quality of the
interaction matters more than the number of features.

### 1.1. Principles

1. **Multi-user from the first migration.** Every row belongs to a user; every query is scoped
   by `user_id`. There is no "single owner" shortcut anywhere in the code.
2. **Guest mode stays.** Without signing in, the web app works exactly as v1: local, offline,
   no network calls, no AI.
3. **Cloudflare only.** Worker + static assets, D1, Durable Objects, Workers AI, Cron Triggers.
   No external services in the request path.
4. **AI only behind sign-in.** No anonymous endpoint spends AI quota.
5. **English first.** Code, comments, docs, commit messages and the default UI language are
   English. The UI and the bot are localised into `en` and `ru`.
6. **No third-party scripts.** The page carries no analytics and loads no script from another
   origin. The Mini App SDK is bundled, not loaded from `telegram.org`.
7. **Every destructive or AI-made change is undoable** — the existing 3-second undo in the
   UI, an "Undo" button on the bot's replies.

---

## 2. Surfaces

| Surface | URL / entry | Auth | AI |
|---|---|---|---|
| Web, guest | `https://task.airat.top/` | none | no |
| Web, signed in | `https://task.airat.top/` | Telegram OIDC → session cookie | yes |
| Mini App | `https://task.airat.top/app` | `initData` → bearer token | yes |
| Bot | `@airat_task_bot`, webhook `POST /telegram/webhook` | webhook secret + `from.id` | yes |

The web app and the Mini App are one React build. `/app` is the same SPA, started in
Mini App mode (Telegram theme, Telegram controls, bearer auth).

---

## 3. Identity and access

### 3.1. One account per Telegram user

**MUST.** The account key is the numeric Telegram user id, stored as `users.telegram_id`
(unique). All three entry points resolve to it:

| Entry | Where the Telegram user id comes from |
|---|---|
| OIDC | the `id` claim of the ID token (`profile` scope) |
| Mini App | `user.id` inside validated `initData` |
| Bot | `message.from.id` / `callback_query.from.id` of a verified webhook update |

**MUST NOT use OIDC `sub` as the Telegram id.** Telegram's documentation shows `sub` and `id`
as different values. `sub` is stored as `users.oidc_sub` for reference only.

### 3.2. Web sign-in: Telegram OIDC

- Authorization Code flow with PKCE (`S256`), `state` for CSRF, `nonce` bound to the session
  that started the flow.
- Endpoints from `https://oauth.telegram.org/.well-known/openid-configuration`:
  `/auth`, `/token`, `/.well-known/jwks.json`. Issuer `https://oauth.telegram.org`.
- `client_id` is the bot id (`TELEGRAM_CLIENT_ID`); the token request uses HTTP Basic with
  `TELEGRAM_CLIENT_ID:TELEGRAM_CLIENT_SECRET`.
- Scopes: `openid profile telegram:bot_access`. `telegram:bot_access` lets the bot message a
  user who signed in on the web but never opened the bot (needed for reminders, §14). `phone`
  is not requested.
- Signing algorithm stays at Telegram's default `RS256`: per the docs `EdDSA` and `ES256K`
  reject the `profile` scope.
- The ID token is verified against the JWKS (cached), with `iss`, `aud` (= bot id), `exp`,
  `iat` and `nonce` checked.
- Redirect URI: `https://task.airat.top/auth/telegram/callback` (registered in BotFather).
- PKCE verifier, `state` and `nonce` live in `auth_states` for at most 10 minutes and are
  single-use.

### 3.3. Mini App sign-in: `initData`

- The Mini App sends the raw `initData` string to `POST /api/auth/miniapp`.
- Validation: data-check-string = every field except `hash`, sorted by key, `key=value`
  joined by `\n`; `secret_key = HMAC_SHA256(key = "WebAppData", message = bot_token)`;
  `hex(HMAC_SHA256(key = secret_key, message = data_check_string)) == hash`, compared in
  constant time.
- `auth_date` MUST be no older than 1 hour.
- The response is a bearer token (§3.5). The Mini App keeps it in memory and
  `sessionStorage`; cookies are not relied on inside Telegram WebViews.

### 3.4. Bot

- **MUST verify `X-Telegram-Bot-Api-Secret-Token`** against `TELEGRAM_WEBHOOK_SECRET` in
  constant time **before reading the body.** An unverified update is a claim to anybody's
  account.
- Only private chats are handled in v2. Updates from groups and channels are acknowledged
  and ignored.

### 3.5. Sessions

- A session token is 32 random bytes, base64url. Only its SHA-256 digest is stored.
- Web: cookie `__Host-session`, `HttpOnly; Secure; SameSite=Lax; Path=/`, 30 days, sliding.
- Mini App: `Authorization: Bearer <token>`, 24 hours, re-issued from `initData` on launch.
- **Mutating API requests with a cookie session MUST carry a same-origin `Origin` header.**
  Bearer requests are exempt (they are not sent automatically by a browser).
- Sign-out deletes the session row. Account deletion deletes all of them.

### 3.6. Access mode (private beta)

**MUST.** While `ACCESS_MODE=allowlist`, only Telegram ids listed in `ALLOWED_TELEGRAM_IDS`
(comma-separated, a Worker var) may sign in or use the bot. Everyone else:

- web / Mini App: a localised "private beta" page; no user row is created;
- bot: one short localised reply saying the bot is in private beta, including the sender's
  Telegram id (so the operator can add a tester), and nothing else is stored.

`ACCESS_MODE=open` removes the check. The rest of the system MUST NOT depend on the mode.

**Two layers, on purpose.** BotFather's *Restrict bot usage* is also enabled for the private
beta, so Telegram itself keeps other users away from the bot. It is not a substitute for the
Worker check: it is configured outside the repository, can be switched off by hand, and does
not obviously cover OIDC sign-in on the web. The Worker check stays authoritative; the
BotFather setting is switched off together with `ACCESS_MODE=open`.

---

## 4. What we know about a user, and from where

Telegram does not give everything; the browser gives some of the rest. Each field has one
resolution order.

| Field | OIDC token | Bot update | Mini App | Browser | Stored |
|---|---|---|---|---|---|
| Telegram id | `id` | `from.id` | `user.id` | — | `telegram_id` |
| Name | `name`, `given_name`, `family_name` | `first_name`, `last_name` | `first_name`, `last_name` | — | `first_name`, `last_name` |
| Username | `preferred_username` | `username` | `username` | — | `username` |
| Photo | `picture` | — (Bot API call) | `photo_url` | — | `photo_url` |
| Language | — | `language_code` | `language_code` | `navigator.languages` | `language` |
| Time zone | — | — | via `Intl` in the WebView | `Intl.DateTimeFormat().resolvedOptions().timeZone` | `time_zone` |
| Theme | — | — | `colorScheme`, `themeParams` | `prefers-color-scheme` | not stored |
| Can be messaged | `telegram:bot_access` granted | has started the bot | `allows_write_to_pm` | — | `can_message` |

**Language** — `users.language` ∈ {`en`, `ru`}:
1. explicit user choice (settings, or `/start` menu in the bot);
2. Telegram `language_code` (`ru*` → `ru`, anything else → `en`);
3. browser `navigator.languages` (web only);
4. `en`.

Telegram's `language_code` reflects the app's UI language and may be absent. Profile fields
other than an explicit choice are refreshed on each sign-in and each update; an explicit
choice is never overwritten (`language_source = 'user'`).

**Time zone** — an IANA name in `users.time_zone`:
1. explicit user choice;
2. the browser / Mini App `Intl` value, sent on every sign-in and on launch;
3. `UTC`.

Telegram exposes no time zone anywhere. A bot-only user therefore starts at `UTC`; `/today`
states which time zone it used and offers a button that opens the Mini App, which sets the
time zone from `Intl` automatically. `request.cf.timezone` MUST NOT be used for the bot: the
webhook request comes from Telegram's servers, not from the user.

---

## 5. Data model (D1)

All ids are UUIDv7 strings unless noted. Times are integer milliseconds since the epoch, UTC.
Dates without time (`due_date`) are `YYYY-MM-DD` strings interpreted in the user's time zone.

```sql
users (
  id              TEXT PRIMARY KEY,
  telegram_id     INTEGER NOT NULL UNIQUE,
  oidc_sub        TEXT UNIQUE,
  first_name      TEXT NOT NULL,
  last_name       TEXT,
  username        TEXT,
  photo_url       TEXT,
  language        TEXT NOT NULL DEFAULT 'en' CHECK (language IN ('en','ru')),
  language_source TEXT NOT NULL DEFAULT 'auto' CHECK (language_source IN ('auto','user')),
  time_zone       TEXT NOT NULL DEFAULT 'UTC',
  tz_source       TEXT NOT NULL DEFAULT 'auto' CHECK (tz_source IN ('auto','user')),
  can_message     INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
)

sessions (
  token_hash   TEXT PRIMARY KEY,           -- SHA-256 hex of the token
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN ('web','miniapp')),
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL
)

auth_states (
  state        TEXT PRIMARY KEY,
  code_verifier TEXT NOT NULL,
  nonce        TEXT NOT NULL,
  return_to    TEXT NOT NULL,              -- a same-origin path, validated
  expires_at   INTEGER NOT NULL
)

tasks (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  description   TEXT,
  completed     INTEGER NOT NULL DEFAULT 0,
  priority      TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high')),
  due_date      TEXT,
  tags          TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags)),
  position      INTEGER NOT NULL,
  is_decomposed INTEGER NOT NULL DEFAULT 0,
  source        TEXT NOT NULL DEFAULT 'web' CHECK (source IN ('web','miniapp','bot','import')),
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  completed_at  INTEGER,
  deleted_at    INTEGER                    -- soft delete; purged after 30 days
)
-- index (user_id, deleted_at, completed, position)
-- index (user_id, due_date) WHERE deleted_at IS NULL AND completed = 0

subtasks (
  id           TEXT PRIMARY KEY,
  task_id      TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  completed    INTEGER NOT NULL DEFAULT 0,
  position     INTEGER NOT NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
)

telegram_updates (
  update_id    INTEGER PRIMARY KEY,         -- idempotency; no content stored
  received_at  INTEGER NOT NULL
)

bot_actions (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  inverse      TEXT NOT NULL CHECK (json_valid(inverse)),  -- operations that undo it
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,            -- 24 hours
  undone_at    INTEGER
)
```

Rules:

- **Every query on `tasks`, `subtasks` and `bot_actions` filters by `user_id`.** A task id
  from a client or from a model is never trusted on its own.
- `subtasks.user_id` is denormalised on purpose so the ownership check is one `WHERE`.
- D1 has no interactive transactions. Multi-row changes go through `db.batch()`; invariants
  are expressed in `WHERE` clauses, not read-then-write.
- D1 allows 100 bound parameters per statement. Bulk operations (import, reorder) are chunked.
- Migrations are forward-only. An incompatible change is expand → migrate → contract across
  releases.
- **LATER, kept possible:** time tracking adds a `time_entries (task_id, user_id, started_at,
  ended_at, source)` table; reminders add `reminder_at` / a `reminders` table. Neither needs a
  change to the tables above.

### 5.1. Limits

| Item | Limit |
|---|---|
| Open + completed tasks per user (not deleted) | 2,000 |
| Task title | 1–500 characters |
| Task description | 5,000 characters |
| Subtasks per task | 50 |
| Subtask title | 1–300 characters |
| Tags per task / tag length | 10 / 32 characters, lowercase kebab-case |
| API request body | 256 KB (import), 16 KB (everything else) |
| Voice message | 120 seconds and 2 MB, checked from the update before downloading |
| Text message to the bot | 2,000 characters |

---

## 6. HTTP API

JSON over HTTPS. Errors are `application/problem+json` (RFC 9457) with a stable `type`
(`https://task.airat.top/errors/<code>`), `title`, `status`, and an `X-Request-Id` header.

```text
GET    /auth/telegram/start?return_to=/        → 302 to oauth.telegram.org
GET    /auth/telegram/callback                 → sets cookie, 302 to return_to
POST   /auth/logout
POST   /api/auth/miniapp                       { initData, timeZone } → { token, expiresAt }

GET    /api/me                                 → profile, language, time zone
PATCH  /api/me                                 { language?, timeZone? }
DELETE /api/me                                 → deletes the account and all data

GET    /api/tasks                              → all non-deleted tasks with subtasks
POST   /api/tasks                              { id?, title, ... }
PATCH  /api/tasks/:id                          partial update
DELETE /api/tasks/:id                          soft delete
POST   /api/tasks/:id/restore                  undo a delete
PUT    /api/tasks/order                        { ids: [...] }

POST   /api/tasks/:id/subtasks                 { id?, title }
PATCH  /api/tasks/:id/subtasks/:sid
DELETE /api/tasks/:id/subtasks/:sid
PUT    /api/tasks/:id/subtasks/order           { ids: [...] }

POST   /api/tasks/:id/ai/tags                  → suggested tags, applied
POST   /api/tasks/:id/ai/decompose             → subtasks, applied

POST   /api/import                             { tasks: [...] } v1 export / localStorage shape
GET    /api/export                             → same shape as the v1 JSON export

POST   /telegram/webhook                       Telegram only
GET    /health
```

- Clients MAY supply a UUIDv7 `id` on create; the server rejects an id that exists for
  another user. This keeps local ids stable through import and optimistic UI.
- Responses that carry user data are `Cache-Control: no-store`.

---

## 7. Sync model (signed-in clients)

- The server is the source of truth. The client applies changes optimistically and rolls
  back on error.
- The client refetches `GET /api/tasks` on start, on `visibilitychange` to visible, and after
  the bot reports an action when opened from it.
- Concurrent edits: last write wins per request. Acceptable for one person on a few devices;
  revisited only if it causes real loss.
- No offline queue while signed in (LATER). Guest mode remains fully offline.

### 7.1. Guest → account

- On first sign-in, if `localStorage` holds tasks, the app asks: "Move N tasks to your
  account?" Nothing is uploaded without that confirmation.
- Import is idempotent by task id (`INSERT ... ON CONFLICT DO NOTHING`).
- After a successful import the local copy is kept until the user chooses to clear it.
- Existing `localStorage` records stay readable: new fields are optional or defaulted.

---

## 8. AI

All AI runs on Workers AI through the `AI` binding, server-side only.

| Job | Input | Output | Model |
|---|---|---|---|
| Transcribe | Telegram voice (OGG/Opus) | text | `@cf/openai/whisper-large-v3-turbo` (verified in Phase 0) |
| Tag | task title, description | 1–3 tags | LLM chosen in Phase 0 |
| Decompose | task title, description | 3–5 subtasks | same LLM |
| Interpret | a bot message + the user's open tasks | operations (§8.1) | same LLM |

### 8.1. Interpretation produces operations, not changes

The model returns JSON matching a strict schema. The server validates it and applies only
what passes.

```text
create_task    { title, priority?, tags?, subtasks? }
add_subtasks   { task_ref, titles[] }
set_tags       { task_ref, tags[] }
complete_task  { task_ref }
reply          { text }            -- when the message is a question, not a change
```

- `task_ref` is a short reference (`t1`, `t2`, …) to the open-task list given to the model,
  mapped back to ids by the server. The model never sees or returns real ids.
- Unknown refs, over-limit values and unknown operation types are dropped, and the reply says
  what was not applied.
- **No deletion through AI in v2.** No due dates through AI in v2 (§13).
- All applied operations of one message form one `bot_actions` row with its inverse, offered
  as an "Undo" button.
- The open-task list sent to the model is capped (most recent 100 open tasks, titles only).
- User text and transcripts are untrusted input. The prompt marks them as data; the schema
  limits what any output can do to the user's own tasks.
- A task titled exactly `test` (case-insensitive, trimmed) is never sent to AI.

### 8.2. Quotas

- Per-user daily AI budget, counted in a Durable Object keyed by user id (exact, not
  eventually consistent — the reasoning recorded in `secret.airat.top`): 200 AI calls a day,
  of which at most 50 voice transcriptions.
- When exhausted, the bot and the UI say so in the user's language; manual features keep
  working.
- Audio is never stored. Transcripts are not stored except as the tasks they produce.

---

## 9. The bot

### 9.1. What "Telegram-grade" means here

- **Quiet.** One reply per user message. Lists and confirmations are edited in place
  (`editMessageText`) rather than posting new messages.
- **Native controls.** Inline keyboards for actions, `answerCallbackQuery` on every button
  press (with a short toast where useful), the menu button opens the Mini App.
- **Feels instant.** `sendChatAction` (`typing`) while AI works; the webhook answers `200`
  immediately and does the work in `ctx.waitUntil`.
- **Readable.** `parse_mode: HTML` with every user string escaped; voice replies quote the
  transcript in an expandable blockquote; checkmarks and priority marks are consistent with
  the web app.
- **Reversible.** Every AI change carries "Undo". Destructive commands ask for confirmation.
- **Localised.** Replies, command descriptions, bot name/description/short description in
  `en` and `ru`, set through `setMyCommands` / `setMyDescription` /
  `setMyShortDescription` with `language_code`, from a script in the repository — not by
  hand in BotFather.

### 9.2. Commands

| Command | Behaviour |
|---|---|
| `/start` | Greeting in the user's language, what the bot does, a button to open the app. Deep-link payloads reserved for LATER. |
| `/today` | Overdue + due today + open high-priority tasks, in the user's time zone, which the header names. Each with a "Done" button. |
| `/list` | Open tasks, 10 per page, edited in place with ◀ ▶. |
| `/app` | A button that opens the Mini App. |
| `/help` | Commands and examples of what can be said or typed. |
| `/delete_me` | Asks for confirmation with a button; deletes the account and all data. |

Any other text or a voice message goes through interpretation (§8.1). A reply lists what was
created, completed or tagged, plus "Undo" and "Open app".

### 9.3. Webhook processing

1. Verify the secret header (§3.4); otherwise `401`, body unread.
2. `INSERT INTO telegram_updates ... ON CONFLICT DO NOTHING`; if nothing was inserted, this
   update was already handled: answer `200` and stop. Telegram retries on non-200.
3. Answer `200`; continue in `waitUntil`.
4. Access check (§3.6), upsert the user, route by command / callback / text / voice.
5. Errors after step 3 are logged (without content) and the user gets a short localised
   "Something went wrong, try again" reply.

`allowed_updates`: `message`, `callback_query`, `my_chat_member` (to keep `can_message`
current when a user blocks or unblocks the bot).

`callback_data` is at most 64 bytes: `<verb>:<id>` with compact verbs (`d` done, `u` undo,
`p` page, `x` confirm delete).

---

## 10. Mini App

- Same SPA at `/app`, opened from the menu button and from bot buttons.
- Launch parameters are read by the bundled SDK (`@telegram-apps/sdk` or a minimal in-repo
  equivalent, decided in Phase 0); `initData` is exchanged for a bearer token (§3.3).
- Theme follows `colorScheme` and `themeParams`; Telegram `BackButton` for nested views,
  `HapticFeedback` on complete/delete, safe-area insets respected.
- The Mini App sends `Intl` time zone on launch (§4).
- Guest mode does not exist in the Mini App: inside Telegram the user is always known.

---

## 11. Web app

- Guest mode: v1 behaviour, unchanged features, no AI buttons (they explain that AI needs
  sign-in).
- Signed in: same UI over the API, AI features enabled, account menu (language, time zone,
  export, sign out, delete account).
- UI strings come from message catalogues (`en`, `ru`); no hard-coded user-facing text in
  components.
- SEO metadata, social tags, `robots.txt`, `llms.txt` and site-verification tags are kept.
  No analytics.

---

## 12. Security and privacy

- Secrets: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CLIENT_SECRET`, `TELEGRAM_WEBHOOK_SECRET` are
  Worker secrets; locally in `.dev.vars` (git-ignored). Never in the repository, logs or docs.
- Logs never contain task titles, descriptions, transcripts, tokens, `initData`, ID tokens
  or names. They carry request id, user id, operation counts, durations, error codes.
- Security headers on HTML: strict CSP (self only, plus `https://oauth.telegram.org` as a
  navigation target), `frame-ancestors` allowing Telegram's web clients for `/app` only,
  `Referrer-Policy: strict-origin-when-cross-origin`, `X-Content-Type-Options: nosniff`.
- Rate limits per IP on `/auth/*` and `/api/auth/miniapp`, per user on mutating API calls,
  through the `RATE_LIMITER` Durable Object.
- Account deletion (`DELETE /api/me`, `/delete_me`) removes the user and, by cascade, all
  tasks, subtasks, sessions and bot actions, immediately.
- The privacy page (`privacy.airat.top`) is updated before `ACCESS_MODE=open`: what is stored,
  that Workers AI processes text and audio, retention, deletion.

---

## 13. Not in v2

- Due dates set by AI (manual dates stay).
- Scheduled reminders and a morning digest (the schema and `can_message` are ready).
- Time tracking ("I'm starting X", "I finished X").
- Projects as a separate entity (tags cover it for now).
- Offline queue for signed-in use; sharing; groups; recurring tasks.
- Separate staging environment and bot (§15).

## 14. LATER, designed for

- **Reminders and digest**: cron every minute or every 15 minutes, per-user local time,
  messages only users with `can_message = 1`.
- **AI due dates**: the interpreter gains `set_due_date` with relative dates resolved
  server-side in the user's time zone, never by the model.
- **Time tracking**: `time_entries`, bot phrases "starting / finished", daily summary.

---

## 15. Deployment

- One environment, production. One Worker `task-airat`, one D1 `task-airat`, one bot.
- `wrangler.jsonc` describes production. Local `wrangler dev` uses a local D1 by default;
  Workers AI has no local simulator, so tests stub it.
- GitHub Actions is the only deploy path:
  - `ci.yml` on pull requests: typecheck, lint, tests, build;
  - `deploy.yml` on push to `main`: tests → `wrangler d1 migrations apply --remote` →
    `wrangler deploy`. Actions pinned by commit SHA; `concurrency` without cancellation.
- Repository secrets: `CLOUDFLARE_API_TOKEN` (Workers Scripts:Edit, D1:Edit),
  `CLOUDFLARE_ACCOUNT_ID`.
- Telegram setup (`setWebhook`, commands, descriptions, menu button) is a script run by hand,
  reading the token from the environment, never printing it.
- Safety without staging: forward-only migrations, D1 Time Travel for point-in-time restore,
  integration tests on a local D1 before every deploy, no production `--remote` writes from a
  laptop.
- Cron (hourly): purge expired sessions and auth states, `telegram_updates` older than 7
  days, expired `bot_actions`, tasks soft-deleted more than 30 days ago.

## 16. Testing

| Level | Runs | Covers |
|---|---|---|
| Unit | Vitest (Node) | domain logic: completion linking, tags, sorting, filters, search, v1 record migration, i18n resolution, time-zone "today" |
| Worker integration | `@cloudflare/vitest-pool-workers`, local D1 | API with real migrations, auth (OIDC with a test JWKS, `initData` signed with a test token), ownership checks, limits, import/export, account deletion |
| Bot | same pool | fake updates: commands, text, voice, callbacks, duplicate `update_id`, allowlist, someone else's task id; AI and Bot API stubbed |
| AI contract | same pool | interpreter output validation: malformed JSON, unknown refs, over-limit values, forbidden operations |
| Smoke | after deploy, in CI | `/health`: D1 reachable, latest applied migration, and the Worker's own `getWebhookInfo` check (URL matches, no recent error) reported as `ok`/`degraded` without exposing details. The bot token stays a Worker secret and is not given to CI. |

A pull request is merged only with all of the above green.
