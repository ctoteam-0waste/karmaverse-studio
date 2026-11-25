"use client";

import { useState } from "react";

/** Copies text to the clipboard. Falls back to selecting the text if the clipboard API is blocked. */
export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [state, setState] = useState<"idle" | "done" | "failed">("idle");
  return (
    <button
      type="button"
      className="secondary small"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setState("done");
        } catch {
          setState("failed");
        }
        setTimeout(() => setState("idle"), 2000);
      }}
    >
      {state === "done" ? "Copied" : state === "failed" ? "Select and copy manually" : label}
    </button>
  );
}
