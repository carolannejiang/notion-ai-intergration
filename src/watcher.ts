import fs from "node:fs";
import type { CommentObjectResponse } from "@notionhq/client/build/src/api-endpoints.js";
import { config } from "./config.js";
import {
  allBlockIds,
  fetchBlockTree,
  getBotUserId,
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

export interface Watcher {
  botId: string;
  seen: Set<string>;
  /** True when there was no state file — existing comments must be indexed silently first. */
  freshState: boolean;
}

export async function createWatcher(): Promise<Watcher> {
  const botId = await getBotUserId();
  let state: State | null = null;
  try {
    state = JSON.parse(fs.readFileSync(config.stateFile, "utf8")) as State;
  } catch {
    // no state file yet
  }
  return {
    botId,
    seen: new Set<string>(state?.seenCommentIds ?? []),
    freshState: state === null,
  };
}

export function persist(watcher: Watcher): void {
  const ids = [...watcher.seen].slice(-5000);
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

/**
 * Fetch one page's comments, diff against seen ids, and run the agent on any
 * new triggering comment. With respond=false, new comments are indexed silently.
 */
export async function checkPage(
  watcher: Watcher,
  page: WatchPage,
  respond: boolean,
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

  const fresh = comments.filter((c) => !watcher.seen.has(c.id));
  for (const c of comments) watcher.seen.add(c.id);
  if (!respond) return;

  const triggered = fresh.filter(
    (c) => c.created_by.id !== watcher.botId && isTriggered(c, watcher.botId),
  );
  for (const comment of triggered) {
    const author = await userName(comment.created_by.id);
    console.log(
      `[agent] triggered on "${page.title}" by ${author}: ${plainText(comment.rich_text)}`,
    );
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
