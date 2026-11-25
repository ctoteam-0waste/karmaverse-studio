import path from "node:path";
import Link from "next/link";
import { activeBrand, readDb } from "@/lib/db";
import { Flash, PageHead, StatusBadge, sp, type SearchParams } from "@/components/ui";
import { SubmitButton } from "@/components/submit-button";
import { AutoRefresh } from "@/components/auto-refresh";
import { isStale } from "@/lib/chat/agent";
import { CHARACTERS } from "@/lib/video/characters";
import type { ChatMessage, ContentPiece } from "@/lib/schemas";
import { approveChatPostsAction, sendChatAction } from "./actions";

export const dynamic = "force-dynamic";

const STARTERS = [
  "What videos should we make this week? Look at what's working for our competitors.",
  "Make a 25-second quiz video about which waste goes in the dry bin.",
  "Make a fun Hindi cartoon about saving electricity in summer.",
  "Make an explainer with Dadi: 3 easy plastic swaps for the kitchen.",
];

const KIND_LABEL: Record<string, string> = { quiz: "Quiz", myth: "Myth vs fact", hack: "Eco hack", cartoon: "Cartoon story", explainer: "Explainer" };

const fmtIst = (d: string) => new Date(d).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

function SendForm({ chatId, text, label, className }: { chatId: string; text: string; label: string; className?: string }) {
  return (
    <form action={sendChatAction} style={{ display: "inline" }}>
      <input type="hidden" name="chat" value={chatId} />
      <input type="hidden" name="text" value={text} />
      <SubmitButton pendingText="Sending…" className={className}>{label}</SubmitButton>
    </form>
  );
}

