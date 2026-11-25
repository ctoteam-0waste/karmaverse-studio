import Link from "next/link";
import { activeBrand, readDb } from "@/lib/db";
import { FormatSchema, PlatformSchema } from "@/lib/schemas";
import { generateBrief } from "@/lib/services/generation";
import { CopyButton } from "@/components/copy-button";
import { Flash, PageHead, sp, type SearchParams } from "@/components/ui";
import { importManualBriefAction } from "../../actions";

export default async function ManualBrief({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const db = await readDb();
  const brand = activeBrand(db);
  const idea = db.ideas.find((i) => i.id === sp(params, "ideaId"));
  if (!idea) return <div className="flash err">Idea not found. <Link href="/video">Back</Link></div>;
  const target = sp(params, "target");
  const [p, f] = target.split("/");
  const d = Number(sp(params, "d")) || 30;
  const { manualPrompt } = await generateBrief(brand, idea, PlatformSchema.parse(p), FormatSchema.parse(f), d, "manual");

  return (
    <>
      <PageHead title="Manual mode: brief with Claude chat" intro="Free with your Claude subscription. No API credits are used." />
      <Flash params={params} />
      <div className="grid two">
        <section className="card stack">
          <h2>1. Copy into Claude <CopyButton text={manualPrompt ?? ""} label="Copy prompt" /></h2>
          <pre style={{ maxHeight: 420, overflow: "auto" }}>{manualPrompt}</pre>
        </section>
        <section className="card">
          <h2>2. Paste the JSON answer</h2>
          <form action={importManualBriefAction} className="stack">
            <input type="hidden" name="ideaId" value={idea.id} />
            <input type="hidden" name="target" value={target} />
            <input type="hidden" name="d" value={d} />
            <textarea name="pasted" rows={16} required placeholder='{"title":"...","hooks":["","",""], ...}' />
            <button type="submit">Import brief</button>
          </form>
        </section>
      </div>
    </>
  );
}
