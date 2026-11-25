import Link from "next/link";

export default function NotFound() {
  return (
    <div className="card">
      <h1>Not found</h1>
      <p>That item doesn't exist. It may have been deleted.</p>
      <Link className="btn" href="/">Back to overview</Link>
    </div>
  );
}
