import { readDb } from "../db";
import { logger } from "../logger";
import { runPublishingAgent } from "./agent";
import { runMetricsSync, syncDue } from "../metrics/sync";
import { communityDue, runCommunityManager } from "../community/agent";
import { runTrendWatcher, trendsDue } from "../trends/agent";
import { competitorsDue, runCompetitorWatch } from "../competitors/agent";
import { runMediaMaker } from "../agents/media-maker";
import { blogDue, runBlogWriter } from "../blog/agent";
import { runTracking, trackingDue } from "../tracking/agent";
import { growthDue, runGrowthAgent } from "../growth/agent";

const log = logger("scheduler");

export const TICK_MS = 60_000;

const KEY = Symbol.for("social-growth-agent.publish-scheduler");
type GlobalWithTimer = typeof globalThis & { [KEY]?: ReturnType<typeof setInterval> };

/**
 * Checks once a minute for scheduled posts that are due, while the app is running
 * (only when Auto-publish is on), and refreshes published posts' metrics every
 * 6 hours (Metrics Agent). Also reads new comments every 15 minutes (Community
 * Manager), looks for trends once a day (Trend Watcher) and refreshes
 * competitors once a day (Competitor Watch). The Media Maker makes videos and
 * slides for the next few days' posts and sends them for review.
 * Started from src/instrumentation.ts; safe to call more than once (dev reloads).
 */
export function startScheduler(): void {
  const g = globalThis as GlobalWithTimer;
  if (g[KEY]) return;
  const tick = async () => {
    try {
      const db = await readDb();
      if (db.settings.autoPublish) await runPublishingAgent();
      if (syncDue(db)) await runMetricsSync();
      if (communityDue(db)) await runCommunityManager();
      if (trendsDue(db)) await runTrendWatcher();
      if (competitorsDue(db)) await runCompetitorWatch();
      // Daily article draft for the 3R website, and the daily SEO / LLMO / ASO tracking run.
      // Not awaited: each takes minutes and has its own guard against running twice.
      if (blogDue(db)) void runBlogWriter().catch((err) => log.error("Blog Writer failed", { error: (err as Error).message }));
      if (trackingDue(db)) void runTracking().catch((err) => log.error("Tracking failed", { error: (err as Error).message }));
      // After tracking has run today, so it works from fresh results.
      else if (growthDue(db)) void runGrowthAgent().catch((err) => log.error("Growth agent failed", { error: (err as Error).message }));
      // Makes videos/slides for the next few days' posts; not awaited, since a render takes minutes.
      void runMediaMaker().catch((err) => log.error("Media Maker failed", { error: (err as Error).message }));
    } catch (err) {
      log.error("Scheduled publishing run failed", { error: (err as Error).message });
    }
  };
  g[KEY] = setInterval(tick, TICK_MS);
  g[KEY].unref?.();
  log.info("Publishing scheduler started", { everySeconds: TICK_MS / 1000 });
}
