import fs from "node:fs";
import type { CommentObjectResponse } from "@notionhq/client/build/src/api-endpoints.js";
import { config } from "./config.js";
import {
  allBlockIds,
  discoverPages,
  fetchBlockTree,
  getBotUserId,
  getPageTitle,
  listComments,
  plainText,
  userName,
  type WatchPage,
} from "./notion.js";
import { blocksToMarkdown } from "./markdown.js";
import { runAgent } from "./agent.js";

interface State {
  seenCommentIds: string[];
}

function loadState(): State | null {
  try {
    return JSON.parse(fs.readFileSync(config.stateFile, "utf8")) as State;
  } catch {
    return null;
  }
}

function saveState(seen: Set<string>): void {
  const ids = [...seen].slice(-5000);
  fs.writeFileSync(config.stateFile, JSON.stringify({ seenCommentIds: ids }));
}

function isTriggered(comment: CommentObjectResponse, botId: string): boolean {
  const text = plainText(comment.rich_text).trim().toLowerCase();
  if (text.startsWith(config.trigger.toLowerCase())) return true;
  return comment.rich_text.some(
    (t) => t.type === "mention" && t.mention.type === "user" && t.mention.user.id === botId,
  );
}

async function threadContext(comments: CommentObjectResponse[]): Promise<string> {
  const byDiscussion = new Map<string, CommentObjectResponse[]>();
  for (const c of comments) {
    const list = byDiscussion.get(c.discussion_id) ?? [];
    list.push(c);
    byDiscussion.set(c.discussion_id, list);
  }
  const sections: string[] = [];
  for (const [discussionId, thread] of byDiscussion) {
    thread.sort((a, b) => a.created_time.localeCompare(b.created_time));
    const lines = [`Discussion ${discussionId}:`];
    for (const c of thread) {
      const author = await userName(c.created_by.id);
      lines.push(`  ${author}: ${plainText(c.rich_text)}`);
    }
    sections.push(lines.join("\n"));
  }
  return sections.join("\n\n") || "(no comment threads)";
}

async function pollPage(
  page: WatchPage,
  botId: string,
  seen: Set<string>,
  firstRun: boolean,
): Promise<void> {
  const tree = await fetchBlockTree(page.id);
  const ids = [page.id, ...allBlockIds(tree)];

  const comments: CommentObjectResponse[] = [];
  const commentIds = new Set<string>();
  for (const id of ids) {
    for (const c of await listComments(id)) {
      if (!commentIds.has(c.id)) {
        commentIds.add(c.id);
        comments.push(c);
      }
    }
  }

  const fresh = comments.filter((c) => !seen.has(c.id));
  for (const c of comments) seen.add(c.id);
  if (firstRun) return;

  const triggered = fresh.filter((c) => c.created_by.id !== botId && isTriggered(c, botId));
  for (const comment of triggered) {
    const author = await userName(comment.created_by.id);
    console.log(`[agent] triggered on "${page.title}" by ${author}: ${plainText(comment.rich_text)}`);
    try {
      await runAgent({
        pageId: page.id,
        pageTitle: page.title,
        pageMarkdown: blocksToMarkdown(tree),
        threadContext: await threadContext(comments),
        triggerText: plainText(comment.rich_text),
        triggerAuthor: author,
        triggerDiscussionId: comment.discussion_id,
      });
      console.log(`[agent] done responding on "${page.title}"`);
    } catch (err) {
      console.error(`[agent] run failed on "${page.title}":`, err);
    }
  }
}

async function main(): Promise<void> {
  const botId = await getBotUserId();
  const state = loadState();
  const seen = new Set<string>(state?.seenCommentIds ?? []);
  let firstRun = state === null;

  console.log(
    `[agent] watching for comments starting with "${config.trigger}" ` +
      `(poll every ${config.pollIntervalMs / 1000}s)`,
  );
  if (firstRun) {
    console.log("[agent] first run: indexing existing comments without responding");
  }

  for (;;) {
    try {
      const pages: WatchPage[] = config.watchPageIds.length
        ? await Promise.all(
            config.watchPageIds.map(async (id) => ({ id, title: await getPageTitle(id) })),
          )
        : await discoverPages(config.maxDiscoveredPages);

      for (const page of pages) {
        try {
          await pollPage(page, botId, seen, firstRun);
        } catch (err) {
          console.error(`[agent] failed to poll "${page.title}":`, err);
        }
      }
      saveState(seen);
      firstRun = false;
    } catch (err) {
      console.error("[agent] poll cycle failed:", err);
    }
    await new Promise((r) => setTimeout(r, config.pollIntervalMs));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
