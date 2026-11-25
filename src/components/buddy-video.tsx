import { BUDDY_STYLE_LABEL, BUDDY_STYLES } from "@/lib/video/buddy";
import { makeBuddyVideoAction } from "@/app/actions";
import { ActorField } from "./actor-field";
import { SubmitButton } from "./submit-button";

/** One-tap "make a new Earth Buddy video" for a post. Each new video gets a different look. */
export function BuddyVideoForm({ id, back, compact = false, hasVideo }: { id: string; back: string; compact?: boolean; hasVideo: boolean }) {
  const label = hasVideo ? "🎬 Make a different video" : "🎬 Make an Earth Buddy video";
  return (
    <form action={makeBuddyVideoAction} className={compact ? "buddy-form compact" : "buddy-form"}>
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="back" value={back} />
      <ActorField required={false} />
      {compact ? (
        <input type="hidden" name="style" value="auto" />
      ) : (
        <label>
          Style
          <select name="style" defaultValue="auto">
            <option value="auto">✨ Surprise me (different every time)</option>
            {BUDDY_STYLES.map((s) => <option key={s} value={s}>{BUDDY_STYLE_LABEL[s]}</option>)}
          </select>
        </label>
      )}
      <SubmitButton className={compact ? "secondary big" : "big"} pendingText="Making the video… about 2 minutes">{label}</SubmitButton>
      {!compact ? <p className="muted" style={{ margin: 0 }}>Earth Buddy reads the post&apos;s hook, main points and question aloud, with a new colour theme, layout and music each time. Takes about 2 minutes.</p> : null}
    </form>
  );
}
