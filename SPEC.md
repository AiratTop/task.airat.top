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

v1 is a browser-only task manager. Tasks live in `localStorage`; AI features called Gemini
directly from the browser with a key compiled into the bundle (the key has been revoked).

v2 keeps a local guest mode and adds:

- an account, signed in with Telegram;
- tasks stored in D1 and shared across the web app, the Mini App and the bot;
- a bot that turns text and voice messages into tasks, subtasks and tags, and closes tasks
  and subtasks it is told are done;
- AI on Workers AI, called only from the server, only for signed-in users.

**The bar.** The bot and the Mini App should feel like something Telegram itself could have
shipped: fast, quiet, native controls, no chat spam, AI changes reversible. Quality of the
interaction matters more than the number of features.

### 1.1. Principles

1. **Multi-user from the first migration.** Every row belongs to a user; every query is scoped
   by `user_id`. There is no "single owner" shortcut anywhere in the code.
2. **Guest mode stays local.** Without signing in, tasks are stored only in the browser and
   the app makes no API calls and no AI calls. What "offline" means is defined in §11.1.
3. **Cloudflare only.** Worker + static assets, D1, Durable Objects, Workers AI, Cron Triggers.
   No external services in the request path.
4. **AI only behind sign-in.** No anonymous endpoint spends AI quota.
5. **English first.** Code, comments, docs, commit messages and the default UI language are
   English. The UI and the bot are localised into `en` and `ru`.
6. **No third-party requests from the page.** No analytics, no script, stylesheet or font
   from another origin. Fonts are bundled. The Mini App SDK is bundled, not loaded from
   `telegram.org`. The only cross-origin resources are Telegram profile photos (§4).
7. **Deletions and AI changes are undoable** through one action model (§8). Account deletion
   is the one deliberate exception: it is irreversible and asks for confirmation instead.

### 1.2. v1 data is not carried over

v1 was a test phase. Its `localStorage` data (`airat_tasks_v1`, `airat_settings_v1`) is
**not** migrated, imported or read as tasks by v2.

On the first v2 start, if `airat_tasks_v1` exists, the app shows a one-time notice: the
previous version's tasks are not supported, with a "Download as JSON" button (the v1 export
format, produced from the stored string without interpretation) and a "Dismiss" button.
Dismiss removes both v1 keys. Nothing else touches them.

From v2 on, local and account data share one format (§7.2), so guest tasks can always be
moved into an account.

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

- Authorization Code flow with PKCE (`S256`), `state` and `nonce`.
- `state` is bound to the browser that started the flow: `/auth/telegram/start` sets a
  short-lived `__Host-auth_state` cookie (`HttpOnly; Secure; SameSite=Lax`, 10 minutes)
  holding the `state`, and the callback rejects a `state` that does not match it. Without
  this binding an attacker can complete a login in the victim's browser with the attacker's
  account (login CSRF).
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
  `expires_at` is extended at most once a day, so reads do not turn into writes.
- Mini App: `Authorization: Bearer <token>`, 24 hours, re-issued from `initData` on launch.
- **Mutating API requests with a cookie session MUST carry a same-origin `Origin` header.**
  Bearer requests are exempt (they are not sent automatically by a browser).
- The API is same-origin only and sends no CORS headers.
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
| Photo | `picture` | — | `photo_url` | — | `photo_url` |
| Language | — | `language_code` | `language_code` | `navigator.languages` | `language` |
| Time zone | — | — | via `Intl` in the WebView | `Intl.DateTimeFormat().resolvedOptions().timeZone` | `time_zone` |
| Theme | — | — | `colorScheme`, `themeParams` | `prefers-color-scheme` | not stored |
| Can be messaged | see below | has started the bot | `allows_write_to_pm` | — | `can_message` |

**Language** — `users.language` ∈ {`en`, `ru`}:
1. explicit user choice (settings, or `/start` menu in the bot);
2. Telegram `language_code` (`ru*` → `ru`, anything else → `en`);
3. browser `navigator.languages` (web only);
4. `en`.

Telegram's `language_code` reflects the app's UI language and may be absent. Profile fields
other than an explicit choice are refreshed on each sign-in and each update, and written only
when a value actually changed; an explicit choice is never overwritten
(`language_source = 'user'`).

