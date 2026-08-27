import { config } from "./config.js";
import { discoverPages, getPageTitle, type WatchPage } from "./notion.js";
import { checkPage, createWatcher, persist } from "./watcher.js";

async function main(): Promise<void> {
  const watcher = await createWatcher();
  let firstRun = watcher.freshState;
  // Pages whose silent first pass failed stay silent until one succeeds, so a
  // transient error during indexing can't cause old comments to be answered.
  const unindexed = new Set<string>();

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
        const silent = firstRun || unindexed.has(page.id);
        try {
          await checkPage(watcher, page, !silent);
          unindexed.delete(page.id);
          persist(watcher);
        } catch (err) {
          if (silent) unindexed.add(page.id);
          console.error(`[agent] failed to poll "${page.title}":`, err);
        }
      }
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
