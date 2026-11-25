// One-time Google sign-in for website tracking (Google Analytics 4 + Search Console).
//
//   node scripts/google-connect.mjs
//
// Opens Google's sign-in page, waits for "Allow", then finds the GA4 property
// for karmaverse.earth (G-8Z7CRL6KKG) and the Search Console site, and writes
// GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN /
// GA4_PROPERTY_ID / GSC_SITE into .env.local. Read-only access only.
// Uses the same Google Cloud OAuth client as YouTube; the YouTube token is not touched.
import { createServer } from "node:http";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import { exec } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENV_FILE = path.join(ROOT, ".env.local");
const MEASUREMENT_ID = process.env.GA_MEASUREMENT_ID || "G-8Z7CRL6KKG";
const SITE_MATCH = /karmaverse\.earth/i;
const PORT = 53682;
const REDIRECT = `http://127.0.0.1:${PORT}/`;
// --play: a separate sign-in for Google Play Console (ASO), saved as PLAY_REFRESH_TOKEN,
// so the Play account can differ from the Analytics account. All read-only.
const PLAY = process.argv.includes("--play");
const ARG_FILE = process.argv.slice(2).find((a) => !a.startsWith("--"));
const PLAY_PACKAGE = process.env.PLAY_PACKAGE || "com.karmacredits.app";
const SCOPES = PLAY
  ? ["https://www.googleapis.com/auth/playdeveloperreporting", "https://www.googleapis.com/auth/androidpublisher", "https://www.googleapis.com/auth/devstorage.read_only"]
  : ["https://www.googleapis.com/auth/analytics.readonly", "https://www.googleapis.com/auth/webmasters.readonly"];

const envText = readFileSync(ENV_FILE, "utf8");
const env = Object.fromEntries(envText.split(/\r?\n/).map((l) => l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2].replace(/^"|"$/g, "")]));
// A "Desktop app" OAuth client file downloaded from Google Cloud (client_secret_*.json in Downloads,
// or a path given as the first argument) wins over the YouTube client.
function desktopClient() {
  const dl = path.join(os.homedir(), "Downloads");
  const file = ARG_FILE || readdirSync(dl).filter((f) => /^client_secret.*\.json$/i.test(f)).map((f) => path.join(dl, f)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
  if (!file) return null;
  const j = JSON.parse(readFileSync(file, "utf8"));
  const c = j.installed || j.web;
  if (!c?.client_id) return null;
  console.log(`Using the Google client from ${file}${j.web ? " (web type: it must list http://127.0.0.1:53682/ as a redirect URI)" : ""}.`);
  return { id: c.client_id, secret: c.client_secret };
}
const dc = desktopClient();
const clientId = dc?.id || env.GOOGLE_CLIENT_ID || env.KARMAVERSE_YOUTUBE_CLIENT_ID || env.YOUTUBE_CLIENT_ID;
const clientSecret = dc?.secret || env.GOOGLE_CLIENT_SECRET || env.KARMAVERSE_YOUTUBE_CLIENT_SECRET || env.YOUTUBE_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  console.error("No Google OAuth client found in .env.local (YOUTUBE_CLIENT_ID / SECRET).");
  process.exit(1);
}

function setEnv(updates) {
  let text = readFileSync(ENV_FILE, "utf8");
  for (const [k, v] of Object.entries(updates)) {
    if (!v) continue;
    const re = new RegExp(`^${k}=.*$`, "m");
    text = re.test(text) ? text.replace(re, `${k}=${v}`) : `${text.replace(/\s*$/, "")}\n${k}=${v}\n`;
  }
  writeFileSync(ENV_FILE, text);
}

async function getJson(url, token) {
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const j = await r.json();
  if (!r.ok) throw new Error(`${r.status} ${j.error?.message ?? JSON.stringify(j).slice(0, 200)}`);
  return j;
}

