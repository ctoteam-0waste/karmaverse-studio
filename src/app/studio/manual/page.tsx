import Link from "next/link";
import { activeBrand, readDb } from "@/lib/db";
import { FormatSchema, PlatformSchema } from "@/lib/schemas";
import { generateContent } from "@/lib/services/generation";
import { CopyButton } from "@/components/copy-button";
import { Flash, PageHead, sp, type SearchParams } from "@/components/ui";
import { importManualContentAction } from "../../actions";

export default async function ManualContent({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const db = await readDb();
  const brand = activeBrand(db);
  const idea = db.ideas.find((i) => i.id === sp(params, "ideaId"));
  const targetsRaw = sp(params, "targets");
  if (!idea) return <div className="flash err">Idea not found. <Link href="/studio">Back to Content Studio</Link></div>;

  const targets = targetsRaw.split(",").filter(Boolean).map((t) => {
    const [p, f] = t.split("/");
    return { platform: PlatformSchema.parse(p), format: FormatSchema.parse(f) };
  });
  const { manualPrompt } = await generateContent(brand, idea, targets, "manual");

  return (
    <>
      <PageHead title="Manual mode: write with Claude chat" intro="Free with your Claude subscription. No API key or API credits are used." />
      <Flash params={params} />
      <div className="grid two">
        <section className="card stack">
          <h2>1. Copy this prompt into Claude <CopyButton text={manualPrompt ?? ""} label="Copy prompt" /></h2>
          <pre style={{ maxHeight: 420, overflow: "auto" }}>{manualPrompt}</pre>
        </section>
        <section className="card">
          <h2>2. Paste Claude's JSON answer</h2>
          <form action={importManualContentAction} className="stack">
            <input type="hidden" name="ideaId" value={idea.id} />
            <input type="hidden" name="targets" value={targetsRaw} />
            <textarea name="pasted" rows={16} placeholder='[{"platform":"instagram","format":"reel","hook":"...", ...}]' required />
            <button type="submit">Import as drafts</button>
          </form>
          <p className="muted" style={{ marginTop: "0.75rem" }}>The answer is checked against the expected shape before anything is saved. Drafts still need review and approval.</p>
        </section>
      </div>
    </>
  );
}
