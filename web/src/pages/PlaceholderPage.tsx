import { Link } from 'react-router-dom';

export function PlaceholderPage({ title }: { title: string }) {
  return (
    <main className="center">
      <section className="card">
        <h1>{title}</h1>
        <p>[Owner to review before launch]</p>
        <p className="muted small">
          <Link to="/">Back to dashboard</Link>
        </p>
      </section>
    </main>
  );
}
