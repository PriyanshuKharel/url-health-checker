import Link from 'next/link';

export default function BatchNotFound() {
  return (
    <section className="card">
      <h1>Batch not found</h1>
      <p className="muted">There is no batch with that id.</p>
      <Link href="/">← All batches</Link>
    </section>
  );
}
