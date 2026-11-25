import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import { Nav } from "@/components/nav";
import { activeBrand, readDb } from "@/lib/db";
import { isClaudeConfigured } from "@/lib/llm/anthropic";
import { authConfig } from "@/lib/auth";
import { currentUser } from "@/lib/session";
import { logoutAction, switchBrandAction } from "./actions";

export const metadata: Metadata = {
  title: "KarmaVerse Studio",
  description: "Plan, create, approve and publish social media content.",
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#14532d" };

// Every page reads the local database at request time.
export const dynamic = "force-dynamic";

const MODE_LABEL = { template: "Template (free, offline)", manual: "Manual via Claude chat (free)", anthropic: "Claude (automatic)" } as const;

export default async function RootLayout({ children }: { children: ReactNode }) {
  const user = await currentUser();
  // Signed out (only /login is reachable then): show the page without the menu.
  if (authConfig() && !user) {
    return (
      <html lang="en" suppressHydrationWarning>
        <body suppressHydrationWarning>{children}</body>
      </html>
    );
  }

  let brandName = "";
  let brands: Array<{ id: string; name: string }> = [];
  let activeId = "";
  let mode: keyof typeof MODE_LABEL = "template";
  let reviewCount = 0;
  let dbError = "";
  let writerDown = "";
  try {
    const db = await readDb();
    const brand = activeBrand(db);
    brandName = brand.name;
    activeId = brand.id;
    brands = db.brands.map((b) => ({ id: b.id, name: b.name }));
    mode = db.settings.generationMode;
    const wh = db.settings.writerHealth;
    if (mode === "anthropic" && wh && !wh.ok) writerDown = wh.message || "Claude did not answer.";
    reviewCount = db.content.filter((c) => c.brandId === brand.id && (c.status === "needs-review" || c.status === "approved")).length;
  } catch (err) {
    dbError = (err as Error).message;
  }

  return (
    // Browser extensions (Grammarly, coupon tools) add attributes here before React loads.
    <html lang="en" suppressHydrationWarning>
      <body suppressHydrationWarning>
        <div className="shell">
          <aside className="sidebar">
            <div className="logo">
              <span aria-hidden>🌍</span> {brandName || "No brand"} Studio
              {user ? (
                <form action={logoutAction} className="who-am-i">
                  <span>Hi, {user}</span>
                  <button type="submit" className="link">Sign out</button>
                </form>
              ) : null}
            </div>
            <Nav reviewCount={reviewCount} />
            {brands.length > 1 ? (
              <form action={switchBrandAction} className="stack">
                <label style={{ color: "#fff" }}>
                  Brand
                  <select name="brandId" defaultValue={activeId}>
                    {brands.map((b) => (
                      <option key={b.id} value={b.id}>{b.name}</option>
                    ))}
                  </select>
                </label>
                <button type="submit" className="secondary small" style={{ color: "#fff", borderColor: "rgb(255 255 255 / 0.4)" }}>Switch</button>
              </form>
            ) : null}
            <div className="mode">
              Writing mode: {MODE_LABEL[mode]}
              {mode === "anthropic" && !isClaudeConfigured() ? <div>⚠ Claude not found — using templates</div> : null}
            </div>
          </aside>
          <main>
            {writerDown ? (
              <div className="flash err" role="alert">
                <strong>The AI writer has stopped.</strong> Posts, blogs and video scripts are not being written. Open VS Code on this PC and check that Claude Code is
                still signed in to your Claude subscription (it fixes itself on the next run once it is). Details: {writerDown}
              </div>
            ) : null}
            {dbError ? <div className="flash err" role="alert">Database error: {dbError}</div> : children}
          </main>
        </div>
      </body>
    </html>
  );
}
