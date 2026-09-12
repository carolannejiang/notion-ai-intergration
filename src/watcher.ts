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
  type BlockNode,
  type WatchPage,
} from "./notion.js";
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
  const trigger = config.trigger.toLowerCase();
  if (text.startsWith(trigger)) {
    // the trigger must end the comment or be followed by a non-word character,
    // so "/agent" doesn't fire on "/agents meeting at 3"
    const rest = text.slice(trigger.length);
    if (rest === "" || /^[^\p{L}\p{N}]/u.test(rest)) return true;
  }
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

async function gatherComments(ids: string[]): Promise<CommentObjectResponse[]> {
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
  return comments;
}

/** The fresh comments (not yet seen) that should start an agent run. */
function findTriggers(
  watcher: Watcher,
  comments: CommentObjectResponse[],
): CommentObjectResponse[] {
  const fresh = comments.filter((c) => !watcher.seen.has(c.id));
  // Threads the bot has already replied in work as a continuous chat: a later
  // reply there only needs to start with "/" (any "/..." — not the full trigger
  // phrase) to run the agent. Replies without it are left alone, so people can
  // add context to the thread; the agent still sees them via threadContext on
  // the next run. Derived from the fetched comments, so it needs no state.
  const joined = new Set(
    comments.filter((c) => c.created_by.id === watcher.botId).map((c) => c.discussion_id),
  );
  const continuesChat = (c: CommentObjectResponse) =>
    joined.has(c.discussion_id) && plainText(c.rich_text).trimStart().startsWith("/");
  return fresh.filter(
    (c) =>
      c.created_by.id !== watcher.botId && (isTriggered(c, watcher.botId) || continuesChat(c)),
  );
}

async function respond(
  page: WatchPage,
  tree: BlockNode[],
  comments: CommentObjectResponse[],
  triggered: CommentObjectResponse[],
): Promise<void> {
  for (const comment of triggered) {
    const author = await userName(comment.created_by.id);
    console.log(
      `[agent] triggered on "${page.title}" by ${author}: ${plainText(comment.rich_text)}`,
    );
    try {
      await runAgent({
        pageId: page.id,
        pageTitle: page.title,
        pageTree: tree,
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

/**
 * Full sweep: fetch the page tree, list comments on the page and every block,
 * diff against seen ids, and run the agent on any new triggering comment.
 * With respond=false, new comments are indexed silently.
 */
export async function checkPage(
  watcher: Watcher,
  page: WatchPage,
  shouldRespond: boolean,
): Promise<void> {
  const tree = await fetchBlockTree(page.id);
  const comments = await gatherComments([page.id, ...allBlockIds(tree)]);
  const triggered = shouldRespond ? findTriggers(watcher, comments) : [];
  for (const c of comments) watcher.seen.add(c.id);
  if (triggered.length) await respond(page, tree, comments, triggered);
}

export interface CommentParent {
  id: string;
  type: "block" | "page";
}

const FULL_SWEEP_PHRASE = /read all comments/i;

/**
 * Fast path for a webhook event that names the new comment's parent: list only
 * that block's (or the page's) threads, and fetch the page tree only when the
 * comment actually triggers a run. The per-block comment sweep in checkPage is
 * ~20 s on a 60-block page; this is ~1 s for a non-trigger and ~3 s otherwise.
 * The agent then sees the triggering thread and page-level threads, not
 * threads on other blocks — a request containing "read all comments" gets the
 * full sweep instead.
 */
export async function checkThread(
  watcher: Watcher,
  page: WatchPage,
  parent: CommentParent,
): Promise<void> {
  const parentComments = await listComments(parent.id);
  const triggered = findTriggers(watcher, parentComments);
  if (triggered.some((c) => FULL_SWEEP_PHRASE.test(plainText(c.rich_text)))) {
    // seen ids are untouched so far, so the sweep still sees these as fresh
    return checkPage(watcher, page, true);
  }
  for (const c of parentComments) watcher.seen.add(c.id);
  if (triggered.length === 0) return;

  const tree = await fetchBlockTree(page.id);
  const comments =
    parent.type === "page"
      ? parentComments
      : [...parentComments, ...(await listComments(page.id))];
  await respond(page, tree, comments, triggered);
}
