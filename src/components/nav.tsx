"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// The things people do every day. Everything else lives under "More tools".
const MAIN = [
  ["/", "🏠", "Home"],
  ["/chat", "🎬", "Chat"],
  ["/command", "💬", "Tell the team"],
  ["/approve", "✅", "Approve"],
  ["/calendar", "📅", "Calendar"],
  ["/share", "📲", "Share"],
  ["/studio", "✨", "Create"],
  ["/dashboard", "📈", "Dashboard"],
  ["/analytics", "📊", "Results"],
] as const;

const MORE = [
  ["/video", "Video Director"],
  ["/growth", "Growth Booster"],
  ["/inbox", "Comments inbox"],
  ["/team", "Team engagement"],
  ["/trends", "Trends"],
  ["/tracking", "SEO · LLMO · ASO · Blog"],
  ["/competitors", "Competitors"],
  ["/publishing", "Publishing & accounts"],
  ["/music", "Music"],
  ["/experiments", "Experiments"],
  ["/settings", "Settings"],
] as const;

function isActive(path: string, href: string) {
  if (href === "/") return path === "/";
  if (href === "/calendar") return path.startsWith("/calendar") || path.startsWith("/content");
  return path.startsWith(href);
}

export function Nav({ reviewCount }: { reviewCount: number }) {
  const path = usePathname();
  const moreOpen = MORE.some(([href]) => isActive(path, href));
  return (
    <nav className="nav" aria-label="Main">
      <div className="nav-main">
        {MAIN.map(([href, icon, label]) => (
          <Link key={href} href={href} aria-current={isActive(path, href) ? "page" : undefined}>
            <span className="nav-icon" aria-hidden>{icon}</span>
            <span>{label}</span>
            {href === "/approve" && reviewCount > 0 ? <span className="nav-count" aria-label={`${reviewCount} waiting`}>{reviewCount}</span> : null}
          </Link>
        ))}
      </div>
      <details className="nav-more" open={moreOpen}>
        <summary>More tools</summary>
        {MORE.map(([href, label]) => (
          <Link key={href} href={href} aria-current={isActive(path, href) ? "page" : undefined}>
            {label}
          </Link>
        ))}
      </details>
    </nav>
  );
}
