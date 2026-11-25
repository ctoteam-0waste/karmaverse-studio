"use client";

import { useState } from "react";

/** WhatsApp / copy / share-video buttons for the share pack. */
export function ShareButtons({ message, status, videoUrl, videoName }: { message: string; status: string; videoUrl: string | null; videoName: string }) {
  const [note, setNote] = useState("");
  const wa = (text: string) => `https://wa.me/?text=${encodeURIComponent(text)}`;

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setNote("Copied. Paste it in WhatsApp.");
    } catch {
      setNote("Couldn't copy: select the text and copy it.");
    }
  }

  async function shareVideo() {
    if (!videoUrl) return;
    try {
      setNote("Preparing the video…");
      const blob = await (await fetch(videoUrl)).blob();
      const file = new File([blob], videoName, { type: "video/mp4" });
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], text: status });
        setNote("Shared. In WhatsApp, pick \"My status\" or a group.");
      } else {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = videoName;
        a.click();
        await copy(status);
        setNote("Video downloaded and Status text copied. In WhatsApp: Status → add the video → paste the text.");
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") setNote(`Couldn't share: ${(err as Error).message}`);
      else setNote("");
    }
  }

  return (
    <div className="stack">
      <div className="row share-row">
        <a className="btn big wa" href={wa(message)} target="_blank" rel="noreferrer">📲 Send to WhatsApp groups</a>
        <a className="btn big secondary" href={wa(status)} target="_blank" rel="noreferrer">🟢 Post links to my Status</a>
        {videoUrl ? <button type="button" className="big secondary" onClick={shareVideo}>🎬 Share video to Status</button> : null}
        <button type="button" className="big secondary" onClick={() => copy(message)}>📋 Copy message</button>
      </div>
      {note ? <p className="flash ok" role="status" style={{ margin: 0 }}>{note}</p> : null}
    </div>
  );
}
