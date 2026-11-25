"use client";

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="card">
      <h1>Something went wrong</h1>
      <p>{error.message || "An unexpected error occurred."}</p>
      <p className="muted">Details are in the terminal where the app is running{error.digest ? ` (ref ${error.digest})` : ""}.</p>
      <button type="button" onClick={reset}>Try again</button>
    </div>
  );
}
