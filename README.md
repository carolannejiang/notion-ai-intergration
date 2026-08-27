# notion-agent

A Claude agent that lives in your Notion comments. Summon it by writing a comment
starting with `/agent` (configurable) on any watched page — it reads the page and
the comment threads, replies in-thread, and can edit or append page content when
asked.

It works by **polling** the Notion API, so it needs no public URL or webhook —
run it on a laptop or any small box.

## Setup

### 1. Create a Notion integration (you must do this in the browser)

1. Go to https://www.notion.so/my-integrations → **New integration**.
2. Pick your workspace; type: **Internal**.
3. Under **Capabilities**, enable:
   - Read content, Update content, Insert content
   - Read comments, Insert comments
   - Read user information (name only is fine)
4. Copy the **Internal Integration Secret**.

### 2. Share the pages you want the agent on

On each page: `•••` menu → **Connections** → add your integration.
Sub-pages inherit access. The agent can only ever see pages you connect.

### 3. Configure

```sh
cp .env.example .env
# fill in NOTION_TOKEN
```

The agent runs on Claude via the **Claude Agent SDK**: if you're logged into
Claude Code with a Pro/Max subscription, leave `ANTHROPIC_API_KEY` unset and
usage draws from your subscription. Set `ANTHROPIC_API_KEY` to bill the
Anthropic API instead. `AGENT_MODEL` picks the model (`opus`, `sonnet`,
`haiku`, or a full model id; blank = your Claude Code default).

Optional settings in `.env`:

- `WATCH_PAGE_IDS` — comma-separated page IDs to watch (the 32-char hex ID from
  the page URL). If empty, the agent auto-discovers the most recently edited
  pages shared with the integration (`MAX_DISCOVERED_PAGES`, default 5).
- `AGENT_TRIGGER` — the summoning phrase (default `/agent`).
- `POLL_INTERVAL_MS` — poll cadence (default 60s).

### 4. Run

```sh
npm install
npm start
```

The first run indexes existing comments without responding (so it doesn't answer
old comments); from the next poll on, any **new** comment starting with the
trigger phrase gets a response.

## Usage

Write a comment anywhere on a watched page — inline on a text selection or in the
page-level comment box:

> `/agent summarize the meeting notes above into 3 bullets and add them under "Summary"`

> `/agent does the plan in this section conflict with the timeline at the top?`

The agent replies in the same thread; if the comment asked for a change, it also
edits the page (replacing a block's text or inserting new markdown blocks).

## How it works

- Poller (`src/index.ts`): every interval, fetch each watched page's block tree,
  list comments on the page and every block (inline comments attach to blocks),
  and diff against `.state.json`. New comments matching the trigger (and not
  authored by the bot itself) start an agent run.
- Agent (`src/agent.ts`): a Claude Agent SDK run with in-process MCP tools —
  `reply_to_comment`, `append_blocks`, `update_block`, `comment_on_page`,
  `refetch_page` — and everything else (shell, files, web) disallowed. If the
  model doesn't reply in-thread itself, its final text is posted as the reply
  so a summons never goes unanswered.
- Notion layer (`src/notion.ts`, `src/markdown.ts`): rate-limited (~3 req/s)
  wrappers; blocks render to one line per block as `[<blockId>] <text>` so the
  model can address specific blocks; agent-written markdown converts back to
  Notion blocks (headings, lists, quotes, code fences).

## Limitations

- Polling cost is O(blocks) per page per cycle — keep the watched set small
  (a handful of medium pages). Latency is up to one poll interval.
- Comments API can't create *new* inline comments anchored to text; the agent
  replies to existing threads and posts page-level comments only.
- No tracked suggestions — edits apply directly (the agent is prompted to prefer
  replying over editing unless the comment asks for a change).
- Tables are readable (rendered as rows) but not editable; databases and synced
  blocks are read as placeholders. Replies and page edits support inline
  markdown (bold, italic, code, strikethrough, links).
- Block nesting is only fetched 4 levels deep; comments on blocks nested deeper
  are never seen, so a summons there gets no reply.

## Webhook mode (instant responses)

`npm run webhook` starts an HTTP server (port `WEBHOOK_PORT`, default 8787)
that reacts to Notion `comment.created` events instead of polling:

1. Expose the port publicly, e.g. `cloudflared tunnel --url http://localhost:8787`
   (or ngrok). Note the HTTPS URL it prints.
2. In the integration settings (notion.so/my-integrations → your integration →
   **Webhooks**), create a subscription pointing at that URL and select the
   `comment.created` event.
3. Notion POSTs a `verification_token` — the server prints it; paste it into
   the verification field in the integration settings. Also put it in
   `NOTION_WEBHOOK_SECRET` in `.env` and restart to enable signature checks.

On each event the server re-checks just the affected page, so responses start
within seconds instead of a poll interval. The `.state.json` dedupe is shared
with the poller — run one mode at a time.