function Message({ m, chatId, posts }: { m: ChatMessage; chatId: string; posts: ContentPiece[] }) {
  const mine = m.role === "user";
  const stale = isStale(m);
  const waiting = posts.filter((p) => p.status === "needs-review");
  const name = m.video?.file ? path.basename(m.video.file) : "";
  return (
    <div className={`chat-msg ${mine ? "mine" : "theirs"}`}>
      <div className="chat-meta">{mine ? m.by : "Claude"} · {fmtIst(m.at)}</div>
      <div className="chat-bubble">
        {m.text ? <p style={{ whiteSpace: "pre-wrap", margin: 0 }}>{m.text}</p> : null}

        {m.status === "working" && !stale ? (
          <p className="chat-working" aria-live="polite"><span className="chat-dots" aria-hidden /> {m.progress || "Working…"}</p>
        ) : null}
        {stale ? <p className="warn-text">This stopped because the app restarted. Send your message again.</p> : null}
        {m.status === "failed" ? <p className="warn-text">{m.error || "Something went wrong."}</p> : null}

        {m.video ? (
          <div className="chat-video">
            <div className="muted" style={{ fontSize: "0.85rem" }}>
              🎬 {KIND_LABEL[m.video.kind] ?? m.video.kind}
              {m.video.character ? ` · ${CHARACTERS.find((c) => c.id === m.video!.character)?.name ?? m.video.character}` : ""}
              {m.video.durationSec ? ` · ${Math.round(m.video.durationSec)} s` : ""}
            </div>
            {name ? (
              <>
                <video controls playsInline preload="metadata" src={`/api/videos/${name}`} />
                <div className="row" style={{ gap: "0.5rem", flexWrap: "wrap" }}>
                  <a className="btn secondary" href={`/api/videos/${name}?download=1`}>⬇ Download</a>
                  <SendForm chatId={chatId} text="Post this video on Instagram, Facebook and YouTube at the next free slot." label="📤 Post it" />
                </div>
              </>
            ) : null}
          </div>
        ) : null}

        {m.ideas.length ? (
          <ol className="chat-ideas">
            {m.ideas.map((i) => (
              <li key={i.title}>
                <b>{i.title}</b> <span className="badge">{KIND_LABEL[i.kind] ?? i.kind}</span>
                {i.hook ? <div>“{i.hook}”</div> : null}
                {i.why ? <div className="muted" style={{ fontSize: "0.88rem" }}>{i.why}</div> : null}
                {i.inspiredBy ? <div className="muted" style={{ fontSize: "0.8rem" }}>Inspired by: {i.inspiredBy}</div> : null}
                <SendForm chatId={chatId} text={`Make this idea as a ${i.kind} video: ${i.title}. Hook: ${i.hook}`} label="🎬 Make this" className="secondary" />
              </li>
            ))}
          </ol>
        ) : null}

        {posts.length ? (
          <div className="chat-posts">
            {posts.map((p) => (
              <div key={p.id} className="row" style={{ gap: "0.5rem", flexWrap: "wrap" }}>
                <Link href={`/content/${p.id}`}>{p.platform}</Link>
                <span className="muted">{p.plannedDate} {p.plannedTime}</span>
                <StatusBadge status={p.status} />
                {p.publishedUrl ? <a href={p.publishedUrl} target="_blank" rel="noreferrer">open ↗</a> : null}
              </div>
            ))}
            {waiting.length ? (
              <form action={approveChatPostsAction}>
                <input type="hidden" name="chat" value={chatId} />
                <input type="hidden" name="ids" value={waiting.map((p) => p.id).join(",")} />
                <SubmitButton pendingText="Approving…">✅ Approve &amp; schedule {waiting.length > 1 ? `all ${waiting.length}` : ""}</SubmitButton>
              </form>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export default async function ChatPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const db = await readDb();
  const brand = activeBrand(db);
  const chats = db.chats.filter((c) => c.brandId === brand.id).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const wanted = sp(params, "c");
  const chat = wanted === "new" ? undefined : (chats.find((c) => c.id === wanted) ?? (wanted ? undefined : chats[0]));
  const chatId = chat?.id ?? "";
  const busy = !!chat?.messages.some((m) => m.status === "working" && !isStale(m));
  const postsOf = (m: ChatMessage) => m.postIds.map((id) => db.content.find((c) => c.id === id)).filter((p): p is ContentPiece => !!p);

  return (
    <>
      <AutoRefresh active={busy} />
      <PageHead title="Chat" intro="Talk to Claude to make videos, change them, post them, and get ideas from what works for competitors. Nothing goes live until someone presses Approve." />
      <Flash params={params} />

      <div className="chat-layout">
        <aside className="chat-list card">
          <Link className="btn" href="/chat?c=new">＋ New chat</Link>
          <ul className="list">
            {chats.slice(0, 30).map((c) => (
              <li key={c.id}>
                <Link href={`/chat?c=${c.id}`} aria-current={c.id === chatId ? "page" : undefined}>{c.title || "Chat"}</Link>
                <div className="muted" style={{ fontSize: "0.78rem" }}>{fmtIst(c.updatedAt)}</div>
              </li>
            ))}
          </ul>
        </aside>

        <section className="chat-main card">
          <div className="chat-thread">
            {chat?.messages.length ? (
              chat.messages.map((m) => <Message key={m.id} m={m} chatId={chatId} posts={postsOf(m)} />)
            ) : (
              <div className="chat-empty">
                <p><b>What shall we make?</b> Try one of these, or type your own:</p>
                <div className="stack">
                  {STARTERS.map((s) => <SendForm key={s} chatId={chatId} text={s} label={s} className="secondary chat-starter" />)}
                </div>
                <p className="muted" style={{ fontSize: "0.85rem" }}>Hosts you can ask for: {CHARACTERS.map((c) => `${c.emoji} ${c.name}`).join(" · ")}. Video kinds: quiz, myth vs fact, eco hack, cartoon story, explainer.</p>
              </div>
            )}
            <div id="end" />
          </div>

          <form action={sendChatAction} className="chat-composer">
            <input type="hidden" name="chat" value={chatId} />
            <label htmlFor="chat-text" className="sr-only">Message</label>
            <textarea id="chat-text" name="text" required minLength={2} maxLength={3000} rows={2} placeholder={busy ? "Claude is working… you can still type the next message" : "e.g. make it shorter and use Dadi"} />
            <SubmitButton pendingText="Sending…">Send</SubmitButton>
          </form>
        </section>
      </div>
    </>
  );
}
