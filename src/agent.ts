import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import {
  appendBlocks,
  createPageComment,
  fetchBlockTree,
  replyToDiscussion,
  updateBlockText,
} from "./notion.js";
import { blocksToMarkdown, markdownToBlocks } from "./markdown.js";
import { config } from "./config.js";

// The Agent SDK spawns a `claude` subprocess, which refuses to start inside a
// Claude Code session; this var is only set when the poller itself was launched
// from one, so dropping it is safe.
delete process.env.CLAUDECODE;

const SYSTEM_PROMPT = `You are an assistant embedded in the user's Notion workspace. You are
summoned when someone addresses you in a comment on a Notion page. You act on that one page,
using only the notion tools provided.

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

const textResult = (text: string) => ({ content: [{ type: "text" as const, text }] });

export async function runAgent(input: AgentRunInput): Promise<void> {
  let repliedToThread = false;

  const notionServer = createSdkMcpServer({
    name: "notion",
    version: "1.0.0",
    tools: [
      tool(
        "reply_to_comment",
        "Reply in a Notion comment thread. Use the discussion id of the thread that summoned you unless replying to a different thread shown in the context.",
        {
          discussion_id: z.string().describe("The discussion id of the thread"),
          text: z.string().describe("Plain-text reply"),
        },
        async ({ discussion_id, text }) => {
          await replyToDiscussion(discussion_id, text);
          if (discussion_id === input.triggerDiscussionId) repliedToThread = true;
          return textResult("Reply posted.");
        },
      ),
      tool(
        "append_blocks",
        "Append new content to the page as Notion blocks. Accepts plain markdown. Optionally insert after a specific top-level block id; otherwise appends at the end of the page.",
        {
          markdown: z.string().describe("Markdown content to insert"),
          after_block_id: z.string().optional().describe("Optional top-level block id to insert after"),
        },
        async ({ markdown, after_block_id }) => {
          const blocks = markdownToBlocks(markdown);
          if (blocks.length === 0) return textResult("No content to insert.");
          await appendBlocks(input.pageId, blocks, after_block_id);
          return textResult(`Inserted ${blocks.length} block(s).`);
        },
      ),
      tool(
        "update_block",
        "Replace the text of one existing block (paragraph, heading, list item, quote, to-do, toggle, or callout). The new text fully replaces the old.",
        {
          block_id: z.string().describe("The block id from the page listing"),
          text: z.string().describe("The complete new text for the block"),
        },
        async ({ block_id, text }) => {
          await updateBlockText(block_id, text);
          return textResult("Block updated.");
        },
      ),
      tool(
        "comment_on_page",
        "Start a NEW top-level comment thread on the page. Prefer reply_to_comment for responding to the thread that summoned you.",
        {
          text: z.string().describe("Plain-text comment"),
        },
        async ({ text }) => {
          await createPageComment(input.pageId, text);
          return textResult("Comment posted.");
        },
      ),
      tool(
        "refetch_page",
        "Re-fetch the page's current blocks (use after editing, or if a quote seems stale).",
        {},
        async () => {
          const tree = await fetchBlockTree(input.pageId);
          return textResult(blocksToMarkdown(tree) || "(the page is empty)");
        },
      ),
    ],
  });

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

  let finalText = "";
  const run = query({
    prompt,
    options: {
      ...(config.model ? { model: config.model } : {}),
      systemPrompt: SYSTEM_PROMPT,
      mcpServers: { notion: notionServer },
      strictMcpConfig: true,
      settingSources: [],
      permissionMode: "dontAsk",
      allowedTools: [
        "mcp__notion__reply_to_comment",
        "mcp__notion__append_blocks",
        "mcp__notion__update_block",
        "mcp__notion__comment_on_page",
        "mcp__notion__refetch_page",
      ],
      disallowedTools: [
        "Task", "Bash", "Read", "Write", "Edit", "Glob", "Grep",
        "WebFetch", "WebSearch", "NotebookEdit", "TodoWrite",
      ],
      maxTurns: 25,
    },
  });

  for await (const message of run) {
    if (message.type === "result") {
      finalText = message.subtype === "success" ? message.result.trim() : "";
    }
  }

  if (!repliedToThread) {
    await replyToDiscussion(
      input.triggerDiscussionId,
      finalText || "I looked at this but wasn't able to produce a response. Please try rephrasing.",
    );
  }
}
