// Inline markdown (bold, italic, code, strikethrough, links) → Notion rich_text.
// Lives in its own module because both notion.ts and markdown.ts need it.

const CHUNK = 1900; // Notion caps rich_text items at 2000 chars

export interface RichTextItem {
  type: "text";
  text: { content: string; link?: { url: string } };
  annotations?: {
    bold?: boolean;
    italic?: boolean;
    code?: boolean;
    strikethrough?: boolean;
  };
}

/** Chunked rich_text with no inline parsing (code blocks, raw content). */
export function rawRichText(text: string): RichTextItem[] {
  const items: RichTextItem[] = [];
  for (let i = 0; i < text.length; i += CHUNK) {
    items.push({ type: "text", text: { content: text.slice(i, i + CHUNK) } });
  }
  return items.length ? items : [{ type: "text", text: { content: "" } }];
}

const INLINE_RE =
  /`([^`\n]+)`|\*\*([^*\n]+)\*\*|\*([^*\s](?:[^*\n]*[^*\s])?)\*|~~([^~\n]+)~~|\[([^\]\n]+)\]\(((?:https?|mailto):[^\s)]+)\)/g;

/** Parse inline markdown into annotated Notion rich_text items. */
export function inlineToRichText(text: string): RichTextItem[] {
  const items: RichTextItem[] = [];

  const push = (content: string, annotations?: RichTextItem["annotations"], url?: string) => {
    if (!content) return;
    for (let i = 0; i < content.length; i += CHUNK) {
      items.push({
        type: "text",
        text: { content: content.slice(i, i + CHUNK), ...(url ? { link: { url } } : {}) },
        ...(annotations ? { annotations } : {}),
      });
    }
  };

  INLINE_RE.lastIndex = 0;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = INLINE_RE.exec(text))) {
    if (m.index > last) push(text.slice(last, m.index));
    if (m[1] !== undefined) push(m[1], { code: true });
    else if (m[2] !== undefined) push(m[2], { bold: true });
    else if (m[3] !== undefined) push(m[3], { italic: true });
    else if (m[4] !== undefined) push(m[4], { strikethrough: true });
    else if (m[5] !== undefined) push(m[5], undefined, m[6]);
    last = m.index + m[0].length;
  }
  if (last < text.length) push(text.slice(last));

  return items.length ? items : [{ type: "text", text: { content: "" } }];
}
