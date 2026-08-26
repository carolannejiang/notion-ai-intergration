import type { BlockObjectResponse, RichTextItemResponse } from "@notionhq/client/build/src/api-endpoints.js";
import { plainText, type BlockNode } from "./notion.js";

function blockText(block: BlockObjectResponse): string {
  const data = (block as unknown as Record<string, { rich_text?: RichTextItemResponse[] }>)[
    block.type
  ];
  if (data?.rich_text) return plainText(data.rich_text);
  if (block.type === "child_page") return `(sub-page: ${block.child_page.title})`;
  if (block.type === "divider") return "---";
  if (block.type === "image") return "(image)";
  if (block.type === "table") return "(table)";
  return `(unsupported block type: ${block.type})`;
}

function blockPrefix(block: BlockObjectResponse): string {
  switch (block.type) {
    case "heading_1":
      return "# ";
    case "heading_2":
      return "## ";
    case "heading_3":
      return "### ";
    case "bulleted_list_item":
    case "toggle":
      return "- ";
    case "numbered_list_item":
      return "1. ";
    case "quote":
      return "> ";
    case "to_do":
      return block.to_do.checked ? "[x] " : "[ ] ";
    case "code":
      return "```: ";
    default:
      return "";
  }
}

/**
 * One line per block: `[<blockId>] <text>`, children indented two spaces.
 * The bracketed id is what the agent passes to update_block / append_blocks.
 */
export function blocksToMarkdown(nodes: BlockNode[], indent = ""): string {
  const lines: string[] = [];
  for (const node of nodes) {
    lines.push(`${indent}[${node.block.id}] ${blockPrefix(node.block)}${blockText(node.block)}`);
    if (node.children.length) {
      lines.push(blocksToMarkdown(node.children, indent + "  "));
    }
  }
  return lines.join("\n");
}

function richText(content: string) {
  const chunks: Array<{ type: "text"; text: { content: string } }> = [];
  for (let i = 0; i < content.length; i += 1900) {
    chunks.push({ type: "text", text: { content: content.slice(i, i + 1900) } });
  }
  return chunks.length ? chunks : [{ type: "text" as const, text: { content: "" } }];
}

function textBlock(type: string, content: string): object {
  return { object: "block", type, [type]: { rich_text: richText(content) } };
}

/** Plain markdown (headings, bullets, numbered lists, quotes, code fences) → Notion blocks. */
export function markdownToBlocks(markdown: string): object[] {
  const blocks: object[] = [];
  const lines = markdown.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") {
      i++;
      continue;
    }
    if (line.startsWith("```")) {
      const language = line.slice(3).trim() || "plain text";
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) {
        code.push(lines[i]);
        i++;
      }
      i++;
      blocks.push({
        object: "block",
        type: "code",
        code: { rich_text: richText(code.join("\n")), language },
      });
      continue;
    }
    if (line.startsWith("### ")) blocks.push(textBlock("heading_3", line.slice(4)));
    else if (line.startsWith("## ")) blocks.push(textBlock("heading_2", line.slice(3)));
    else if (line.startsWith("# ")) blocks.push(textBlock("heading_1", line.slice(2)));
    else if (/^\s*[-*] /.test(line))
      blocks.push(textBlock("bulleted_list_item", line.replace(/^\s*[-*] /, "")));
    else if (/^\s*\d+[.)] /.test(line))
      blocks.push(textBlock("numbered_list_item", line.replace(/^\s*\d+[.)] /, "")));
    else if (line.startsWith("> ")) blocks.push(textBlock("quote", line.slice(2)));
    else if (line.trim() === "---") blocks.push({ object: "block", type: "divider", divider: {} });
    else {
      const paragraph: string[] = [line];
      while (i + 1 < lines.length && lines[i + 1].trim() !== "" && !/^(#|```|[-*] |\d+[.)] |> )/.test(lines[i + 1].trim())) {
        paragraph.push(lines[i + 1]);
        i++;
      }
      blocks.push(textBlock("paragraph", paragraph.join("\n")));
    }
    i++;
  }
  return blocks;
}
