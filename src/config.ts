import "dotenv/config";
import { fileURLToPath } from "node:url";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function numeric(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`Env var ${name} must be a number, got "${raw}"`);
  return n;
}

export const config = {
  notionToken: required("NOTION_TOKEN"),
  model: process.env.AGENT_MODEL || undefined,
  trigger: process.env.AGENT_TRIGGER ?? "/agent",
  pollIntervalMs: numeric("POLL_INTERVAL_MS", 60_000),
  watchPageIds: (process.env.WATCH_PAGE_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  maxDiscoveredPages: numeric("MAX_DISCOVERED_PAGES", 5),
  webhookPort: numeric("WEBHOOK_PORT", numeric("PORT", 8787)),
  webhookSecret: process.env.NOTION_WEBHOOK_SECRET || undefined,
  stateFile: process.env.STATE_FILE ?? fileURLToPath(new URL("../.state.json", import.meta.url)),
};
