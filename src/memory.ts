import type { RichTextItemResponse } from "@notionhq/client/build/src/api-endpoints.js";
import { config } from "./config.js";
import { appendBlocks, deleteBlock, fetchBlockTree, plainText } from "./notion.js";
import { inlineToRichText } from "./richtext.js";

// Cross-run memory (B2): a designated Notion page the agent appends bullets
// to and re-reads on every run. Visible and editable by the owner, and it
// survives deploys, unlike anything on the machine's disk.

interface Note {
  id: string;
  text: string;
}

async function listNotes(): Promise<Note[]> {
  const tree = await fetchBlockTree(config.memoryPageId!);
  const notes: Note[] = [];
  for (const { block } of tree) {
    const data = (block as unknown as Record<string, { rich_text?: RichTextItemResponse[] }>)[
      block.type
    ];
    const text = data?.rich_text ? plainText(data.rich_text).trim() : "";
    if (text) notes.push({ id: block.id, text });
  }
  return notes;
}

/** The saved notes, oldest first, as plain lines. */
export async function readMemory(): Promise<string[]> {
  return (await listNotes()).map((n) => n.text);
}

/** Append one note; the oldest notes are dropped past MEMORY_MAX_NOTES. */
export async function remember(text: string): Promise<void> {
  const notes = await listNotes();
  const excess = notes.length + 1 - config.memoryMaxNotes;
  for (const note of notes.slice(0, Math.max(0, excess))) await deleteBlock(note.id);
  await appendBlocks(config.memoryPageId!, [
    {
      object: "block",
      type: "bulleted_list_item",
      bulleted_list_item: { rich_text: inlineToRichText(text) },
    },
  ]);
}
