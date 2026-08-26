import Anthropic from "@anthropic-ai/sdk";
import { betaTool } from "@anthropic-ai/sdk/helpers/beta/json-schema";
import {
  appendBlocks,
  createPageComment,
  fetchBlockTree,
  replyToDiscussion,
  updateBlockText,
} from "./notion.js";
import { blocksToMarkdown, markdownToBlocks } from "./markdown.js";

const anthropic = new Anthropic();

const SYSTEM_PROMPT = `You are an assistant embedded in the user's Notion workspace. You are
summoned when someone addresses you in a comment on a Notion page. You act on that one page.

The page is given to you as one line per block in the form "[<blockId>] <text>", with children
indented. The bracketed ids are real Notion block ids — use them when a tool asks for a block id.

How to work:
- Your primary duty is to answer the comment that summoned you, in its thread, via
  reply_to_comment. Always reply to the thread — even if you also edit the page.
- Only edit the page (append_blocks, update_block) when the comment asks for a change to the
  page's content. For questions, observations, or review requests, reply in the thread instead.
- update_block replaces a single block's text wholesale — re-state the full new text.
- append_blocks accepts plain markdown (headings, bullets, numbered lists, quotes, code fences)
  and inserts after a given block, or at the end of the page if no block id is given.
- Be concise. Comment replies should read like a sharp colleague's reply, not a report.
- If the request is ambiguous or would require destroying content, say so in the thread and ask
  rather than guessing.`;

export interface AgentRunInput {
  pageId: string;
  pageTitle: string;
  pageMarkdown: string;
  threadContext: string;
  triggerText: string;
  triggerAuthor: string;
  triggerDiscussionId: string;
}

export async function runAgent(input: AgentRunInput): Promise<void> {
  let repliedToThread = false;

  const tools = [
    betaTool({
      name: "reply_to_comment",
      description:
        "Reply in a Notion comment thread. Use the discussion id of the thread that summoned you unless replying to a different thread shown in the context.",
      inputSchema: {
        type: "object",
        properties: {
          discussion_id: { type: "string", description: "The discussion id of the thread" },
          text: { type: "string", description: "Plain-text reply" },
        },
        required: ["discussion_id", "text"],
        additionalProperties: false,
      },
      run: async ({ discussion_id, text }: { discussion_id: string; text: string }) => {
        await replyToDiscussion(discussion_id, text);
        if (discussion_id === input.triggerDiscussionId) repliedToThread = true;
        return "Reply posted.";
      },
    }),
    betaTool({
      name: "append_blocks",
      description:
        "Append new content to the page as Notion blocks. Accepts plain markdown. Optionally insert after a specific top-level block id; otherwise appends at the end of the page.",
      inputSchema: {
        type: "object",
        properties: {
          markdown: { type: "string", description: "Markdown content to insert" },
          after_block_id: {
            type: "string",
            description: "Optional top-level block id to insert after",
          },
        },
        required: ["markdown"],
        additionalProperties: false,
      },
      run: async ({ markdown, after_block_id }: { markdown: string; after_block_id?: string }) => {
        const blocks = markdownToBlocks(markdown);
        if (blocks.length === 0) return "No content to insert.";
        await appendBlocks(input.pageId, blocks, after_block_id);
        return `Inserted ${blocks.length} block(s).`;
      },
    }),
    betaTool({
      name: "update_block",
      description:
        "Replace the text of one existing block (paragraph, heading, list item, quote, to-do, toggle, or callout). The new text fully replaces the old.",
      inputSchema: {
        type: "object",
        properties: {
          block_id: { type: "string", description: "The block id from the page listing" },
          text: { type: "string", description: "The complete new text for the block" },
        },
        required: ["block_id", "text"],
        additionalProperties: false,
      },
      run: async ({ block_id, text }: { block_id: string; text: string }) => {
        await updateBlockText(block_id, text);
        return "Block updated.";
      },
    }),
    betaTool({
      name: "comment_on_page",
      description:
        "Start a NEW top-level comment thread on the page. Prefer reply_to_comment for responding to the thread that summoned you.",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string", description: "Plain-text comment" },
        },
        required: ["text"],
        additionalProperties: false,
      },
      run: async ({ text }: { text: string }) => {
        await createPageComment(input.pageId, text);
        return "Comment posted.";
      },
    }),
    betaTool({
      name: "refetch_page",
      description: "Re-fetch the page's current blocks (use after editing, or if a quote seems stale).",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      run: async () => {
        const tree = await fetchBlockTree(input.pageId);
        return blocksToMarkdown(tree) || "(the page is empty)";
      },
    }),
  ];

  const prompt = [
    `Page: "${input.pageTitle}" (id: ${input.pageId})`,
    ``,
    `Page contents:`,
    input.pageMarkdown || "(the page is empty)",
    ``,
    `Comment threads on this page:`,
    input.threadContext,
    ``,
    `You were summoned by ${input.triggerAuthor} in discussion ${input.triggerDiscussionId}:`,
    `"${input.triggerText}"`,
    ``,
    `Handle this request now.`,
  ].join("\n");

  const finalMessage = await anthropic.beta.messages.toolRunner({
    model: "claude-opus-5",
    max_tokens: 16000,
    system: SYSTEM_PROMPT,
    tools,
    messages: [{ role: "user", content: prompt }],
    max_iterations: 25,
  });

  if (!repliedToThread) {
    const text = finalMessage.content
      .filter((b): b is Extract<(typeof finalMessage.content)[number], { type: "text" }> => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    await replyToDiscussion(
      input.triggerDiscussionId,
      text || "I looked at this but wasn't able to produce a response. Please try rephrasing.",
    );
  }
}
