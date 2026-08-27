import { config } from "./config.js";
import { discoverPages, getPageTitle, type WatchPage } from "./notion.js";
import { checkPage, createWatcher, persist } from "./watcher.js";

async function main(): Promise<void> {
  const watcher = await createWatcher();
  let firstRun = watcher.freshState;

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
        try {
          await checkPage(watcher, page, !firstRun);
        } catch (err) {
          console.error(`[agent] failed to poll "${page.title}":`, err);
        }
      }
      persist(watcher);
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
