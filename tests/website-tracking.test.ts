import { generateKeyPairSync, createVerify } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { bioLink, tagLinks } from "@/lib/publishing/utm";
import { readWebsite, visitsByPost } from "@/lib/website/google";
import { clickRate } from "@/lib/metrics/account";

const piece = { id: "c_123", platform: "youtube" as const, pillarId: "edu", series: "news" };

describe("link tagging", () => {
  it("tags own-site and Play Store links, leaves others and already-tagged links alone", () => {
    const text = "Book at https://karmaverse.earth. Read https://0waste.co.in/blog/x?ref=1 and https://www.tribuneindia.com/news/a. Already: https://karmaverse.earth/?utm_source=bio\nApp: https://play.google.com/store/apps/details?id=com.karmaverse";
    const out = tagLinks(text, piece);
    expect(out).toContain("https://karmaverse.earth/?utm_source=youtube&utm_medium=social&utm_campaign=news&utm_content=c_123.");
    expect(out).toContain("https://0waste.co.in/blog/x?ref=1&utm_source=youtube");
    expect(out).toContain("https://www.tribuneindia.com/news/a.");
    expect(out).toContain("https://karmaverse.earth/?utm_source=bio\n");
    expect(out).toContain("id=com.karmaverse&referrer=utm_source%3Dyoutube%26utm_medium%3Dsocial");
    expect(tagLinks("no links here", piece)).toBe("no links here");
    expect(bioLink("https://karmaverse.earth", "instagram")).toBe("https://karmaverse.earth/?utm_source=instagram&utm_medium=social&utm_campaign=bio");
  });

  it("click rate is link clicks per person reached", () => {
    expect(clickRate({ reach: 1000, linkClicks: 25 })).toBe(0.025);
    expect(clickRate({ reach: 1000 })).toBeNull();
  });
});

describe("website tracking (GA4 + Search Console)", () => {
  it("does nothing until configured", async () => {
    expect(await readWebsite({})).toEqual({ data: null, notes: [] });
  });

  it("signs in with the service account and reads visitors, sources, posts and Google search", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const dir = mkdtempSync(path.join(tmpdir(), "gkey-"));
    const keyFile = path.join(dir, "key.json");
    writeFileSync(keyFile, JSON.stringify({ client_email: "studio@p.iam.gserviceaccount.com", private_key: privateKey.export({ type: "pkcs8", format: "pem" }) }));
    const calls: string[] = [];
    const fetcher = async (url: string, init?: RequestInit) => {
      calls.push(url);
      const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
      if (url.includes("oauth2")) {
        const jwt = new URLSearchParams(String(init?.body)).get("assertion")!;
        const [h, p, s] = jwt.split(".");
        expect(createVerify("RSA-SHA256").update(`${h}.${p}`).verify(publicKey, Buffer.from(s!, "base64url"))).toBe(true);
        expect(JSON.parse(Buffer.from(p!, "base64url").toString()).scope).toContain("analytics.readonly");
        return ok({ access_token: "tok" });
      }
      if (url.includes("analyticsdata")) {
        return ok({
          reports: [
            { rows: [{ metricValues: [{ value: "420" }, { value: "300" }, { value: "510" }, { value: "900" }, { value: "0.61" }] }] },
            { rows: [
              { dimensionValues: [{ value: "google" }, { value: "organic" }], metricValues: [{ value: "200" }, { value: "170" }] },
              { dimensionValues: [{ value: "youtube" }, { value: "social" }], metricValues: [{ value: "40" }, { value: "35" }] },
              { dimensionValues: [{ value: "l.instagram.com" }, { value: "referral" }], metricValues: [{ value: "10" }, { value: "9" }] },
            ] },
            { rows: [{ dimensionValues: [{ value: "/" }], metricValues: [{ value: "300" }] }] },
            { rows: [{ dimensionValues: [{ value: "c_123" }, { value: "youtube" }], metricValues: [{ value: "12" }] }, { dimensionValues: [{ value: "(not set)" }, { value: "x" }], metricValues: [{ value: "3" }] }] },
          ],
        });
      }
      if (url.includes("searchconsole")) {
        const body = JSON.parse(String(init?.body));
        return ok(body.dimensions ? { rows: [{ keys: ["karmaverse"], clicks: 30, impressions: 200, ctr: 0.15, position: 1.24 }] } : { rows: [{ clicks: 55, impressions: 4000, ctr: 0.01375, position: 18.2 }] });
      }
      return new Response("{}", { status: 404 });
    };
    const r = await readWebsite({ GOOGLE_SERVICE_ACCOUNT_FILE: keyFile, GA4_PROPERTY_ID: "123", GSC_SITE: "sc-domain:karmaverse.earth" }, { fetcher, now: new Date("2026-11-19T00:00:00Z") });
    expect(r.notes).toEqual([]);
    expect(r.data).toMatchObject({ visitors: 420, sessions: 510, pageViews: 900, engagementRate: 0.61, fromSocial: 50, posts: [{ contentId: "c_123", source: "youtube", sessions: 12 }] });
    expect(r.data?.search).toMatchObject({ clicks: 55, impressions: 4000, position: 18.2, queries: [{ query: "karmaverse", position: 1.2 }] });
    expect(calls.some((u) => u.includes("sc-domain%3Akarmaverse.earth"))).toBe(true);
    expect(visitsByPost({ posts: r.data!.posts! }, [{ id: "c_123" }]).get("c_123")).toBe(12);
  });

  it("explains a missing permission instead of guessing", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const dir = mkdtempSync(path.join(tmpdir(), "gkey-"));
    const keyFile = path.join(dir, "key.json");
    writeFileSync(keyFile, JSON.stringify({ client_email: "s@p.iam.gserviceaccount.com", private_key: privateKey.export({ type: "pkcs8", format: "pem" }) }));
    const fetcher = async (url: string) =>
      url.includes("oauth2") ? new Response(JSON.stringify({ access_token: "t" })) : new Response(JSON.stringify({ error: { message: "User does not have sufficient permissions for this property." } }), { status: 403 });
    const r = await readWebsite({ GOOGLE_SERVICE_ACCOUNT_FILE: keyFile, GA4_PROPERTY_ID: "123" }, { fetcher });
    expect(r.data).toBeNull();
    expect(r.notes[0]).toMatch(/Property access management/);
  });
});
