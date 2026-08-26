# Handoff — Notion comment agent

Written 2026-08-26, at the end of the session that built this project. Read this
first if you're picking the work back up (human or AI agent). `README.md` covers
user-facing setup; this file covers context, decisions, and state.

## Where this came from

The project is a Notion port of a feature studied in the `lightcone-commons`
codebase (LessWrong2 grant-making platform): an LLM agent embedded in
collaborative documents that users summon via `/query` blocks and that engages
with comment threads. That system runs a full Claude Code CLI in a per-conversation
Vercel Sandbox VM, with a supervisor process, a Postgres event log streamed over
SSE, and a `research-tool` CLI hitting authenticated backend routes (see
`lib/agents/` and `components/documents/lexical-plugins/agentBlock/` in that repo
if you ever need the reference architecture).

Since Notion allows no custom blocks, slash commands, or in-page UI, the port
keeps only the comment-driven loop: **user writes a trigger comment → agent reads
the page → replies in-thread → optionally edits the page**. Delivery is a local
poller instead of webhooks so no public URL is needed.

## Current state

- **Code: complete and type-checked** (`npm run tsc` passes). Deps installed.
- **Never run against a real workspace** — no live end-to-end test has happened,
  because it needs the owner's Notion integration token and page connections.
  Expect the first real run to be the actual integration test.
- Nothing is committed to git (there is no repo here; `.gitignore` is ready if
  you `git init`).

### What the owner still has to do (blockers to first run)

1. Create an internal Notion integration (capabilities: read/update/insert
   content, read/insert comments, read user info) and copy the secret.
2. Connect target pages to the integration (page `•••` → Connections).
3. `cp .env.example .env`, set `NOTION_TOKEN` and `ANTHROPIC_API_KEY`, `npm start`.

## Architecture (one paragraph per file)

- `src/index.ts` — entry point + poll loop. Each cycle: resolve watched pages
  (explicit `WATCH_PAGE_IDS` or Notion search for recently edited pages), fetch
  each page's block tree, list comments on the page id **and every block id**
  (inline comments attach to blocks; there is no workspace-wide comments
  endpoint), diff against seen ids in `.state.json`. New comments that start
  with the trigger phrase (default `@agent`, case-insensitive) or @-mention the
  bot user, and aren't authored by the bot, start an agent run. First run with
  no state file indexes everything silently (prevents answering stale comments).
  Bot-author check prevents self-trigger loops.
- `src/agent.ts` — one agent run per triggering comment. Uses
  `@anthropic-ai/sdk` beta tool runner (`client.beta.messages.toolRunner`) with
  model `claude-opus-5`, `max_tokens` 16000, `max_iterations` 25. Tools:
  `reply_to_comment`, `append_blocks`, `update_block`, `comment_on_page`,
  `refetch_page` — all defined with `betaTool` (raw JSON schema, no zod).
  A closure flag tracks whether the trigger thread got a reply; if not, the
  model's final text is posted there as a fallback so a summons is never
  silently dropped.
- `src/notion.ts` — Notion client wrappers. Global rate limiter (`pace()`,
  ~340ms min gap ≈ Notion's 3 req/s average limit). Block tree fetch is
  recursive, depth-capped at 3, skips descending into child pages/databases.
  `updateBlockText` only accepts text-bearing block types and replaces
  `rich_text` wholesale. All rich text is chunked at 1900 chars (Notion caps
  2000 per item). `appendBlocks` batches 100 children per request and passes
  `after` only on the first batch.
- `src/markdown.ts` — two-way conversion. Blocks → one line per block in the
  form `[<blockId>] <prefix><text>`, children indented; the bracketed id is how
  the model addresses blocks in tool calls. Markdown → blocks supports
  headings, bullets, numbered lists, quotes, code fences, dividers, paragraphs
  (multi-line merged). Tables/images/databases render as placeholders and are
  not writable.
- `src/config.ts` — env loading; fails loud on missing `NOTION_TOKEN`.
  `ANTHROPIC_API_KEY` is resolved by the Anthropic SDK itself (env var or
  `ant auth login` profile), so it isn't validated here.

## Decisions made and why (don't relitigate without reason)

- **Polling, not webhooks** — zero-infra personal setup; no public HTTPS
  endpoint or tunnel required. Cost: O(blocks) comment-list calls per page per
  cycle and up-to-one-interval latency. Acceptable for a handful of pages.
- **Trigger phrase, not bot mention only** — Notion's comment composer doesn't
  reliably let you @-mention an integration bot, so prefix matching on
  `@agent` is the primary trigger; a real user-mention of the bot id also
  works if it ever occurs.
- **`@notionhq/client` pinned to ^2.2.15** (installed 2.3.0) — v5.x of the SDK
  reshuffled database endpoints; nothing here needs it. Note the deep type
  import must keep its `.js` suffix
  (`@notionhq/client/build/src/api-endpoints.js`) — required by NodeNext
  module resolution; removing it breaks the typecheck.
- **`claude-opus-5`** per current API guidance (don't downgrade for cost
  without the owner asking).
- **Plain-text replies and edits** — no rich-text formatting in comments,
  markdown subset for blocks. Simplicity over fidelity; extend in
  `markdown.ts` if needed.

## Known limitations / sharp edges

- Notion's API cannot create *new* inline (text-anchored) comment threads —
  only replies to existing discussions and page-level comments. This is an API
  limit, not a bug here.
- Edits apply directly; there is no suggestion/tracked-change mechanism in
  Notion's API.
- Watching many or very large pages will blow the poll budget (each block is a
  comments.list call). Keep to ~5 medium pages or raise `POLL_INTERVAL_MS`.
- Comment resolution: `comments.list` only returns **unresolved** comments, so
  resolving a thread in the Notion UI effectively retires it from the agent's
  view (and its ids drop out of context — harmless, since seen-ids persist).
- `.state.json` caps at 5000 seen ids (FIFO trim). Fine in practice; a
  workspace with >5000 live unresolved comments could re-trigger on ancient
  ones after trim.

## Natural next steps (none started)

1. **First live run** against the owner's workspace; fix whatever the real API
   surface disagrees about (most likely candidates: comment `parent` shapes,
   block types not in the markdown map).
2. **Webhook mode** — integration settings → webhook subscription for
   `comment.created` → small HTTPS handler calling the existing `runAgent()`.
   Poller and agent are already decoupled for exactly this.
3. Conversation memory: currently each summons is a fresh agent run with the
   page + threads as context. The thread itself carries history, which is
   usually enough; if runs need cross-summons state, persist per-discussion
   transcripts.
4. Richer rendering: inline bold/links in replies, table read support.

## Verification commands

```sh
npm run tsc     # must pass clean
npm start       # needs .env; first run only indexes, second+ responds
```
