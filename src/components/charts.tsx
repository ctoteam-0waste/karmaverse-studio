/**
 * Small server-rendered SVG charts for the dashboard (no chart library).
 * Colours: one per traffic channel, the same everywhere.
 */

export const CHANNEL_COLOR: Record<string, string> = {
  "Organic Search": "#15803d",
  Direct: "#94a3b8",
  "Organic Social": "#2563eb",
  "Paid Social": "#60a5fa",
  "AI Assistant": "#7c3aed",
  Referral: "#ca8a04",
  Email: "#db2777",
  Unassigned: "#cbd5e1",
};
const colorOf = (c: string) => CHANNEL_COLOR[c] ?? "#64748b";

const fmt = (n: number) => (n >= 100000 ? `${(n / 100000).toFixed(1)}L` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n)));
const dayLabel = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });

/** Visits per day, stacked by channel. */
export function StackedDaily({ rows, title }: { rows: Array<{ date: string; channel: string; sessions: number }>; title: string }) {
  const days = [...new Set(rows.map((r) => r.date))].sort();
  const totals = new Map<string, number>();
  for (const r of rows) totals.set(r.channel, (totals.get(r.channel) ?? 0) + r.sessions);
  const channels = [...totals.keys()].sort((a, b) => (totals.get(b) ?? 0) - (totals.get(a) ?? 0));
  const perDay = days.map((d) => ({ d, by: new Map(rows.filter((r) => r.date === d).map((r) => [r.channel, r.sessions])) }));
  const peak = Math.max(1, ...perDay.map((p) => [...p.by.values()].reduce((s, v) => s + v, 0)));
  const W = 760, H = 240, x0 = 36, y0 = 16, h = 180, bw = (W - x0 - 10) / Math.max(1, days.length);
  return (
    <figure style={{ margin: 0 }}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={title} style={{ width: "100%", height: "auto" }} fontSize="11">
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line x1={x0} x2={W - 10} y1={y0 + h - f * h} y2={y0 + h - f * h} stroke="var(--line)" />
            <text x={x0 - 6} y={y0 + h - f * h + 4} textAnchor="end" fill="var(--muted)">{Math.round(peak * f)}</text>
          </g>
        ))}
        {perDay.map((p, i) => {
          let acc = 0;
          return (
            <g key={p.d}>
              {channels.map((c) => {
                const v = p.by.get(c) ?? 0;
                if (!v) return null;
                const y = y0 + h - ((acc + v) / peak) * h;
                const height = (v / peak) * h;
                acc += v;
                return (
                  <rect key={c} x={x0 + i * bw + 1} y={y} width={Math.max(1, bw - 2)} height={height} fill={colorOf(c)}>
                    <title>{`${dayLabel(p.d)} · ${c}: ${v} visits`}</title>
                  </rect>
                );
              })}
              {i % Math.ceil(days.length / 7) === 0 ? <text x={x0 + i * bw + bw / 2} y={H - 26} textAnchor="middle" fill="var(--muted)">{dayLabel(p.d)}</text> : null}
            </g>
          );
        })}
      </svg>
      <figcaption className="row" style={{ gap: "0.8rem", fontSize: "0.82rem", flexWrap: "wrap" }}>
        {channels.map((c) => (
          <span key={c}><span style={{ display: "inline-block", width: 10, height: 10, background: colorOf(c), borderRadius: 2, marginRight: 4 }} />{c} {fmt(totals.get(c) ?? 0)}</span>
        ))}
      </figcaption>
    </figure>
  );
}

