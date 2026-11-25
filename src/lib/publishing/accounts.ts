import type { Brand, Database } from "../schemas";
import type { ConnectorEnv } from "./connectors";

/**
 * Per-brand platform accounts.
 *
 * Each brand has an account key (e.g. KARMAVERSE). Its tokens live in .env.local
 * under that prefix: KARMAVERSE_META_PAGE_ID, KARMAVERSE_INSTAGRAM_ACCOUNT_ID, …
 * The default brand (PUBLISH_BRAND_ID, or the first brand) may also use the
 * unprefixed names, so a single-brand setup keeps working.
 *
 * Credentials are never shared between brands: a brand without its own tokens
 * is "not connected", so it can't post to another brand's accounts by mistake.
 */

/** Account credentials: per brand, never borrowed from another brand. */
export const CREDENTIAL_VARS = [
  "META_PAGE_ID",
  "META_PAGE_ACCESS_TOKEN",
  "INSTAGRAM_ACCOUNT_ID",
  "INSTAGRAM_ACCESS_TOKEN",
  "LINKEDIN_ACCESS_TOKEN",
  "LINKEDIN_AUTHOR_URN",
  "YOUTUBE_CLIENT_ID",
  "YOUTUBE_CLIENT_SECRET",
  "YOUTUBE_REFRESH_TOKEN",
  "X_API_KEY",
  "X_API_SECRET",
  "X_ACCESS_TOKEN",
  "X_ACCESS_TOKEN_SECRET",
] as const;

/** Settings that may be set per brand but fall back to the global value. */
export const SHARED_VARS = ["META_GRAPH_VERSION", "LINKEDIN_API_VERSION", "YOUTUBE_PRIVACY", "YOUTUBE_CATEGORY_ID"] as const;

/** Env-var prefix for a brand: its account key, or one derived from its name. */
export function accountKey(brand: Pick<Brand, "name" | "accountKey">): string {
  const raw = (brand.accountKey.trim() || brand.name).toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (!raw) return "BRAND";
  return /^[0-9]/.test(raw) ? `BRAND_${raw}` : raw;
}

export function defaultBrandId(db: Pick<Database, "brands">, env: ConnectorEnv): string | null {
  const set = env.PUBLISH_BRAND_ID?.trim();
  if (set && db.brands.some((b) => b.id === set)) return set;
  return db.brands[0]?.id ?? null;
}

/** The env one brand's connectors see: its own prefixed values, with names unprefixed. */
export function brandEnv(brand: Brand, db: Pick<Database, "brands">, env: ConnectorEnv): ConnectorEnv {
  const key = accountKey(brand);
  const isDefault = defaultBrandId(db, env) === brand.id;
  const out: ConnectorEnv = {};
  for (const name of CREDENTIAL_VARS) {
    const v = env[`${key}_${name}`]?.trim() || (isDefault ? env[name]?.trim() : undefined);
    if (v) out[name] = v;
  }
  for (const name of SHARED_VARS) {
    const v = env[`${key}_${name}`]?.trim() || env[name]?.trim();
    if (v) out[name] = v;
  }
  return out;
}

/** "A or B" → "KEY_A or KEY_B", for showing which variables to add. */
export function prefixed(brand: Brand, names: string[]): string[] {
  const key = accountKey(brand);
  return names.map((n) => n.split(" or ").map((x) => `${key}_${x}`).join(" or "));
}
