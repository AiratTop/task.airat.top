# PLAN.md

Order of work for v2. Architecture and behaviour are in `SPEC.md`; this file says what is
built when, and what "done" means for each phase.

A phase starts only when the previous one is merged and deployed. Each phase ends with a
deploy that the owner checks by hand against its exit criteria.

**Branch flow.** Until Phase 1a is done, work is committed to `main` directly (there is no CI
yet to protect it with). At the end of Phase 1a the owner enables branch protection on
`main` (pull request + required `ci` check); from then on every change is a pull request,
merged once its checks are green. Pushing to `main` deploys to production from Phase 1a on.

---

## 1. Operator actions

Things only the owner can do. Ticked items are done.

```text
[x] @airat_task_bot created
[x] BotFather: domain set to task.airat.top
[x] BotFather → Login Widget: redirect https://task.airat.top/auth/telegram/callback
[x] BotFather: commands /start /today /list /app /help /delete_me
    (the Phase 4 script replaces them with localised descriptions)
[x] BotFather: Mini App URL https://task.airat.top/app
    (serves the v1 page until Phase 5; the setup script sets the same URL, idempotently)
[x] BotFather: privacy policy URL https://privacy.airat.top
    (the page covers the bot only after Phase 6 — acceptable while access is restricted)
[x] BotFather → Access: Restrict bot usage on, allowed users: the owner
    (switched off together with ACCESS_MODE=open, SPEC §3.6)
[x] Owner's Telegram user id for ALLOWED_TELEGRAM_IDS: 1657755761
[x] Cloudflare: Workers Builds disconnected from the repository
[x] GitHub: CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN (Workers Scripts:Edit, D1:Edit)
[x] .dev.vars with TELEGRAM_BOT_TOKEN, TELEGRAM_CLIENT_ID, TELEGRAM_CLIENT_SECRET
[ ] Phase 0: real voice samples (.ogg, RU and EN, up to 60 s) in spikes/samples/
[ ] Phase 0: one OIDC sign-in in a browser for the claims check (steps in Phase 0)
[ ] Phase 0: a daily money limit for Workers AI, to set the global AI ceiling (SPEC §9.4)
[ ] End of Phase 1a: branch protection on main (PR + required `ci` check)
[ ] Phase 2: a Cloudflare budget alert, if not already set on the account
```

Done by the agent with the owner's standing approval for this project:

- creating the D1 database `task-airat`;
- `wrangler secret put` for the Worker secrets, values taken from `.dev.vars` and piped,
  never printed; `TELEGRAM_WEBHOOK_SECRET` generated and set the same way. `.dev.vars` is a
  git-ignored local file, never part of the repository; once the secrets are in Cloudflare it
  keeps only what local development and the setup script need;
- running the Telegram setup script (`setWebhook`, commands, descriptions, menu button).

**Current state, until Phase 1a ships.** Nothing deploys on push (Workers Builds is
disconnected and `deploy.yml` does not exist yet). The live site is v1 with AI inert.
`README.md` and `AGENTS.md` carry a notice that they describe v1.

---

## 2. Phase 0 — Verify assumptions

No production code. Throwaway scripts under `spikes/` (not deployed); results recorded in
this section, and SPEC updated wherever a result changes it.

```text
[ ] Whisper (@cf/openai/whisper-large-v3-turbo) accepts Telegram OGG/Opus as sent;
    if not, which Workers AI ASR model does; RU and EN quality on the real samples
[ ] LLM for interpretation: compare 2–3 Workers AI models on 20 RU/EN messages
    (create, several tasks, subtasks, "I finished X and Y", a subtask, an ambiguous
    match, a question); pick by schema adherence, accuracy, latency, neuron cost
[ ] full bot path timed on a 60-second voice message: download → transcription →
    interpretation → writes → reply; p95 recorded against the 20-second criterion
    (SPEC §10.3)
[ ] neuron cost per voice message and per text message → per-user quotas and the
    global ceiling (SPEC §9.4)
[ ] Telegram OIDC: ID token claims with `openid profile telegram:bot_access`; `id` is
    the numeric Telegram user id and differs from `sub`; whether `telegram:bot_access`
    shows as granted; which hosts serve `picture` (CSP img-src)
[ ] Mini App SDK: @telegram-apps/sdk vs an in-repo shim (size, licence, works without
    the telegram.org script). Validation against a real launch happens in Phase 5
```

**How the OIDC check runs without a deployed callback.** A local script prints an
authorization URL with a fresh PKCE pair. The owner opens it and signs in. Telegram
redirects to the production callback, which does not exist yet, so the page is a 404 — but
the `code` is in the address bar. The owner pastes that URL back. The script exchanges the
code using `.dev.vars` and prints the claim **names** and value **types**, not the values.
The code is single-use and expires in minutes.

**Exit:** every box ticked with a one-line result here.

---

## 3. Phase 1a — A safe, self-contained build

Goal: the live site stops depending on anything removed or external, and deploys through
Actions. No restructuring yet.

```text
[ ] remove @google/genai, express, @types/express, dotenv, tsx, metadata.json,
    the vite `define` of GEMINI_API_KEY, AI Studio comments, .env.example
[ ] remove the AI buttons' calls (AI returns in Phase 3) and browser SpeechRecognition
    (SPEC §11.1)
[ ] fonts self-hosted; no request leaves the origin (checked in the browser network panel)
[ ] dependencies updated; `npm audit --audit-level=high` passes
[ ] package name and scripts (dev, build, test, typecheck, lint); Node version pinned
[ ] ci.yml and deploy.yml (static deploy for now), actions pinned by SHA
[ ] README and AGENTS.md: v1 notice replaced with the current state and a pointer to SPEC
```

