/**
 * One video/slide render at a time (it uses most of the CPU). Kept on
 * globalThis so the page buttons and the background Media Maker share it,
 * even when Next.js bundles them separately.
 */
const KEY = Symbol.for("social-growth-agent.render-lock");
type G = typeof globalThis & { [KEY]?: boolean };

export function isRendering(): boolean {
  return Boolean((globalThis as G)[KEY]);
}

export async function exclusiveRender<T>(fn: () => Promise<T>): Promise<T> {
  const g = globalThis as G;
  if (g[KEY]) throw new Error("Another video is being made. Wait for it to finish, then try again.");
  g[KEY] = true;
  try {
    return await fn();
  } finally {
    g[KEY] = false;
  }
}
