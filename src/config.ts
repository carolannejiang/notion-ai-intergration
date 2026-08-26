import "dotenv/config";
import { fileURLToPath } from "node:url";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

export const config = {
  notionToken: required("NOTION_TOKEN"),
  trigger: process.env.AGENT_TRIGGER ?? "@agent",
  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS ?? 60_000),
  watchPageIds: (process.env.WATCH_PAGE_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  maxDiscoveredPages: Number(process.env.MAX_DISCOVERED_PAGES ?? 5),
  stateFile: fileURLToPath(new URL("../.state.json", import.meta.url)),
};
