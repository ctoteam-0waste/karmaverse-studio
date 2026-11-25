import { currentUser } from "@/lib/session";

/** The "your name" field: hidden when someone is signed in (their name is used), a text box otherwise. */
export async function ActorField({ label = "Your name", required = true, width = 160 }: { label?: string; required?: boolean; width?: number }) {
  const user = await currentUser();
  if (user) return <input type="hidden" name="actor" value={user} />;
  return <input name="actor" placeholder={label} aria-label={label} required={required} style={{ width }} />;
}
