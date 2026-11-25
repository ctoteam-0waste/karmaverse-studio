/** Runs once when the Next.js server starts. Starts the Publishing Agent's once-a-minute check. */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  // A second copy of the app (e.g. a preview on another port) must not publish too.
  if (process.env.DISABLE_SCHEDULER === "1") return;
  const { startScheduler } = await import("./lib/publishing/scheduler");
  startScheduler();
}
