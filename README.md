# Social Growth Agent

A local web dashboard that helps a brand plan, write, review and learn from social media content across Instagram, YouTube, LinkedIn, Facebook and X. It ships configured for **KarmaVerse by 3R ZeroWaste** and supports more brands.

It works **completely free and offline** by default. A Claude API key is optional.

- A person approves every post and every reply. Approved, scheduled posts can be published automatically by the **Publishing Agent** (off by default); comment replies are never posted automatically.
- No fake engagement, no scraping, no invented statistics.

---

## Run it on Windows

You need **Node.js 20.9 or newer** (LTS recommended). Download it from https://nodejs.org and accept the defaults, then reopen your terminal.

Open **PowerShell** in the project folder (the one with `package.json`) and run:

```powershell
node -v                 # should print v20.9.0 or higher
npm ci                  # installs exact dependency versions from package-lock.json
npm test                # runs the unit tests (should say 102 passed)
npm run dev             # starts the app in development mode
```

Open **http://localhost:3000** in your browser. Stop the app with `Ctrl + C`.

For a faster production run:

```powershell
npm run build
npm start               # serves the built app on http://localhost:3000
```

Other commands:

```powershell
npm run typecheck       # TypeScript check
npm run reset-data      # delete the local database (a backup is kept); restart to re-seed sample data
npm run dev -- -p 3001  # use a different port if 3000 is busy
```

### Optional: Claude API mode

A Claude.ai subscription does **not** include API credits; API use is billed separately at https://console.anthropic.com.

```powershell
Copy-Item .env.example .env.local
notepad .env.local      # set ANTHROPIC_API_KEY=... and save
npm run dev
```

Then choose **Settings → Generation mode → Claude API**. If the key is missing or a call fails, the app falls back to the free template generator and tells you.

### Troubleshooting

| Problem | Fix |
| --- | --- |
| `npm` is not recognised | Reinstall Node.js and reopen PowerShell. |
| `running scripts is disabled on this system` | Run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` once, or use Command Prompt instead of PowerShell. |
| Port 3000 in use | `npm run dev -- -p 3001` |
| "Database error … failed validation" | Fix `data\db.json` or run `npm run reset-data` (keeps a backup). |
| Rename errors (`EPERM`) on save | Antivirus or a sync tool (OneDrive) is locking `data\db.json`. Move the project out of a synced folder; saves already retry automatically. |

---

## The three generation modes

| Mode | Cost | How it works |
| --- | --- | --- |
| **Template** (default) | Free, offline | Rule-based agents write platform-specific drafts with `[placeholders]` you fill in. Approval is blocked until placeholders are filled. |
| **Manual via Claude chat** | Free with a Claude subscription | The app builds a full prompt (brand rules, verified facts, platform guidance). You paste it into Claude, paste the JSON answer back, and the app validates it before saving. |
| **Claude API** | Paid per use | Same prompt sent automatically via the Messages API, with retries on rate limits and server errors. |

Interactive Claude Code development and the app's runtime are separate: building or editing this code with Claude Code uses your subscription, while the app itself only calls the API in Claude API mode.

---

## Architecture

```
src/
  app/                    Next.js App Router pages (server components) + server actions
    actions.ts            All writes: validate input → mutate DB → redirect with message
    page.tsx              Overview
    studio/               Content Studio (+ manual mode page)
    video/                Video Director (+ brief page, manual mode)
    calendar/             30-day calendar, review queue
    content/[id]/         Edit, approve, schedule, publish (manual), history, export
    analytics/            Group summaries, posts, patterns, diagnosis, metric entry, CSV import
    experiments/          Hypotheses, results, learning log
    inbox/                Comment classification and reply approval
    settings/             Brand profile, approval policy, mode, trend notes, integrations
    api/export/calendar/  CSV download
  lib/
    schemas.ts            zod schemas = the single source of truth for every type
    db.ts                 JSON-file database: validated reads, atomic writes, write lock
    agents/
      strategy.ts         A. Content Strategy Agent (priority scores, gaps, audience questions, weekly/monthly plans)
      idea-bank.ts        Starter ideas for template mode (sustainability)
      content.ts          B. Platform-Specific Content Agent + brand-safety lint
      video.ts            C. AI Video Director (production briefs, Markdown export)
      calendar.ts         E. Calendar + status workflow + approval policy
      community.ts        F. Community Engagement Assistant (classifier + reply drafts)
      engagement.ts       H. Growth Booster (pre-publish boost check, hook rewrites, after-publish tasks, repurpose winners, consistency)
    analytics/
      metrics.ts          Per-platform/format metric definitions and primary scores
      engine.ts           D. Growth Analyst (comparisons, patterns, timing, diagnosis, experiments, CSV)
    llm/                  Claude API client (fetch, retries), prompts, JSON result parsing
    services/generation.ts  Chooses template / manual / API mode, with safe fallback
    publishing/adapters.ts  Platform API requirements (documented) + export for posting by hand
    publishing/connectors.ts  Live API calls: Instagram Graph, Facebook Pages, LinkedIn Posts, YouTube Data API, X API v2 (OAuth 1.0a)
    publishing/accounts.ts  Per-brand credentials (account key prefix; no sharing between brands)
    publishing/agent.ts     G. Publishing Agent (claims due posts, publishes, records URL or failure)
    publishing/scheduler.ts Once-a-minute check (publishing) + 6-hourly metrics sync, started from src/instrumentation.ts
    video/maker.ts          I. Video Maker (ffmpeg captioned scenes + Windows voiceover → MP4)
    metrics/sync.ts         J. Metrics Agent (reads real post metrics from each platform API)
    music/agent.ts          K. Music Agent (Openverse search, licence filter, ffmpeg checks, local library)
    video/ad.ts             Advert style for the Video Maker (3 sizes, phone of app screens, subtitles, covers, transitions, sound)
    video/subtitles.ts      Subtitle timing (Windows speech recognition word times + script alignment)
    carousel/maker.ts       L. Carousel Maker (branded slides, phone images, PDF for LinkedIn)
    publishing/media-host.ts  Media Host (uploads local files to Cloudinary, or links them from this app, for Instagram/Facebook)
    community/              Community Manager (reads comments via each API, quiz replies, safe auto-reply, sends approved replies)
    trends/                 Trend Watcher (climate days, Google Trends, Google News, YouTube; politics filtered out)
    competitors/agent.ts    Competitor Watch (YouTube + Instagram Business Discovery, manual posts, lift report)
    sample-data.ts        Clearly marked demo data
