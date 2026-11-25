import { cookies } from "next/headers";
import { authConfig, SESSION_COOKIE, verifySession } from "./auth";

/** Who is using the app: the signed-in name, or null when sign-in is off or nobody is signed in. */
export async function currentUser(): Promise<string | null> {
  const cfg = authConfig();
  if (!cfg) return null;
  return verifySession((await cookies()).get(SESSION_COOKIE)?.value, cfg.secret);
}
