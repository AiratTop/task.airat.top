# PLAN.md

Order of work for v2. Architecture and behaviour are in `SPEC.md`; this file says what is
built when, and what "done" means for each phase.

A phase starts only when the previous one is merged and deployed. Until branch protection is
enabled, work is committed to `main` directly; once it is, each phase is one pull request.
Pushing to `main` deploys to production (from Phase 1 on).

---

## 1. Operator actions

Things only the owner can do. Ticked items are done.

```text
[x] @airat_task_bot created
[x] BotFather: domain set to task.airat.top
[x] BotFather → Login Widget: redirect https://task.airat.top/auth/telegram/callback
[x] BotFather: commands /start /today /list /app /help /delete_me
    (the Phase 4 script replaces them with localised descriptions)
[x] Cloudflare: Workers Builds disconnected from the repository
[x] GitHub: CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN (Workers Scripts:Edit, D1:Edit)
[x] .dev.vars with TELEGRAM_BOT_TOKEN, TELEGRAM_CLIENT_ID, TELEGRAM_CLIENT_SECRET
[x] Owner's Telegram user id for ALLOWED_TELEGRAM_IDS: 1657755761
[x] BotFather → Access: Restrict bot usage on, allowed users: the owner
    (switched off together with ACCESS_MODE=open, SPEC §3.6)
[ ] Phase 5: BotFather → Main Mini App / menu button URL https://task.airat.top/app
    (the script can set the menu button; Main Mini App is BotFather-only)
```

Done by the agent with the owner's standing approval for this project:

- creating the D1 database `task-airat`;
- `wrangler secret put` for the Worker secrets, values taken from `.dev.vars` and piped,
  never printed; `TELEGRAM_WEBHOOK_SECRET` generated and set the same way. `.dev.vars` is a
  git-ignored local file, never part of the repository; once the secrets are in Cloudflare it
  keeps only what local development and the setup script need;
- running the Telegram setup script (`setWebhook`, commands, descriptions, menu button).

**Note.** With Workers Builds disconnected, nothing deploys until Phase 1 adds `deploy.yml`.

---

## 2. Phase 0 — Verify assumptions

No production code. Throwaway scripts under `spikes/` (not deployed), results recorded in
this section.

```text
[ ] Whisper (@cf/openai/whisper-large-v3-turbo) accepts Telegram OGG/Opus as sent;
    if not, which Workers AI ASR model does; Russian and English quality on 5 real samples
[ ] LLM for interpretation: compare 2–3 Workers AI models on 15 RU/EN messages
    (create, multi-task, subtasks, "I finished X and Y", questions); pick by schema
    adherence, accuracy, latency, neuron cost
[ ] Telegram OIDC: ID token claims for this bot with `openid profile telegram:bot_access`;
    confirm `id` is the numeric Telegram user id and differs from `sub`
[ ] initData validation against a real launch; decide @telegram-apps/sdk vs in-repo shim
    (size, licence, works without the telegram.org script)
[ ] Workers AI pricing/limits on this account → confirm the quotas in SPEC §8.2
```

**Exit:** every box ticked with a one-line result here, and SPEC updated where a result
changed it.

---

## 3. Phase 1 — Cleanup, structure, CI

Behaviour does not change. Guest mode is the only mode.

```text
[ ] remove @google/genai, express, @types/express, dotenv, tsx, metadata.json,
    the vite `define` of GEMINI_API_KEY, AI Studio comments, .env.example
[ ] package name, scripts (dev, build, test, typecheck, lint), Node version pinned
[ ] split src/App.tsx into components/, hooks/, domain/, storage/
[ ] TaskRepository interface; LocalTaskRepository over the existing localStorage key
[ ] domain logic as pure functions with unit tests (see SPEC §16)
[ ] i18n scaffold: catalogues en/ru, language resolution, all UI strings moved
[ ] AI buttons hidden in guest mode with a "sign in to use AI" hint (wired in Phase 3)
[ ] ci.yml (PR) and deploy.yml (main → test → deploy), actions pinned by SHA
[ ] AGENTS.md rewritten for v2; README updated
```

**Exit:** the deployed site behaves as v1 minus Gemini; existing localStorage data loads;
CI green; deploy from `main` works.

---

## 4. Phase 2 — Worker, D1, sign-in, API

```text
[ ] wrangler.jsonc: main, assets (run_worker_first for /api, /auth, /telegram), D1, DO,
    AI, cron, observability; ACCESS_MODE=allowlist, ALLOWED_TELEGRAM_IDS
[ ] migrations/0001_init.sql per SPEC §5
[ ] router, problem+json errors, request id, security headers, rate limiter DO
[ ] Telegram OIDC (SPEC §3.2), sessions (§3.5), allowlist (§3.6)
[ ] /api/me, tasks, subtasks, order, import, export, account deletion
[ ] RemoteTaskRepository; signed-in mode in the UI; guest → account import prompt
[ ] language and time-zone resolution wired (SPEC §4)
[ ] deploy.yml: migrations before deploy; /health
[ ] Worker integration tests (SPEC §16)
```

**Exit:** the owner signs in on task.airat.top, imports local tasks, sees the same tasks on
a second browser; a non-allowlisted account gets the beta page; tests green.

---

## 5. Phase 3 — AI on the server

```text
[ ] Workers AI client with the models chosen in Phase 0
[ ] /ai/tags and /ai/decompose for signed-in users; `test` rule kept
[ ] per-user daily quota DO (SPEC §8.2) and localised "limit reached"
[ ] AI contract tests
```

**Exit:** auto-tags and decomposition work signed in; guest mode makes no AI calls.

---

## 6. Phase 4 — The bot

```text
[ ] /telegram/webhook: secret check, idempotency, waitUntil, routing (SPEC §9.3)
[ ] commands /start /today /list /app /help /delete_me, localised
[ ] text → interpretation → operations → reply with Undo / Open app
[ ] voice → transcription → same pipeline; transcript quoted
[ ] "Done" buttons, pagination edited in place, delete confirmation
[ ] bot_actions + Undo
[ ] my_chat_member → can_message
[ ] scripts/telegram-setup: setWebhook (secret, allowed_updates), setMyCommands,
    setMyName/Description/ShortDescription for en and ru, setChatMenuButton
[ ] bot tests on fake updates (SPEC §16)
```

**Exit:** the owner creates tasks by text and voice, closes tasks by voice, undoes an AI
action, uses /today and /list; a non-allowlisted account gets the beta reply with its id.

---

## 7. Phase 5 — Mini App

```text
[ ] /app entry, launch params, initData exchange, bearer session
[ ] Telegram theme, BackButton, HapticFeedback, safe areas
[ ] time zone sent on launch; bot /today offers "set time zone" → Mini App
[ ] frame-ancestors / CSP for /app verified in Telegram iOS, Android, Desktop, Web
```

**Exit:** the menu button opens the app inside Telegram with the owner's tasks, matching
the web app; works on iOS and Android.

---

## 8. Phase 6 — Documentation and privacy

```text
[ ] privacy.airat.top: server-side data, Workers AI processing, retention, deletion
    (operator: Armenian sole proprietor — wording confirmed by the owner)
[ ] README, AGENTS.md, llms.txt final
[ ] workspace /Users/airat/dev/AGENTS.md: task.airat.top entry updated
```

**Exit:** documents match the deployed behaviour. Only then may `ACCESS_MODE=open` be set.

---

## 9. After v2

In priority order: reminders and morning digest → AI due dates → time tracking. Each gets
its own SPEC section before code.
