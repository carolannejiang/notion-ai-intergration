import { Client } from "@notionhq/client";
import type {
  BlockObjectResponse,
  CommentObjectResponse,
  RichTextItemResponse,
} from "@notionhq/client/build/src/api-endpoints.js";
import { config } from "./config.js";

export const notion = new Client({ auth: config.notionToken });

const MIN_REQUEST_GAP_MS = 340;
let lastRequestAt = 0;

export async function pace(): Promise<void> {
  const now = Date.now();
  const wait = lastRequestAt + MIN_REQUEST_GAP_MS - now;
  lastRequestAt = Math.max(now, lastRequestAt + MIN_REQUEST_GAP_MS);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

export async function getBotUserId(): Promise<string> {
  await pace();
  const me = await notion.users.me({});
  return me.id;
}

export interface WatchPage {
  id: string;
  title: string;
}

export async function discoverPages(limit: number): Promise<WatchPage[]> {
  await pace();
  const res = await notion.search({
    filter: { property: "object", value: "page" },
    sort: { direction: "descending", timestamp: "last_edited_time" },
    page_size: limit,
  });
  return res.results
    .filter((r): r is Extract<typeof r, { object: "page" }> => r.object === "page")
    .map((page) => ({ id: page.id, title: pageTitle(page) }));
}

export async function getPageTitle(pageId: string): Promise<string> {
  await pace();
  const page = await notion.pages.retrieve({ page_id: pageId });
  return pageTitle(page);
}

function pageTitle(page: unknown): string {
  const props = (page as { properties?: Record<string, unknown> }).properties ?? {};
  for (const prop of Object.values(props)) {
    const p = prop as { type?: string; title?: RichTextItemResponse[] };
    if (p.type === "title" && p.title) return plainText(p.title) || "(untitled)";
  }
  return "(untitled)";
}

export function plainText(richText: RichTextItemResponse[]): string {
  return richText.map((t) => t.plain_text).join("");
}

export interface BlockNode {
  block: BlockObjectResponse;
  children: BlockNode[];
}

export async function fetchBlockTree(
  blockId: string,
  depth = 0,
): Promise<BlockNode[]> {
  if (depth > 3) return [];
  const nodes: BlockNode[] = [];
  let cursor: string | undefined;
  do {
    await pace();
    const res = await notion.blocks.children.list({
      block_id: blockId,
      start_cursor: cursor,
      page_size: 100,
    });
    for (const raw of res.results) {
      if (!("type" in raw)) continue;
      const block = raw as BlockObjectResponse;
      const children =
        block.has_children && block.type !== "child_page" && block.type !== "child_database"
          ? await fetchBlockTree(block.id, depth + 1)
          : [];
      nodes.push({ block, children });
    }
    cursor = res.next_cursor ?? undefined;
  } while (cursor);
  return nodes;
}

export function allBlockIds(nodes: BlockNode[]): string[] {
  return nodes.flatMap((n) => [n.block.id, ...allBlockIds(n.children)]);
}

export async function listComments(blockOrPageId: string): Promise<CommentObjectResponse[]> {
  const comments: CommentObjectResponse[] = [];
  let cursor: string | undefined;
  do {
    await pace();
    const res = await notion.comments.list({
      block_id: blockOrPageId,
      start_cursor: cursor,
      page_size: 100,
    });
    comments.push(...(res.results as CommentObjectResponse[]));
    cursor = res.next_cursor ?? undefined;
  } while (cursor);
  return comments;
}

const COMMENT_CHUNK = 1900;

function textChunks(text: string): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += COMMENT_CHUNK) {
    chunks.push(text.slice(i, i + COMMENT_CHUNK));
  }
  return chunks.length ? chunks : [""];
}

export function toRichText(text: string): Array<{ type: "text"; text: { content: string } }> {
  return textChunks(text).map((content) => ({ type: "text" as const, text: { content } }));
}

export async function replyToDiscussion(discussionId: string, text: string): Promise<string> {
  await pace();
  const res = await notion.comments.create({
    discussion_id: discussionId,
    rich_text: toRichText(text),
  });
  return res.id;
}

export async function createPageComment(pageId: string, text: string): Promise<string> {
  await pace();
  const res = await notion.comments.create({
    parent: { page_id: pageId },
    rich_text: toRichText(text),
  });
  return res.id;
}

export async function appendBlocks(
  pageId: string,
  children: object[],
  afterBlockId?: string,
): Promise<void> {
  for (let i = 0; i < children.length; i += 100) {
    await pace();
    await notion.blocks.children.append({
      block_id: pageId,
      children: children.slice(i, i + 100) as never,
      ...(i === 0 && afterBlockId ? { after: afterBlockId } : {}),
    });
  }
}

const TEXT_BLOCK_TYPES = new Set([
  "paragraph",
  "heading_1",
  "heading_2",
  "heading_3",
  "bulleted_list_item",
  "numbered_list_item",
  "quote",
  "to_do",
  "toggle",
  "callout",
]);

export async function updateBlockText(blockId: string, text: string): Promise<void> {
  await pace();
  const block = (await notion.blocks.retrieve({ block_id: blockId })) as BlockObjectResponse;
  if (!TEXT_BLOCK_TYPES.has(block.type)) {
    throw new Error(
      `Block ${blockId} has type "${block.type}", which does not support text replacement.`,
    );
  }
  await pace();
  await notion.blocks.update({
    block_id: blockId,
    [block.type]: { rich_text: toRichText(text) },
  } as never);
}

const userNameCache = new Map<string, string>();

export async function userName(userId: string): Promise<string> {
  const cached = userNameCache.get(userId);
  if (cached) return cached;
  let name = userId;
  try {
    await pace();
    const user = await notion.users.retrieve({ user_id: userId });
    name = user.name ?? userId;
  } catch {
    // partial access to the user is fine; fall back to the id
  }
  userNameCache.set(userId, name);
  return name;
}