/** One measure per day as a line, with an optional second measure as light bars behind it. */
export function DailyLine({ rows, line, bars, title }: { rows: Array<{ date: string } & Record<string, number | string>>; line: { key: string; label: string }; bars?: { key: string; label: string }; title: string }) {
  const W = 760, H = 220, x0 = 36, y0 = 16, h = 160;
  const val = (r: Record<string, number | string>, k: string) => Number(r[k] ?? 0);
  const peakL = Math.max(1, ...rows.map((r) => val(r, line.key)));
  const peakB = bars ? Math.max(1, ...rows.map((r) => val(r, bars.key))) : 1;
  const step = (W - x0 - 10) / Math.max(1, rows.length);
  const pts = rows.map((r, i) => `${x0 + i * step + step / 2},${y0 + h - (val(r, line.key) / peakL) * h}`).join(" ");
  return (
    <figure style={{ margin: 0 }}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={title} style={{ width: "100%", height: "auto" }} fontSize="11">
        <line x1={x0} x2={W - 10} y1={y0 + h} y2={y0 + h} stroke="var(--line)" />
        {bars ? rows.map((r, i) => (
          <rect key={`b${r.date}`} x={x0 + i * step + 2} y={y0 + h - (val(r, bars.key) / peakB) * h} width={Math.max(1, step - 4)} height={(val(r, bars.key) / peakB) * h} fill="var(--chip)">
            <title>{`${dayLabel(String(r.date))}: ${val(r, bars.key)} ${bars.label}`}</title>
          </rect>
        )) : null}
        <polyline points={pts} fill="none" stroke="var(--ok)" strokeWidth="2.5" />
        {rows.map((r, i) => (
          <circle key={`p${r.date}`} cx={x0 + i * step + step / 2} cy={y0 + h - (val(r, line.key) / peakL) * h} r="3" fill="var(--ok)">
            <title>{`${dayLabel(String(r.date))}: ${val(r, line.key)} ${line.label}${bars ? `, ${val(r, bars.key)} ${bars.label}` : ""}`}</title>
          </circle>
        ))}
        <text x={x0 - 6} y={y0 + 4} textAnchor="end" fill="var(--ok)">{fmt(peakL)}</text>
        {rows.map((r, i) => (i % Math.ceil(rows.length / 7) === 0 ? <text key={`l${r.date}`} x={x0 + i * step + step / 2} y={H - 26} textAnchor="middle" fill="var(--muted)">{dayLabel(String(r.date))}</text> : null))}
      </svg>
      <figcaption style={{ fontSize: "0.82rem", color: "var(--muted)" }}>
        <span style={{ color: "var(--ok)", fontWeight: 600 }}>— {line.label}</span>{bars ? <> · <span style={{ display: "inline-block", width: 10, height: 10, background: "var(--chip)", border: "1px solid var(--line)", marginRight: 4 }} />{bars.label}</> : null} · hover a day for numbers
      </figcaption>
    </figure>
  );
}

/** Horizontal bars, largest first, one highlighted. */
export function HBars({ rows, title, highlight, unit = "" }: { rows: Array<{ label: string; value: number; note?: string; color?: string }>; title: string; highlight?: string; unit?: string }) {
  const peak = Math.max(1, ...rows.map((r) => r.value));
  const band = 30, W = 760, x0 = 210, w = 440, H = rows.length * band + 10;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={title} style={{ width: "100%", height: "auto" }} fontSize="13">
      {rows.map((r, i) => {
        const bw = Math.max(2, (r.value / peak) * w);
        const hi = highlight === r.label;
        return (
          <g key={r.label}>
            <text x={x0 - 10} y={i * band + 20} textAnchor="end" fill={hi ? "var(--ink)" : "var(--muted)"} fontWeight={hi ? 600 : 400}>{r.label}</text>
            <rect x={x0} y={i * band + 6} width={bw} height={band - 12} rx="3" fill={r.color ?? (hi ? "var(--focus)" : "#a8b3ab")}>
              <title>{`${r.label}: ${r.value}${unit}${r.note ? ` · ${r.note}` : ""}`}</title>
            </rect>
            <text x={x0 + bw + 8} y={i * band + 20} fill="var(--ink)">{`${fmt(r.value)}${unit}`}{r.note ? <tspan fill="var(--muted)">{`  ${r.note}`}</tspan> : null}</text>
          </g>
        );
      })}
    </svg>
  );
}
