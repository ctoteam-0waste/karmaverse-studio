"use client";

import { useState } from "react";

/**
 * Sends a post to the person who puts it up by hand (e.g. LinkedIn), on WhatsApp.
 * On a phone it shares the text and the video/images together (pick the person
 * in WhatsApp). On a computer it opens WhatsApp with the text and downloads the
 * files, to attach in the chat.
 */
export function SendToPerson({ person, text, files }: { person: string; text: string; files: Array<{ url: string; name: string }> }) {
  const [note, setNote] = useState("");

  function download(url: string, name: string) {
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
  }

  async function send() {
    try {
      if (files.length && navigator.canShare) {
        setNote("Preparing the files…");
        const blobs = await Promise.all(files.map(async (f) => new File([await (await fetch(f.url)).blob()], f.name, { type: /\.mp4$/i.test(f.name) ? "video/mp4" : "image/jpeg" })));
        if (navigator.canShare({ files: blobs })) {
          // WhatsApp keeps only the files, not the text, when both are shared, so copy the text too.
          await navigator.clipboard?.writeText(text).catch(() => undefined);
          await navigator.share({ files: blobs, text });
          setNote(`Shared. Pick ${person} in WhatsApp. The text is also copied: paste it in the chat if it didn't come through.`);
          return;
        }
      }
      window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, "_blank", "noreferrer");
      files.forEach((f) => download(f.url, f.name));
      setNote(files.length ? `WhatsApp opened with the text, and the ${files.length > 1 ? "files were" : "file was"} downloaded. Pick ${person}, then attach the download.` : `WhatsApp opened with the text. Pick ${person}.`);
    } catch (err) {
      if ((err as Error).name !== "AbortError") setNote(`Couldn't send: ${(err as Error).message}`);
      else setNote("");
    }
  }

  return (
    <div className="stack" style={{ gap: "0.4rem" }}>
      <button type="button" className="big secondary" onClick={send}>📲 Send to {person} (WhatsApp)</button>
      {note ? <p className="flash ok" role="status" style={{ margin: 0 }}>{note}</p> : null}
    </div>
  );
}