**Photos** are Telegram-hosted URLs (`picture`, `photo_url`; the Mini App's may be SVG). They
are shown only through `<img>`, never inlined or fetched by the Worker, and the CSP `img-src`
allows exactly the Telegram hosts observed in Phase 0.

**`can_message`** — whether the token response or ID token shows that `telegram:bot_access`
was granted is verified in Phase 0. Until then `can_message` becomes `1` only when the user
starts the bot or the Mini App reports `allows_write_to_pm`, and `0` on a `my_chat_member`
update saying the bot was blocked.

**Time zone** — an IANA name in `users.time_zone`:
1. explicit user choice;
2. the browser / Mini App `Intl` value, sent on every sign-in and on launch;
3. `UTC`.

A submitted time zone is accepted only if `new Intl.DateTimeFormat('en', { timeZone })` accepts
it in the Worker; anything else is ignored.

Telegram exposes no time zone anywhere. A bot-only user therefore starts at `UTC`; `/today`
states which time zone it used and offers a button that opens the Mini App, which sets the
time zone from `Intl` automatically. `request.cf.timezone` MUST NOT be used for the bot: the
webhook request comes from Telegram's servers, not from the user.

---

## 5. Data model

### 5.1. Tables (D1)

Ids are UUIDv7 strings, generated by whichever side creates the record. Times are integer
milliseconds since the epoch, UTC. `due_date` is a `YYYY-MM-DD` string interpreted in the
user's time zone. `position` is a fractional-index string (§5.4).

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
  data_version    INTEGER NOT NULL DEFAULT 0,  -- bumped by every task/subtask write (§7.3)
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
)

sessions (
  token_hash   TEXT PRIMARY KEY,               -- SHA-256 hex of the token
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN ('web','miniapp')),
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL
)

auth_states (
  state         TEXT PRIMARY KEY,
  code_verifier TEXT NOT NULL,
  nonce         TEXT NOT NULL,
  return_to     TEXT NOT NULL,                 -- a same-origin path, validated
  expires_at    INTEGER NOT NULL
)

tasks (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  version       INTEGER NOT NULL DEFAULT 1,    -- +1 on every write (§5.3)
  title         TEXT NOT NULL,
  description   TEXT,
  completed     INTEGER NOT NULL DEFAULT 0,
  priority      TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high')),
  due_date      TEXT,
  tags          TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags)),
  position      TEXT NOT NULL,
  is_decomposed INTEGER NOT NULL DEFAULT 0,
  source        TEXT NOT NULL DEFAULT 'web' CHECK (source IN ('web','miniapp','bot','import')),
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  completed_at  INTEGER,
  deleted_at    INTEGER                        -- soft delete; purged after 30 days
)
-- index (user_id, deleted_at, completed, position)
-- index (user_id, due_date) WHERE deleted_at IS NULL AND completed = 0

subtasks (
  id           TEXT PRIMARY KEY,
  task_id      TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  version      INTEGER NOT NULL DEFAULT 1,
  title        TEXT NOT NULL,
  completed    INTEGER NOT NULL DEFAULT 0,
  position     TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  deleted_at   INTEGER
)

actions (                                      -- the undo log (§8)
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source       TEXT NOT NULL CHECK (source IN ('web','miniapp','bot')),
  kind         TEXT NOT NULL,                  -- delete_task, ai_tags, bot_message, ...
  inverse      TEXT NOT NULL CHECK (json_valid(inverse)),
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  undone_at    INTEGER
)