tests/                    Vitest unit tests (121)
```

**Data** lives in `data/db.json` (created on first run, ignored by git). Every read is validated; writes go to a temp file and are renamed into place, and are serialised so concurrent requests can't corrupt the file. To move to SQLite or Postgres later, replace `src/lib/db.ts`; nothing else touches storage.

**Agents are plain TypeScript functions** with typed inputs and outputs, so they can be unit-tested and later moved to a background job without changes.

---

## What is implemented vs placeholder

### Implemented and tested

- **Brand profile** (Settings): audience, voice, pillars, verified/unverified facts, hashtags, CTAs, banned phrases, platforms, approval policy. Multiple brands with a switcher.
- **Content Strategy Agent**: idea backlog with priority score (relevance 50%, impact 30%, ease 20%, +10 for under-covered pillars); ideas from real audience questions in the inbox and from team trend notes; pillar coverage and gaps; weekly plan (max two posts per pillar); monthly themes; fixed-date observances.
- **Platform Content Agent**: different structure, length, tone, hashtags and CTA for Instagram Reel/carousel/Story, YouTube Short/long video, LinkedIn post/document, Facebook post/Reel. Only verified facts are stated. Lint warns on numbers, guarantees and environmental claims, and blocks approval while `[placeholders]` remain.
- **Video Director**: objective, audience, 3 hooks, timestamped script, storyboard (camera, framing, transition, B-roll), subtitles, voiceover, music, editing steps, thumbnail, titles, CTA, effort estimate, free tools; copy as Markdown. It never claims a video was rendered.
- **Calendar and publishing workflow**: 30-day calendar (date, time, platform, pillar, format, topic, hook, status, target metric); statuses draft → needs-review → approved → scheduled → published / failed; approver list; edits after approval send content back to review; publishing requires prior approval and the live URL; full history; ready-to-paste export and CSV export.
- **Growth Analyst**: platform-specific primary scores (e.g. engagement per reach on Instagram, average percentage viewed on YouTube, engagement per impression on LinkedIn); every comparison is within the same platform and format; vs-history comparison only after 3 earlier posts; trend; hook-style, CTA and pillar patterns; posting windows (labelled "experiment" when data is thin); evidence-based diagnosis; experiment recommendations ranked by impact/effort; manual metric entry and CSV import with validation.
- **Experiments and learning log**: propose, start, conclude (result required), abandon; hypotheses and results logged automatically.
- **Community Inbox**: classifies pasted comments (question, feedback, praise, complaint, support, spam, escalation; sentiment; legal/privacy/abuse/harm flags; works with common Hinglish); escalation, support and complaints are routed to a person; spam gets no reply; replies need a named approver and are posted by hand.
- **Error handling**: input validation with clear messages, database validation, Windows-safe atomic writes with retry, API retries with backoff, fallback from API to templates, error and not-found pages, secrets redacted from logs.

### Placeholders and limits (v0.1)

- **Publishing needs platform access.** The connectors are written and tested against mocked APIs but not yet against live accounts. Each platform needs the access below (checked 26 Oct 2026; re-check if a call fails):
  - Instagram: professional account; `instagram_business_content_publish` (or `instagram_content_publish`); rolling 24-hour publishing cap (the docs give two different numbers, so query `content_publishing_limit`); media must be at a public URL.
  - Facebook: Page access token with `pages_manage_posts` and related permissions; scheduled posts 10 minutes to 30 days ahead.
  - YouTube: OAuth `youtube.upload`; 10,000 units/day default quota with a separate small daily limit on uploads; audit needed for more.
  - LinkedIn: Community Management API (restricted, reviewed); `w_organization_social`; 60-day tokens; document carousels and polls are reported as not publishable via the API.
  - X: developer app with Read and Write permission and OAuth 1.0a user tokens; posting volume depends on the X API plan (the free tier has a small monthly cap). This connector posts text only; posts with media are posted by hand.
- **Metrics are entered by hand or by CSV.** No platform analytics API is connected.
- **Comments are pasted in.** Reading comments automatically needs each platform's API and app review.
- **Trend research is manual** (trend notes). The app does not scrape platforms. Only fixed-date observances are built in; add movable festivals (Diwali, Holi, Eid) as trend notes.
- **Template ideas are tuned for sustainability brands.** Other categories should use Manual or API mode.
- **No login or multi-user permissions.** Approver names are typed, not authenticated. Run it locally or behind your own authentication.
- **Time zone** for posting-window analysis is IST (Asia/Kolkata).

---

## Publishing Agent and Growth Booster

**Publishing Agent** (Publishing page). Posts content that is **approved and scheduled** to each connected platform at its planned date and time (IST), through the official APIs, then saves the live URL in the post's history. If it fails, it saves the platform's error message instead.

1. Give each brand an **account key** in Settings (e.g. `KARMAVERSE`, `ZEROWASTE`, `FOUNDATION`), then put that brand's API tokens in `.env.local` with the key as a prefix, e.g. `ZEROWASTE_META_PAGE_ID` (see `.env.example`). A brand never uses another brand's tokens. Account passwords do not work and must not be stored here.
2. Restart the app. The Publishing page shows each platform as connected or not connected.
3. Add the post's media as public `https://` links (Media URLs field). Instagram and YouTube need media; LinkedIn document carousels can't be posted through the API.
4. Approve, then **Mark scheduled**. Turn on **Auto-publish**, or use **Publish now** on the post.

