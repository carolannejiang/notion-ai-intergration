import http from "node:http";
import crypto from "node:crypto";
import { config } from "./config.js";
import { discoverPages, getPageTitle, type WatchPage } from "./notion.js";
import { checkPage, createWatcher, persist, type Watcher } from "./watcher.js";

// Webhook mode: instead of polling, Notion POSTs a comment.created event and we
// immediately re-check the affected page. Requires a public HTTPS URL (e.g. a
// cloudflared/ngrok tunnel) registered in the integration's webhook settings.

const normalize = (id: string) => id.replace(/-/g, "").toLowerCase();

/** Pull a page id out of a webhook event payload, tolerating shape variations. */
function extractPageId(body: Record<string, unknown>): string | undefined {
  const data = (body.data ?? {}) as Record<string, unknown>;
  if (typeof data.page_id === "string") return data.page_id;
  const parent = data.parent as Record<string, unknown> | undefined;
  if (parent) {
    if (typeof parent.page_id === "string") return parent.page_id;
    if (typeof parent.id === "string" && String(parent.type ?? "").includes("page"))
      return parent.id as string;
  }
  const entity = body.entity as Record<string, unknown> | undefined;
  if (entity?.type === "page" && typeof entity.id === "string") return entity.id;
  return undefined;
}

function verifySignature(rawBody: string, header: string | undefined): boolean {
  if (!config.webhookSecret) return true; // verification disabled
  if (!header) return false;
  const expected =
    "sha256=" +
    crypto.createHmac("sha256", config.webhookSecret).update(rawBody).digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(header), Buffer.from(expected));
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const watcher = await createWatcher();
  const titleCache = new Map<string, string>();

  // Startup sweep. Fresh state: index existing comments silently so old threads
  // are never answered. Existing state: respond, so comments posted while the
  // server was down (whose events were lost) still get picked up.
  {
    const catchUp = !watcher.freshState;
    console.log(
      catchUp
        ? "[webhook] startup: catch-up sweep for comments missed while offline"
        : "[webhook] first run: indexing existing comments without responding",
    );
    const pages: WatchPage[] = config.watchPageIds.length
      ? await Promise.all(
          config.watchPageIds.map(async (id) => ({ id, title: await getPageTitle(id) })),
        )
      : await discoverPages(config.maxDiscoveredPages);
    for (const page of pages) {
      await checkPage(watcher, page, catchUp);
      titleCache.set(normalize(page.id), page.title);
    }
    persist(watcher);
    console.log("[webhook] startup sweep done");
  }

  // Serialize page checks so concurrent events can't double-run the agent.
  let queue: Promise<void> = Promise.resolve();
  const enqueue = (job: (w: Watcher) => Promise<void>) => {
    queue = queue
      .then(() => job(watcher))
      .then(() => persist(watcher))
      .catch((err) => console.error("[webhook] event handling failed:", err));
  };

  const server = http.createServer((req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) req.destroy();
    });
    req.on("end", () => {
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        res.writeHead(400).end();
        return;
      }

      // Subscription handshake: Notion sends the token once; paste it into the
      // integration's webhook settings to verify the endpoint.
      if (typeof body.verification_token === "string") {
        console.log("\n========================================");
        console.log("[webhook] VERIFICATION TOKEN received:");
        console.log(body.verification_token);
        console.log("Paste this into the integration's webhook verification field.");
        console.log("Also set NOTION_WEBHOOK_SECRET to this value to enable");
        console.log("signature checks on incoming events.");
        console.log("========================================\n");
        res.writeHead(200).end();
        return;
      }

      if (!verifySignature(raw, req.headers["x-notion-signature"] as string | undefined)) {
        console.error("[webhook] rejected event with bad signature");
        res.writeHead(401).end();
        return;
      }

      res.writeHead(200).end(); // ack fast; process async

      if (body.type !== "comment.created") return;

      const pageId = extractPageId(body);
      if (!pageId) {
        console.log("[webhook] comment.created without a page id; checking all watched pages");
        enqueue(async (w) => {
          const pages: WatchPage[] = config.watchPageIds.length
            ? await Promise.all(
                config.watchPageIds.map(async (id) => ({ id, title: await getPageTitle(id) })),
              )
            : await discoverPages(config.maxDiscoveredPages);
          for (const page of pages) await checkPage(w, page, true);
        });
        return;
      }

      const normalized = normalize(pageId);
      if (
        config.watchPageIds.length &&
        !config.watchPageIds.some((id) => normalize(id) === normalized)
      ) {
        return; // event for a page we don't watch
      }

      enqueue(async (w) => {
        let title = titleCache.get(normalized);
        if (!title) {
          title = await getPageTitle(pageId);
          titleCache.set(normalized, title);
        }
        await checkPage(w, { id: pageId, title }, true);
      });
    });
  });

  server.listen(config.webhookPort, () => {
    console.log(
      `[webhook] listening on port ${config.webhookPort} for comment.created events ` +
        `(trigger phrase "${config.trigger}")`,
    );
    console.log(
      "[webhook] expose this port via a tunnel (e.g. `cloudflared tunnel --url " +
        `http://localhost:${config.webhookPort}\`) and register the public URL in the ` +
        "integration's webhook settings at notion.so/my-integrations",
    );
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