telegram_updates (
  update_id    INTEGER PRIMARY KEY,            -- idempotency; no content stored
  received_at  INTEGER NOT NULL
)
```

### 5.2. Rules

- **Every query on `tasks`, `subtasks` and `actions` filters by `user_id`.** An id from a
  client or from a model is never trusted on its own.
- `subtasks.user_id` is denormalised on purpose so the ownership check is one `WHERE`.
- D1 has no interactive transactions. Multi-row changes go through `db.batch()`; invariants
  are expressed in `WHERE` clauses, not read-then-write.
- D1 allows 100 bound parameters per statement. Bulk operations are chunked.
- Migrations are forward-only. An incompatible change is expand → migrate → contract across
  releases, so the previous Worker version always runs against the current schema (§15.3).
- **LATER, kept possible:** time tracking adds a `time_entries (task_id, user_id, started_at,
  ended_at, source)` table; reminders add `reminder_at` / a `reminders` table. Neither needs a
  change to the tables above.

### 5.3. Domain rules — one module, enforced on every write path

The rules live in `src/domain/` and are imported by both the client and the Worker. The
server enforces them on every path — API, import, bot, AI — so the client's optimistic
result and the stored result cannot diverge.

**Completion.** For a task with at least one non-deleted subtask:
- completing the task completes all its subtasks;
- reopening the task leaves subtasks as they are;
- after any subtask change (complete, reopen, add, delete, restore): if every remaining
  subtask is completed, the task is completed; if any is open, the task is open. So adding an
  open subtask to a completed task reopens it, and deleting the last open subtask completes
  it.

A task without subtasks is completed and reopened only directly.

**Tags.** Normalised to lowercase kebab-case, deduplicated, capped (§5.5). Renaming a task
never clears or changes its tags; AI tags are applied as described in §9.3.

**Versions and timestamps.** Every write to a task or subtask increments its `version`, sets
`updated_at`, and increments `users.data_version` in the same batch. Completion sets or
clears `completed_at`. `version`, not `updated_at`, is what conflict checks compare:
milliseconds are not unique.

### 5.4. Ordering

`position` is a fractional-index string (`fractional-indexing`, MIT). Moving an item computes
one new key between its neighbours, so a move is one row written and one small request,
whatever the list length. If keys grow past 64 characters, the server rewrites that user's
positions in chunks; clients only ever send "move X before/after Y".

### 5.5. Limits

The same limits are enforced by the shared domain module in guest mode, so local data can
always be moved into an account without truncation.

| Item | Limit |
|---|---|
| Tasks per user (not deleted) | 2,000 |
| Task title | 1–500 characters |
| Task description | 5,000 characters |
| Subtasks per task | 50 |
| Subtask title | 1–300 characters |
| Tags per task / tag length | 10 / 32 characters, lowercase kebab-case |
| Request body: import batch | 512 KB (§7.2) |
| Request body: anything else | 64 KB |
| Voice message | 60 seconds and 1 MB, checked from the update before downloading |
| Text message to the bot | 2,000 characters |

A single task at its limits is about 60 KB as JSON in the worst case (Cyrillic, escaping), so
any valid task fits one import batch.

---

## 6. HTTP API

JSON over HTTPS. Errors on `/api/*` are `application/problem+json` (RFC 9457) with a stable
`type` (`https://task.airat.top/errors/<code>`), `title`, `status`, and an `X-Request-Id`
header. `/auth/*` routes are browser navigations: their errors are a small localised HTML page
with a link back, not JSON.

```text
GET    /auth/telegram/start?return_to=/        → 302 to oauth.telegram.org
GET    /auth/telegram/callback                 → sets cookie, 302 to return_to
POST   /auth/logout
POST   /api/auth/miniapp                       { initData, timeZone } → { token, expiresAt }

GET    /api/me                                 → profile, language, time zone
PATCH  /api/me                                 { language?, timeZone? }
DELETE /api/me                                 → deletes the account and all data

GET    /api/tasks                              → all non-deleted tasks with subtasks; ETag
POST   /api/tasks                              { id, title, ... }
PATCH  /api/tasks/:id                          { ...fields, version }
DELETE /api/tasks/:id                          soft delete → { actionId }
POST   /api/tasks/:id/move                     { before?: id, after?: id }

POST   /api/tasks/:id/subtasks                 { id, title }
PATCH  /api/tasks/:id/subtasks/:sid            { ...fields, version }
DELETE /api/tasks/:id/subtasks/:sid            soft delete → { actionId }
POST   /api/tasks/:id/subtasks/:sid/move       { before?: id, after?: id }

POST   /api/tasks/:id/ai/tags                  → { tags, actionId }      (§9.3)
POST   /api/tasks/:id/ai/decompose             → { subtasks, actionId }

POST   /api/actions/:id/undo                   → { applied, skipped }    (§8)

POST   /api/import                             one batch (§7.2) → report
GET    /api/export                             → the v2 local format (§7.2)

POST   /telegram/webhook                       Telegram only
GET    /health
```

- Clients supply the UUIDv7 `id` on create, which keeps optimistic UI simple. An id that
  already exists is rejected with `409 id-conflict`.
- `PATCH` carries the `version` the client last saw. The write is applied as last-write-wins
  (§7.1), but the response tells the client whether the server version had moved on.
- Responses that carry user data are `Cache-Control: no-store` (`ETag` still works with
  `If-None-Match`).

---

## 7. Sync model (signed-in clients)

### 7.1. Writes

- The server is the source of truth. The client applies changes optimistically.
- **The client sends mutations one at a time, in the order the user made them.** A queue
  per client; the next request starts when the previous one answered.
- On a failed mutation the client drops the rest of the queue, refetches the authoritative
  state, and tells the user how many changes were not saved. It does not try to roll back
  individual optimistic steps.
- Concurrent edits from different devices: last write wins per field set by the request.
  Acceptable for one person on a few devices; revisited only if it causes real loss.
- AI writes are the exception: they are version-checked (§9.3).

### 7.2. Local format, export and import

- Guest mode stores tasks under `task_airat_v2` as `{ formatVersion: 2, tasks: [...] }`,
  the same task and subtask shape as the API (ids UUIDv7, `position` keys, limits enforced).
- Export (`GET /api/export`, and the guest export button) produces the same document.
- Import moves guest tasks into an account after an explicit confirmation ("Move N tasks to
  your account?"). Nothing is uploaded without it.
- **Batches.** The client packs tasks with their subtasks into batches of at most 100 tasks
  and 512 KB, and sends them sequentially.
- **Per task, the server answers one of:**
  - `imported` — new id, written;
  - `skipped` — the id already exists in this account (a repeated import); the account copy
    is kept unchanged;
  - `reassigned` — the id exists in another account (the same local copy imported into two
    accounts); the task is written under a new id, which the report returns;
  - `rejected` — fails validation, with the reason. Nothing is truncated or silently altered.
- The client shows the totals of all four. Import is safe to repeat: a second run only
  skips.
- After a fully successful import the local copy is kept until the user chooses to clear it.
- A new account with nothing to import starts empty, with a localised empty state that
  explains the web app, the bot and voice. The demo task is a guest-mode feature, as in v1.

### 7.3. Freshness

- `GET /api/tasks` returns `ETag: "<data_version>"`. With `If-None-Match` an unchanged list is
  a `304`, cheap enough to poll.
- The client refetches on start, on `visibilitychange` to visible, and every 30 seconds while
  visible. A task created through the bot appears in an open app within about 30 seconds.
- No realtime channel in v2 (LATER: a Durable Object with WebSocket hibernation, if polling
  proves insufficient).

---

## 8. Actions and undo

One model covers every undoable change, on every surface.

| Kind | Source | Undo window offered | Inverse |
|---|---|---|---|
| `delete_task` | web, Mini App | 3-second toast | restore the task (and its subtasks) |
| `delete_subtask` | web, Mini App | 3-second toast | restore the subtask |
| `ai_tags` | web, Mini App | 3-second toast | previous tags |
| `ai_decompose` | web, Mini App | 3-second toast | soft-delete the created subtasks |
| `bot_message` | bot | "Undo" button, 24 hours | the inverse of every operation applied |

Manual edits (rename, priority, date, manual tags, manual completion) are not actions: they
are reversed by editing again, as in v1.

**Rules.**
- An action and the changes it records are written in one `db.batch()`.
- The inverse of each step records the `version` the step left on its row.
- Undo **claims** the action first (`UPDATE actions SET undone_at = ? WHERE id = ? AND
  user_id = ? AND undone_at IS NULL AND expires_at > ?`). If nothing was claimed, it was
  already undone or has expired: the answer says so and nothing changes. A second Undo is
  therefore harmless.
- The inverse steps then run in one batch, each conditioned on `version` still being the
  recorded one. Steps whose row has changed since are **skipped**, not forced, and reported
  (`{ applied, skipped }`). If the batch itself fails, the claim is released.
- Undoing a created task soft-deletes it only if neither the task nor any of its subtasks has
  changed since and no subtask was added; otherwise that task is skipped.
- `expires_at`: 24 hours for every kind. The UI offers the button for 3 seconds; the server
  window is longer so a slow request is never refused.

---

## 9. AI

All AI runs on Workers AI through the `AI` binding, server-side only.

| Job | Input | Output | Model |
|---|---|---|---|
| Transcribe | Telegram voice (OGG/Opus) | text | `@cf/openai/whisper-large-v3-turbo` (verified in Phase 0) |
| Tag | task title, description | 1–3 tags | LLM chosen in Phase 0 |
| Decompose | task title, description | 3–5 subtasks | same LLM |
| Interpret | a bot message + context (§9.1) | operations (§9.2) | same LLM |

A task titled exactly `test` (case-insensitive, trimmed) is never sent to AI: not tagged,
not decomposed, and not included in the interpreter's context.

### 9.1. Interpreter context

The model receives the user's text as data, plus a context built by the server:

```text
today: 2026-11-23 (Europe/Moscow), language: ru
tasks:
  t1  "Prepare the quarterly report"      [tags: work]
      s1  "Collect numbers"   (open)
      s2  "Draft"             (done)
  t2  "Call the bank"
  ...
```

- Refs (`t1`, `t1.s2`) are assigned per request and mapped back to ids by the server. The
  model never sees or returns real ids.
- **Which tasks are included:** all open tasks if there are at most 100; otherwise the 60
  most recently updated open tasks plus up to 40 more found by a server-side search for the
  words of the message in task and subtask titles. Open subtasks of included tasks are listed.
- The context says how many open tasks were left out. If the message refers to something
  not in the context, the model answers with `clarify` (§9.2), and the bot says it did not
  find the task and offers "Open app".

### 9.2. Operations

The model returns JSON matching a strict schema. The server validates it and applies only
what passes.

```text
create_task       { title, priority?, tags?, subtasks?[] }
add_subtasks      { task: "t1", titles[] }
set_tags          { task: "t1", tags[] }
complete_task     { task: "t1" }
complete_subtask  { subtask: "t1.s2" }
clarify           { question, candidates: ["t1", "t3", "t1.s2", ...] }
reply             { text }          -- a question about the tasks, or nothing to change
```

- `complete_task` / `complete_subtask` only for an unambiguous match. When several items
  could match, the model returns `clarify` with the candidates; the bot shows one button per
  candidate, and pressing one completes it (as a `bot_message` action).
- Unknown refs, over-limit values and unknown operation types are dropped; the reply says what
  was not applied.
- **No deletion through AI in v2. No due dates through AI in v2** (§13).
- All operations applied for one message form one `bot_message` action (§8).
- User text and transcripts are untrusted input. The prompt marks them as data; the schema
  limits what any output can do, and only to the user's own tasks.

### 9.3. AI on the web is version-checked

Tagging and decomposition can take seconds. When the result arrives, the server applies it
only if the task's `version` is still the one the job read (`WHERE version = ?`). If the user
changed the task meanwhile, the result is not applied and is returned as a suggestion the UI
can offer. AI never overwrites a newer manual edit.

AI tagging runs on create and when the title changes; it replaces only tags that AI added
before and the user did not edit (tracked per tag in the action's inverse), never manual
tags.

### 9.4. Quotas and cost

- Counted per user in a Durable Object keyed by user id (exact, not eventually consistent —
  the reasoning is recorded in `secret.airat.top`). The day is the user's local day.
- Every model invocation counts, including ones that fail. There are no automatic retries of
  AI calls. A voice message costs two calls (transcription + interpretation).
- Per user per day: 200 calls, of which at most 50 transcriptions.
- **Project-wide ceiling:** a single global Durable Object counts all calls per UTC day; at
  the ceiling (set in Phase 0 from measured neuron cost, against a daily money limit) AI is
  paused for everyone until the next day. A Cloudflare budget alert is the outer guard.
- When a limit is hit, the bot and the UI say so in the user's language; manual features keep
  working.

---

## 10. The bot

### 10.1. What "Telegram-grade" means here

- **Quiet.** One reply per user message. Lists and confirmations are edited in place
  (`editMessageText`) rather than posting new messages.
- **Native controls.** Inline keyboards for actions, `answerCallbackQuery` on every button
  press (with a short toast where useful), the menu button opens the Mini App.
- **Feels instant.** `sendChatAction` (`typing`) while AI works; the webhook answers `200`
  immediately and does the work in `ctx.waitUntil`.
- **Readable.** `parse_mode: HTML` with every user string escaped; voice replies quote the
  transcript in an expandable blockquote; checkmarks and priority marks are consistent with
  the web app. Every message stays under Telegram's 4,096-character limit.
- **Reversible.** Every AI change carries "Undo". `/delete_me` asks for confirmation.
- **Localised.** Replies, command descriptions, bot name/description/short description in
  `en` and `ru`, set through `setMyCommands` / `setMyDescription` /
  `setMyShortDescription` with `language_code`, from a script in the repository — not by
  hand in BotFather.

### 10.2. Commands

| Command | Behaviour |
|---|---|
| `/start` | Greeting in the user's language, what the bot does, a button to open the app. Deep-link payloads reserved for LATER. |
| `/today` | Overdue + due today + open high-priority tasks, in the user's time zone, which the header names. Up to 20 tasks, each with a "Done" button; more are reached through "Open app". |
| `/list` | Open tasks, 10 per page, edited in place with ◀ ▶. |
| `/app` | A button that opens the Mini App. |
| `/help` | Commands and examples of what can be said or typed. |
| `/delete_me` | Asks for confirmation with a button; deletes the account and all data. |

Any other text or a voice message goes through interpretation (§9). A reply lists what was
created, completed or tagged, plus "Undo" and "Open app".

Only `voice` messages are transcribed. Audio files, video notes, photos, stickers and
documents get a short localised hint saying what the bot understands.

### 10.3. Webhook processing

1. Verify the secret header (§3.4); otherwise `401`, body unread.
2. `INSERT INTO telegram_updates ... ON CONFLICT DO NOTHING`; if nothing was inserted, this
   update was already handled: answer `200` and stop.
3. Answer `200`; continue in `waitUntil`.
4. Access check (§3.6), upsert the user, route by command / callback / text / voice.
5. Apply operations, then send the reply.

**Delivery guarantees, stated.**
- **At most once per update.** An update is recorded before processing, so Telegram never
  causes it to be processed twice. The price: if processing dies after step 3, Telegram does
  not retry it.
- **Failure notice is best effort.** On a caught error the user gets a short localised
  "Something went wrong, try again". If the Worker is terminated mid-way, no notice is
  possible; the user sees no reply and resends.
- **Resending does not duplicate.** A resent message is a new update, so `update_id` does not
  catch it. Instead, `create_task` is skipped when the same user has an open task with the
  same normalised title created by the bot in the last 10 minutes; the reply says "already
  added".
- **Time budget.** `waitUntil` work has at most 30 seconds after the response. The full path
  — download, transcription, interpretation, writes, reply — is measured in Phase 0 on a
  60-second voice message. **Move to a Queue consumer** (and change this section first) if
  the measured p95 exceeds 20 seconds, or if any timeout is observed in production.

`allowed_updates`: `message`, `callback_query`, `my_chat_member` (to keep `can_message`
current when a user blocks or unblocks the bot).

`callback_data` is at most 64 bytes: `<verb>:<id>` with compact verbs (`d` done, `u` undo,
`p` page, `c` clarify choice, `x` confirm delete).

---

## 11. Web app and Mini App

### 11.1. Guest mode and what "offline" means

| Property | v2 guest mode |
|---|---|
| Tasks stored only in this browser | yes |
| No network calls while using the app | yes — no API, no AI, no fonts or scripts from elsewhere |
| An already-open page keeps working without a network | yes |
| Cold start without a network | no (no service worker in v2; LATER) |

Browser speech recognition (`SpeechRecognition`) is **removed**: some browsers send the audio
to their vendor's service, which contradicts the guest-mode promise, and its quality varies.
Voice input in v2 is the bot. (LATER: in-app recording sent to the same Workers AI pipeline,
for signed-in users.)

Robustness of local storage:
- reads and writes are wrapped; a failed write (quota, private mode) is reported in the UI;
- unparseable stored data is moved aside to `task_airat_v2_corrupt_<timestamp>` and the app
  starts empty with a notice, rather than failing to load;
- transient UI state (in-flight AI flags, drag state) is never persisted.

### 11.2. Signed in

Same UI over the API, AI features enabled, account menu (language, time zone, export, sign
out, delete account). In guest mode AI buttons are visible but explain that AI needs sign-in.

### 11.3. Mini App

- Same SPA at `/app`, opened from the menu button and from bot buttons.
- Launch parameters are read by the bundled SDK (`@telegram-apps/sdk` or a minimal in-repo
  equivalent, decided in Phase 0); `initData` is exchanged for a bearer token (§3.3).
- Theme follows `colorScheme` and `themeParams`; Telegram `BackButton` for nested views,
  `HapticFeedback` on complete/delete, safe-area insets respected.
- The Mini App sends `Intl` time zone on launch (§4).
- There is no guest mode in the Mini App: inside Telegram the user is always known.

### 11.4. Common

- UI strings come from message catalogues (`en`, `ru`); no hard-coded user-facing text in
  components.
- Fonts are bundled with the build (self-hosted files), not loaded from Google Fonts.
- SEO metadata, social tags, `robots.txt`, `llms.txt` and site-verification tags are kept.
  No analytics.

---

## 12. Security and privacy

- Secrets: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CLIENT_SECRET`, `TELEGRAM_WEBHOOK_SECRET` are
  Worker secrets; locally in `.dev.vars` (git-ignored). Never in the repository, logs or docs.
- Logs never contain task titles, descriptions, transcripts, tokens, `initData`, ID tokens
  or names. They carry request id, user id, operation counts, durations, error codes.
- **Every response passes through the Worker** (`run_worker_first: true`, as in `md` and
  `secret`), which serves static files through the `ASSETS` binding and adds headers. No
  path bypasses the header middleware.
- Headers on HTML:
  - CSP: `default-src 'self'`; `script-src 'self'`; `style-src 'self'`; `font-src 'self'`;
    `connect-src 'self'`; `img-src 'self' data:` plus the Telegram photo hosts (§4);
    `form-action 'self'`; `base-uri 'none'`;
  - `frame-ancestors 'none'` everywhere except `/app`, which allows `https://web.telegram.org`
    (Telegram Web runs Mini Apps in a frame; mobile and desktop clients use a WebView);
  - `Referrer-Policy: strict-origin-when-cross-origin`, `X-Content-Type-Options: nosniff`.

  The sign-in redirect to `oauth.telegram.org` is a server `302` and needs no CSP entry.
- Rate limits per IP on `/auth/*` and `/api/auth/miniapp`, per user on mutating API calls,
  through the `RATE_LIMITER` Durable Object. The per-IP object is addressed by a hash of the
  address; raw IPs are never stored or logged.
- Account deletion (`DELETE /api/me`, `/delete_me`) removes the user and, by cascade, all
  tasks, subtasks, sessions and actions, immediately and irreversibly.
- **Audio** is downloaded from Telegram, transcribed and discarded; it is never stored.
  **Transcripts** are not stored in our database. The bot quotes the transcript in its reply,
  so it exists in the Telegram chat like any message, under Telegram's retention.
- The privacy page (`privacy.airat.top`, already linked from the bot's profile) is updated
  before `ACCESS_MODE=open`: what is stored, that Workers AI processes text and audio, the
  transcript note above, retention, deletion.

---

## 13. Not in v2

- Due dates set by AI (manual dates stay).
- Scheduled reminders and a morning digest (the schema and `can_message` are ready).
- Time tracking ("I'm starting X", "I finished X").
- Projects as a separate entity (tags cover it for now).
- Offline cold start, offline queue for signed-in use; realtime push; sharing; groups;
  recurring tasks; in-app voice recording.
- Import of v1 data (§1.2).
- Separate staging environment and bot (§15).

## 14. LATER, designed for

- **Reminders and digest**: cron every minute or every 15 minutes, per-user local time,
  messages only users with `can_message = 1`.
- **AI due dates**: the interpreter gains `set_due_date` with relative dates resolved
  server-side in the user's time zone, never by the model.
- **Time tracking**: `time_entries`, bot phrases "starting / finished", daily summary.

---

## 15. Deployment and operations

### 15.1. Environment

- One environment, production. One Worker `task-airat`, one D1 `task-airat`, one bot.
- `wrangler.jsonc` describes production. Local `wrangler dev` uses a local D1 by default.
  Workers AI has no local simulator: tests stub it, and `wrangler dev` calls the real service
  and spends the account's quota.
- `.dev.vars` holds local secrets for `wrangler dev` and the Telegram setup script. Local
  development cannot complete OIDC sign-in (the only registered redirect is production) and
  cannot receive bot updates (the webhook points at production); both are covered by tests.

### 15.2. Pipeline

- GitHub Actions is the only deploy path:
  - `ci.yml` on pull requests and on pushes to branches other than `main`: typecheck, lint,
    tests, build, `npm audit --audit-level=high`;
  - `deploy.yml` on push to `main`: the same checks → `wrangler d1 migrations apply --remote`
    → `wrangler deploy` → smoke check. Actions pinned by commit SHA; `concurrency` without
    cancellation.
- Repository secrets: `CLOUDFLARE_API_TOKEN` (Workers Scripts:Edit, D1:Edit),
  `CLOUDFLARE_ACCOUNT_ID`.
- Telegram setup (`setWebhook`, commands, descriptions, menu button) is a script run by hand,
  reading the token from the environment, never printing it.
- **Production data and schema are written only by CI** (migrations) and by the running
  Worker. One-off infrastructure setup from a laptop — creating the database, `wrangler
  secret put`, the Telegram setup script — is allowed; `wrangler d1 execute --remote` with
  anything other than a `SELECT`, and `wrangler deploy` from a laptop, are not.
- Cron (hourly): purge expired sessions and auth states, `telegram_updates` older than 7
  days, expired `actions`, tasks and subtasks soft-deleted more than 30 days ago.

### 15.3. When a release goes wrong

- **Code:** `wrangler rollback` to the previous Worker version (an operator action, from the
  dashboard or the CLI), then a fix through the normal pipeline. This is safe because
  migrations are expand-only within a release (§5.2): the previous version runs against the
  new schema.
- **Data:** D1 Time Travel restores the database to a point in time. It is a last resort —
  it also discards every write after that point — and is an operator decision.
- **Bot:** if the webhook misbehaves, `deleteWebhook` stops updates at once; Telegram keeps
  them for 24 hours, so re-setting the webhook after a fix resumes delivery.

### 15.4. Health

`GET /health` reports `ok` / `degraded` per component without exposing details:
- `db`: D1 reachable, latest applied migration matches the build;
- `telegram`: the Worker's own `getWebhookInfo` — URL matches, no error in the last hour.
  Before the bot exists (until Phase 4) this component is `not_configured`, which counts as
  healthy. The bot token stays a Worker secret and is not given to CI.

## 16. Testing

| Level | Runs | Covers |
|---|---|---|
| Unit | Vitest (Node) | domain rules (§5.3), ordering keys, limits, local format and its corruption handling, i18n resolution, time-zone "today", v1 notice |
| Worker integration | `@cloudflare/vitest-pool-workers`, local D1 | API with real migrations, auth (OIDC with a test JWKS, `initData` signed with a test token), ownership checks, limits, versions, import report (all four outcomes), export, account deletion |
| Actions | same pool | undo of every kind, double undo, expiry, skipped steps after later edits, created-task undo with changed subtasks |
| Bot | same pool | fake updates: commands, text, voice, callbacks, clarify choice, duplicate `update_id`, resent message within 10 minutes, allowlist, someone else's task id; AI and Bot API stubbed |
| AI contract | same pool | interpreter context building (caps, search, `test` exclusion), output validation (malformed JSON, unknown refs, over-limit values, forbidden operations), version-checked web AI |
| Smoke | after deploy | `/health` (§15.4) |

Unit, integration, actions, bot and AI-contract tests gate every merge and run again at the
start of every deploy. The smoke check runs after the deploy and fails the workflow run if
the deployed Worker is not healthy.