It only runs while the app is running. A post that was being published when the app stopped is marked failed ("result is unknown") rather than retried, so it is never posted twice. Create requests are not retried on server errors for the same reason.

**Growth Booster** (Growth Booster page, and a card on each post). Scores each upcoming post out of 100: hook length and style (compared with your own best-performing hook style once you have enough data), call to action, hashtag count, posting window, media and platform-specific checks. It offers three alternative hooks, lists tasks for the first 48 hours after a post goes live and a reminder to log its metrics after 7 days, turns posts that beat their history by 20%+ into drafts for other platforms, and tracks posting consistency. It never fakes or automates engagement.

## Video Maker and Metrics Agent

**Video Maker** (Video Director brief page, and the Video card on any Reel/Short/video post). Renders a finished MP4 on this computer: one captioned scene per script line on a brand-colour gradient (or over your own clips and photos), a voiceover from the voices installed in Windows, a progress bar and an ending call-to-action card with the website. Vertical 1080×1920 for Reels/Shorts/Stories, 1920×1080 for long videos. The video is attached to the post (a draft is created from a brief if needed) and published like any other media. It uses ffmpeg from the `ffmpeg-static` package (downloaded by `npm ci`) and is free and offline. It does not generate camera footage or AI avatars: film real-life shots and pass them as background clips. Briefs with `[placeholders]` must be filled in first (Edit script on the brief page). Videos are stored in `data/videos/`.