**Exit:** deployed through Actions; the site works as v1 minus AI and the microphone; the
network panel shows only same-origin requests; audit clean. → Owner enables branch
protection.

---

## 4. Phase 1b — Structure and domain

```text
[ ] split src/App.tsx into components/, hooks/, domain/, storage/
[ ] src/domain: rules of SPEC §5.3 (including the v1 behaviours it corrects: rename
    keeps tags; subtask add/delete updates parent completion), limits (§5.5), ordering
    keys (§5.4)
[ ] TaskRepository interface; LocalTaskRepository over `task_airat_v2` (SPEC §7.2)
[ ] v1 data notice with JSON download and dismiss (SPEC §1.2)
[ ] local storage robustness (SPEC §11.1)
[ ] export in the v2 format
[ ] unit tests for all of the above
```

**Exit:** guest mode behaves as SPEC §5.3 and §11.1 describe; a v1 browser sees the notice
once; tests green.

---

## 5. Phase 1c — Localisation

```text
[ ] message catalogues en / ru; every user-facing string moved out of components
[ ] language resolution for guests (SPEC §4: browser, then en); a language switcher
[ ] dates and numbers formatted with Intl for the active language
```

**Exit:** the whole guest UI works in both languages; no hard-coded strings (checked by a
test that renders with a pseudo-locale).

---

## 6. Phase 2 — Worker, D1, sign-in, API, sync

```text
[ ] wrangler.jsonc: main; assets with binding ASSETS, run_worker_first: true,
    single-page-application fallback (so /app serves the SPA); D1, DO, AI, cron,
    observability; ACCESS_MODE=allowlist, ALLOWED_TELEGRAM_IDS=1657755761
[ ] migrations/0001_init.sql per SPEC §5.1
[ ] router, problem+json errors, request id, security headers on every response
    (SPEC §12), rate limiter DO
[ ] Telegram OIDC (SPEC §3.2), sessions (§3.5), allowlist (§3.6)
[ ] /api/me, tasks, subtasks, move, versions, ETag/304
[ ] actions and undo for deletes (SPEC §8)
[ ] import with the four outcomes and batching, export (SPEC §7.2)
[ ] RemoteTaskRepository: sequential mutation queue, refetch on failure, polling
    (SPEC §7.1, §7.3); signed-in mode in the UI; import prompt
[ ] language and time-zone resolution for accounts (SPEC §4)
[ ] deploy.yml: migrations before deploy; /health with telegram = not_configured
[ ] Worker integration and actions tests (SPEC §16)
```

**Exit:** the owner signs in on task.airat.top, imports guest tasks (a second import only
skips), sees the same tasks in a second browser within 30 seconds, undoes a delete; a
non-allowlisted account gets the beta page; security headers present on `/` and `/app`.

---

## 7. Phase 3 — AI on the web

```text
[ ] Workers AI client with the models chosen in Phase 0
[ ] /ai/tags and /ai/decompose: version-checked (SPEC §9.3), `test` rule, actions
    ai_tags / ai_decompose with undo
[ ] per-user and global quota DOs (SPEC §9.4), localised "limit reached"
[ ] AI contract tests
```

**Exit:** auto-tags and decomposition work signed in and can be undone; an edit made while
AI runs is never overwritten; guest mode makes no AI calls.

---

## 8. Phase 4 — The bot

```text
[ ] /telegram/webhook: secret check, idempotency, waitUntil, routing (SPEC §10.3)
[ ] commands /start /today /list /app /help /delete_me, localised
[ ] interpreter context (SPEC §9.1) and operations (§9.2), including clarify buttons
[ ] text and voice → operations → reply with Undo / Open app; transcript quoted
[ ] resend de-duplication (10 minutes, same normalised title)
[ ] "Done" buttons, pagination edited in place, delete confirmation
[ ] my_chat_member → can_message
[ ] scripts/telegram-setup: setWebhook (secret, allowed_updates), setMyCommands,
    setMyName/Description/ShortDescription for en and ru, setChatMenuButton
[ ] /health telegram component live
[ ] bot tests on fake updates (SPEC §16)
```

**Exit:** the owner creates tasks by text and voice, closes a task and a subtask by voice,
resolves an ambiguous "done" with a button, undoes an AI action, uses /today and /list.

---

## 9. Phase 5 — Mini App

```text
[ ] /app entry, launch params, initData exchange, bearer session
[ ] initData validated against real launches (not only test fixtures)
[ ] Telegram theme, BackButton, HapticFeedback, safe areas
[ ] time zone sent on launch; bot /today offers "set time zone" → Mini App
[ ] frame-ancestors / CSP for /app verified in Telegram iOS, Android, Desktop, Web
```

**Exit:** the menu button opens the app inside Telegram with the owner's tasks, matching
the web app; works on iOS and Android.

---

## 10. Phase 6 — Documentation and privacy

```text
[ ] privacy.airat.top: server-side data, Workers AI processing, transcripts in the
    chat, retention, deletion (operator: Armenian sole proprietor — wording confirmed
    by the owner)
[ ] README, AGENTS.md, llms.txt final
[ ] workspace /Users/airat/dev/AGENTS.md: task.airat.top entry updated
```

**Exit:** documents match the deployed behaviour. Only then may `ACCESS_MODE=open` be set
and BotFather's usage restriction switched off.

---

## 11. After v2

In priority order: reminders and morning digest → AI due dates → time tracking. Each gets
its own SPEC section before code.