const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({ client_id: clientId, redirect_uri: REDIRECT, response_type: "code", scope: SCOPES.join(" "), access_type: "offline", prompt: "consent" })}`;

const code = await new Promise((resolve, reject) => {
  const server = createServer((req, res) => {
    const u = new URL(req.url, REDIRECT);
    const c = u.searchParams.get("code");
    const err = u.searchParams.get("error");
    if (!c && !err) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(c ? "<h2>Connected. You can close this tab and go back to KarmaVerse Studio.</h2>" : `<h2>Not connected: ${err}</h2>`);
    server.close();
    c ? resolve(c) : reject(new Error(err));
  });
  server.listen(PORT, "127.0.0.1", () => {
    console.log(`\nOpen this link, sign in with the Google account that owns Google Analytics, and click Allow:\n\n${authUrl}\n`);
    exec(`start "" "${authUrl}"`);
  });
  setTimeout(() => reject(new Error("Timed out after 15 minutes waiting for sign-in.")), 15 * 60_000).unref();
});

const tr = await fetch("https://oauth2.googleapis.com/token", { method: "POST", body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: REDIRECT, grant_type: "authorization_code" }) });
const tok = await tr.json();
if (!tok.refresh_token) {
  console.error("Google gave no refresh token:", tok.error_description || tok.error || JSON.stringify(tok));
  process.exit(1);
}
if (PLAY) {
  setEnv({ GOOGLE_CLIENT_ID: clientId, GOOGLE_CLIENT_SECRET: clientSecret, PLAY_REFRESH_TOKEN: tok.refresh_token, PLAY_PACKAGE });
  console.log("Signed in to Google Play. Token saved to .env.local as PLAY_REFRESH_TOKEN.");
  try {
    const apps = await getJson("https://playdeveloperreporting.googleapis.com/v1beta1/apps:search?pageSize=50", tok.access_token);
    console.log("Play apps this account can see:", (apps.apps ?? []).map((a) => `${a.displayName} (${a.packageName})`).join(", ") || "none");
  } catch (e) {
    console.log(`Play Developer Reporting API: ${e.message}`);
  }
  try {
    const r = await getJson(`https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${PLAY_PACKAGE}/reviews?maxResults=5`, tok.access_token);
    console.log(`Reviews API: OK (${(r.reviews ?? []).length} recent reviews).`);
  } catch (e) {
    console.log(`Play Android Developer API: ${e.message}`);
  }
  console.log("\nDone. For installs and store-listing visitors, add PLAY_REPORTS_BUCKET (Play Console → Download reports → Copy Cloud Storage URI).");
  process.exit(0);
}
setEnv({ GOOGLE_CLIENT_ID: clientId, GOOGLE_CLIENT_SECRET: clientSecret, GOOGLE_REFRESH_TOKEN: tok.refresh_token });
console.log("Signed in. Token saved to .env.local.");

// Find the GA4 property whose web stream has the site's measurement ID.
let propertyId = env.GA4_PROPERTY_ID;
try {
  const sums = await getJson("https://analyticsadmin.googleapis.com/v1beta/accountSummaries?pageSize=200", tok.access_token);
  const props = (sums.accountSummaries ?? []).flatMap((a) => (a.propertySummaries ?? []).map((p) => ({ id: p.property.split("/")[1], name: p.displayName })));
  console.log("GA4 properties you can see:", props.map((p) => `${p.name} (${p.id})`).join(", ") || "none");
  for (const p of props) {
    const streams = await getJson(`https://analyticsadmin.googleapis.com/v1beta/properties/${p.id}/dataStreams`, tok.access_token).catch(() => ({}));
    if ((streams.dataStreams ?? []).some((s) => s.webStreamData?.measurementId === MEASUREMENT_ID)) {
      propertyId = p.id;
      break;
    }
  }
  if (!propertyId && props.length === 1) propertyId = props[0].id;
} catch (e) {
  console.log(`Couldn't list GA4 properties (${e.message}).`);
}
if (propertyId) {
  setEnv({ GA4_PROPERTY_ID: propertyId });
  console.log(`GA4 property: ${propertyId}`);
} else console.log(`No GA4 property with ${MEASUREMENT_ID} found for this Google account. Add GA4_PROPERTY_ID to .env.local by hand.`);

let site = env.GSC_SITE;
try {
  const sites = (await getJson("https://www.googleapis.com/webmasters/v3/sites", tok.access_token)).siteEntry ?? [];
  console.log("Search Console sites:", sites.map((s) => `${s.siteUrl} (${s.permissionLevel})`).join(", ") || "none");
  const ok = sites.filter((s) => SITE_MATCH.test(s.siteUrl) && s.permissionLevel !== "siteUnverifiedUser");
  site = (ok.find((s) => s.siteUrl.startsWith("sc-domain:")) ?? ok[0])?.siteUrl ?? site;
} catch (e) {
  console.log(`Couldn't list Search Console sites (${e.message}).`);
}
if (site) {
  setEnv({ GSC_SITE: site });
  console.log(`Search Console site: ${site}`);
} else console.log("karmaverse.earth isn't in this account's Search Console. Add and verify it at https://search.google.com/search-console, then run this again.");
console.log("\nDone. Restart the studio to start reading website numbers.");
