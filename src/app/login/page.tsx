import { redirect } from "next/navigation";
import { authConfig, safeNext } from "@/lib/auth";
import { readDb } from "@/lib/db";
import { currentUser } from "@/lib/session";
import { sp, type SearchParams } from "@/components/ui";
import { loginAction } from "../actions";

export default async function Login({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const next = safeNext(sp(params, "next"));
  if (!authConfig() || (await currentUser())) redirect(next);
  const team = (await readDb()).settings.team;
  const err = sp(params, "err");

  return (
    <div className="login">
      <form action={loginAction} className="card login-card stack">
        <div className="login-hello" aria-hidden>🌍</div>
        <h1>Welcome to the KarmaVerse studio</h1>
        <p className="muted">Sign in once on this phone or computer. Your name is saved with every post you approve.</p>
        {err ? <div className="flash err" role="alert">{err}</div> : null}
        <input type="hidden" name="next" value={next} />
        {team.length ? (
          <fieldset className="who">
            <legend>Who are you?</legend>
            {team.map((n, i) => (
              <label key={n} className="who-pick">
                <input type="radio" name="name" value={n} defaultChecked={i === 0 && team.length === 1} />
                <span>{n}</span>
              </label>
            ))}
          </fieldset>
        ) : null}
        <label>
          {team.length ? "Not in the list? Type your name" : "Your name"}
          <input name="newName" autoComplete="name" placeholder="e.g. Ayushi" required={!team.length} />
        </label>
        <label>
          Team code
          <input name="code" type="password" inputMode="numeric" autoComplete="current-password" required />
        </label>
        <button type="submit" className="big">Sign in</button>
      </form>
    </div>
  );
}