**Metrics Agent** (Analytics → Metrics Agent). Every 6 hours while the app runs, and on **Sync metrics now**, it reads each published post's results (last 90 days) from the platform and keeps one Analytics row per post, marked *auto*: YouTube views, likes, comments, average % viewed, average view duration, shares, subscribers gained; Instagram reach, likes, comments, shares, saves, views, Reel watch time; Facebook reactions, comments, shares, reach, clicks; LinkedIn impressions, reactions, comments, reposts, clicks; X impressions, likes, reposts, replies, bookmarks. It needs read permissions on top of the posting ones (listed on the Analytics page); a missing permission is reported with the platform's message. Once a brand has any real metrics, the invented sample rows are left out of all analysis automatically.

## Music Agent and Advert style

**Music Agent** (Music page, and *Music* in every Make video form). Finds background music that is safe for brand videos on Openverse (Freesound, Wikimedia Commons and more), accepting only **CC0 / public domain** (no credit needed) and **CC BY** (credit required); ShareAlike, NonCommercial and NoDerivatives tracks are never used. Each downloaded track is checked with ffmpeg: 20 s–5 min, not mostly silence, not too quiet, and musical (spectral flatness below 0.11; noise and whooshes are rejected). Tracks are kept in `data/music/` with their licence. *Auto* picks the best track for the chosen mood (uplifting, calm, energetic), searching first if the library has none. When a CC BY track is used, its credit line is added to the post (YouTube description, or caption elsewhere). Music is levelled before mixing and ducks automatically (sidechain compression) whenever the clip or voiceover speaks, rising again in pauses, the intro and the end card; adverts are mastered to about −16 LUFS. Openverse can be slow: the first search for a mood may take a few minutes.

**Advert style** (Make video → Style: Advert). Logo intro with a bounce, a sliding headline with a gold underline, the clip in a gold-framed card with a slow zoom and a pulsing call-to-action button, optional messages that change during the clip, a logo end card with website and an optional note, drifting brand-colour shapes in the background, transitions and generated sound effects. The clip's own sound can be muted when its narration doesn't match the message. Extras for the advert:
- **App screens in a phone**: a rounded phone mock-up slides in beside the clip and shows real app screens one after another, in time with the messages (images, or `video.mp4@12.5` for a video from 12.5 s). Check screens for names, phone numbers and addresses first; KarmaVerse's checked screens are in `data/brand/app-screens/`.
- **Subtitles**: type the exact words the clip says (one sentence per line), or click *Suggest subtitles* for a draft from Windows speech recognition and correct it. Speech recognition is only used to time the words; captions are short (≤ 5 words), in a green box, gold when they carry a key word (KarmaCoins, recycle, earn, eco…).
- **Sizes and covers**: the post's own size is always made; tick 9:16, 1:1 and 16:9 for extra versions, and *covers* for a branded cover image per size. Extras appear on the post page with download links; only the post's own size is published automatically. Set the brand logo (and tagline) in Settings; a logo on white is made transparent automatically. Takes about 2–3 minutes to render.

## Carousel Maker

