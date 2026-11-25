import { Fragment } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { readDb } from "@/lib/db";
import { analysisMetrics, diagnose, scorePosts } from "@/lib/analytics/engine";
import { metricsFor } from "@/lib/analytics/metrics";
import { fmtDate, fmtDiff, fmtScore, PageHead, PLATFORM_LABEL, SampleBadge } from "@/components/ui";

export default async function DiagnosePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = await readDb();
  const post = db.metrics.find((m) => m.id === id);
  if (!post) notFound();
  const scored = scorePosts(analysisMetrics(db.metrics, post.brandId));
  const target = scored.find((s) => s.post.id === id)!;
  const d = diagnose(target, scored);
  const defs = metricsFor(post.platform, post.format);

  return (
    <>
      <PageHead title={post.hook || "Post diagnosis"} intro={`${PLATFORM_LABEL[post.platform]} ${post.format} · posted ${fmtDate(post.postedAt)}`}>
        <SampleBadge show={post.isSample} />
        <Link className="btn secondary" href="/analytics">Analytics</Link>
      </PageHead>
      <div className="grid two">
        <section className="card">
          <h2>What the numbers show</h2>
          <ul>{d.findings.map((f) => <li key={f}>{f}</li>)}</ul>
          {d.suggestions.length ? (<><h3>What to test next</h3><ul>{d.suggestions.map((s) => <li key={s}>{s}</li>)}</ul></>) : null}
          <p className="muted">Based only on metrics recorded for this post and similar posts. Single posts vary a lot; confirm with an experiment before changing strategy.</p>
        </section>
        <section className="card">
          <h2>Scores</h2>
          <dl className="kv">
            <dt>{defs?.primary.label}</dt><dd>{fmtScore(target.score, defs?.primary.format)} {target.vsHistory ? <>({fmtDiff(target.vsHistory.diff)} vs {target.vsHistory.priorCount} earlier posts)</> : null}</dd>
            {Object.entries(target.ratios).map(([k, v]) => (<Fragment key={k}><dt>{defs?.ratios[k]?.label ?? k}</dt><dd>{fmtScore(v, defs?.ratios[k]?.format)}</dd></Fragment>))}
          </dl>
          <h3 style={{ marginTop: "1rem" }}>Raw metrics</h3>
          <dl className="kv">
            {defs?.metrics.filter((m) => post.metrics[m.key] !== undefined).map((m) => (<Fragment key={m.key}><dt>{m.label}</dt><dd>{post.metrics[m.key]}</dd></Fragment>))}
          </dl>
        </section>
      </div>
    </>
  );
}
