import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Team sign-in.
 *
 * The app runs on one office computer and is opened from phones on the same
 * Wi-Fi, so everyone on the network could otherwise approve and publish.
 * People sign in once with their name and the team code (TEAM_CODE in
 * .env.local); a signed cookie then remembers who they are, and that name is
 * recorded on every approval. Without TEAM_CODE, sign-in is off (local use).
 */

export const SESSION_COOKIE = "sga_user";
export const SESSION_MAX_AGE = 180 * 24 * 60 * 60;

export function authConfig(env: Record<string, string | undefined> = process.env): { code: string; secret: string } | null {
  const code = env.TEAM_CODE?.trim();
  if (!code) return null;
  // Changing the team code signs everyone out, because it is part of the key.
  return { code, secret: `${env.APP_SECRET?.trim() || "social-growth-agent"}:${code}` };
}

function mac(name: string, secret: string): string {
  return createHmac("sha256", secret).update(name).digest("base64url");
}

export function signSession(name: string, secret: string): string {
  return `${Buffer.from(name, "utf8").toString("base64url")}.${mac(name, secret)}`;
}

/** The signed-in name, or null if the cookie is missing or was tampered with. */
export function verifySession(value: string | undefined, secret: string): string | null {
  if (!value) return null;
  const [b64, sig] = value.split(".");
  if (!b64 || !sig) return null;
  const name = Buffer.from(b64, "base64url").toString("utf8");
  const want = Buffer.from(mac(name, secret));
  const got = Buffer.from(sig);
  return want.length === got.length && timingSafeEqual(want, got) && cleanName(name) ? name : null;
}

export function codeMatches(given: string, code: string): boolean {
  const a = createHmac("sha256", "cmp").update(given.trim()).digest();
  const b = createHmac("sha256", "cmp").update(code).digest();
  return timingSafeEqual(a, b);
}

/** A display name: 2-40 characters, letters, spaces and simple punctuation. */
export function cleanName(name: string): string {
  const n = name.replace(/\s+/g, " ").trim();
  return /^[\p{L}\p{M}][\p{L}\p{M} .'-]{1,39}$/u.test(n) ? n : "";
}

/** Only same-site paths, so the sign-in page can't be used to redirect elsewhere. */
export function safeNext(next: string): string {
  return /^\/(?!\/)[^\s\\]*$/.test(next) && !next.startsWith("/login") ? next : "/";
}

/**
 * Sign-in lockout. Once the app is reachable from the internet, a 6-digit team
 * code could be guessed by trying many codes, so failed attempts are counted
 * per address (5 per 15 minutes) and overall (30 per hour, to stop guessing
 * from many addresses). Counts live in memory and reset when the app restarts.
 */
export const LOCK = { perIp: 5, ipWindowMs: 15 * 60_000, global: 30, globalWindowMs: 60 * 60_000 };

export class LoginThrottle {
  private fails = new Map<string, number[]>();
  private all: number[] = [];

  /** Minutes until this address may try again, or 0 when it may try now. */
  waitMinutes(ip: string, now = Date.now()): number {
    const mine = (this.fails.get(ip) ?? []).filter((t) => now - t < LOCK.ipWindowMs);
    this.all = this.all.filter((t) => now - t < LOCK.globalWindowMs);
    if (mine.length >= LOCK.perIp) return Math.ceil((mine[0]! + LOCK.ipWindowMs - now) / 60_000);
    if (this.all.length >= LOCK.global) return Math.ceil((this.all[0]! + LOCK.globalWindowMs - now) / 60_000);
    return 0;
  }

  fail(ip: string, now = Date.now()): void {
    this.fails.set(ip, [...(this.fails.get(ip) ?? []).filter((t) => now - t < LOCK.ipWindowMs), now]);
    this.all.push(now);
  }

  success(ip: string): void {
    this.fails.delete(ip);
  }
}

export const loginThrottle = new LoginThrottle();

/** The visitor's address: Cloudflare's header first, then the proxy chain, else "local". */
export function clientIp(h: { get(name: string): string | null }): string {
  return h.get("cf-connecting-ip")?.trim() || h.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
}