**Carousel Maker** (the *Carousel slides* card on any carousel, image or document post). Turns a post into branded slides: a cover with the hook and a *Swipe →* prompt, up to 8 numbered content slides (`Title | short text`, one per line; drafted from the post's slide outline), optionally a real app screen in a phone on each content slide (one image path per line, `-` for none), and a closing slide with the logo, call-to-action button, website and an optional note. Background shapes continue across slides. Portrait 4:5 (1080×1350) or square. Output: JPEG slides, attached as the post's images (Instagram allows up to 10), plus a PDF of the same slides for LinkedIn document carousels. Instagram and Facebook fetch images from public links, so the Media Host uploads the slides when the post is published (or post them by hand if it isn't set up); LinkedIn image posts upload the files directly. Feed slides (4:5, 1:1) put the text on the left and a large phone on the right; tall slides put the phone below.

With the same click it can also **write the post text from the slides** (platform-aware: emoji and "Swipe 👉" for Instagram/Facebook, numbered and plain for LinkedIn) and make a **video version**: the slides at 9:16 as a Reel/Short with a slow zoom on each slide, swipe transitions, a whoosh per swipe and music from the Music Agent (time per slide depends on how much text it has). The video appears on the post page with a download link.

## Media Host, Community Manager, Trend Watcher and Competitor Watch

**Media Host** (Publishing page). Instagram and Facebook only accept media from a public https link. When an approved Instagram/Facebook post has files on this computer (slides, covers, videos made here), the Publishing Agent uploads them just before publishing and posts with the public links. Each file is uploaded once per post (the links are saved on the post); PNG images are delivered as JPEG for Instagram. Set `CLOUDINARY_URL=cloudinary://API_KEY:API_SECRET@CLOUD_NAME` (free Cloudinary plan), or `MEDIA_PUBLIC_BASE_URL=https://…` if this app is reachable from the internet. Uploaded files are public to anyone with the link, so only approved posts are uploaded.

**Community Manager** (Community Inbox). Every 15 minutes it reads new comments on posts published in the last 30 days, skips the brand's own comments, sorts them (question, praise, complaint, support, spam, escalation) and drafts a reply. On quiz posts (slides or caption containing "The answer: C") it recognises guesses like "C", "option b" or "my answer is d" and drafts "Correct! 🎉" or "Good try, the answer is C". You approve and click **Send**, or turn on **Safe auto-reply**, which sends only thanks to praise and quiz replies (comments under 3 days old, at most 15 per check); questions, complaints, support and anything flagged always wait for a person. Each reply is claimed before sending so it can never go out twice. Permissions: Instagram `instagram_business_manage_comments`, Facebook `pages_read_engagement`, `pages_read_user_content`, `pages_manage_engagement`, YouTube `youtube.force-ssl` (new refresh token needed), LinkedIn `r_organization_social` / `w_organization_social`, X a paid plan to read replies. DMs aren't read (Meta messaging needs a separate app review).

**Trend Watcher** (Trends page). Once a day: climate days in the next 45 days (UN and Indian observances, with an angle and pillar), Google Trends daily searches in India that touch climate, pollution, waste, energy or weather, this week's Google News for the brand's topics, and the most-viewed YouTube videos on its topics in India (uses the brand's YouTube connection). Every item has a 0–100 fit score and a suggested angle; party-political and outrage content is dropped. **Make it an idea** adds it to the Content Studio backlog. Headlines are never published; check facts first. Google News RSS is offered for personal feed readers, so treat it as internal reading only. Trending Reels audio has no public API.

**Competitor Watch** (Competitors page). Add competitors with their Instagram username and/or YouTube handle. Once a day it reads their public followers and latest 25 posts: YouTube through the Data API (your YouTube connection), Instagram through Business Discovery (needs the brand's `INSTAGRAM_ACCOUNT_ID` and a Facebook Page token with `instagram_basic`; business/creator accounts only). LinkedIn, Facebook and X posts can be added by hand. The report shows posts per week, engagement and engagement rate side by side with your own pace, and which formats, posting times (IST) and hook styles do best. Comparisons use *lift* (a post's likes + comments divided by that competitor's median), so a big account doesn't drown out a small one. **Make our version** turns a top post into an idea that says to make your own take, never a copy.

## Phased plan

| Phase | Scope | Status |
| --- | --- | --- |
| 1. MVP | Everything under "Implemented" above, local JSON storage, free modes | **Done** |
| 2. Data in | Metrics Agent: YouTube, Instagram, Facebook, LinkedIn and X metrics behind the existing schema, every 6 hours | **Code done**; needs read permissions per platform |
| 3. Publishing | Publishing Agent with per-brand connectors for Facebook Pages, Instagram, LinkedIn, YouTube and X (text) behind the same approval gate | **Code done**; needs each platform's app access and tokens |
| 4. Team | Login, roles (editor / approver), SQLite or Postgres, audit log export | Later |
| 5. Smarter learning | Per-experiment significance checks, automatic post-to-metrics linking, weekly digest email | Later |

**Business decisions needed before phase 2–3:** which Meta Business account and Pages to connect; whether to apply for Meta App Review and the LinkedIn Community Management API; who the approvers are.

---

## Sample data

On first run the database is seeded with **invented** demo metrics, comments and one experiment, all marked **Sample** in the UI. They are not KarmaVerse's real numbers. Remove them in **Settings → Sample data** once your real data is in. The idea backlog is real starter content and is kept.

Brand facts from the karmaverse.earth site description are marked verified. Facts taken from the draft Play Store screenshots are **unverified** until you tick them in Settings, so generated copy won't state them.

## Security

- Secrets live only in `.env.local`, which is git-ignored. Never commit it.
- The logger redacts any field named like a key, token, secret or password.
- `npm run dev` and `npm start` listen on localhost only. If you deploy it elsewhere, put it behind authentication: it has no login.
