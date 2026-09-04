'use client';

import { useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { LIMITS } from '@uhc/shared';
import { api, ApiError } from '@/lib/api';
import { extractUrlsFromCsv } from '@/lib/csv';

const MOCK_URL = process.env.NEXT_PUBLIC_MOCK_URL ?? 'http://mock:4100';

/** A mix of fast, slow, failing, flaky and redirecting URLs against the bundled mock server. */
function demoUrls(): string[] {
  const urls: string[] = [];
  for (let i = 1; i <= 24; i++) urls.push(`${MOCK_URL}/ok?n=${i}&delay=${100 + (i % 6) * 150}`);
  for (let i = 1; i <= 4; i++) urls.push(`${MOCK_URL}/flaky?p=0.6&n=${i}`);
  urls.push(`${MOCK_URL}/status/404`, `${MOCK_URL}/status/500`, `${MOCK_URL}/status/301`);
  urls.push(`${MOCK_URL}/redirect/3`, `${MOCK_URL}/slow?delay=20000`);
  urls.push('https://example.com', 'https://this-domain-does-not-exist-xyz.invalid');
  return urls;
}

export function NewBatchForm() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [text, setText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // One key per submission attempt: a retried click after a network blip replays the
  // same key and gets the same batch back instead of creating a duplicate.
  const idempotencyKey = useRef<string | null>(null);

  const urls = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  async function onFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const content = await file.text();
    const found = extractUrlsFromCsv(content);
    setText((prev) => [prev.trim(), ...found].filter(Boolean).join('\n'));
    if (!name) setName(file.name.replace(/\.csv$/i, ''));
    e.target.value = '';
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (urls.length === 0 || submitting) return;
    setSubmitting(true);
    setError(null);
    idempotencyKey.current ??= crypto.randomUUID();
    try {
      const res = await api.createBatch({ name: name || undefined, urls }, idempotencyKey.current);
      idempotencyKey.current = null;
      router.push(`/batches/${res.batch.id}`);
    } catch (err) {
      if (err instanceof ApiError) {
        const invalid = (err.body.details as { invalid?: string[] } | undefined)?.invalid;
        setError(invalid?.length ? `${err.body.error}: ${invalid.slice(0, 5).join(', ')}${invalid.length > 5 ? '…' : ''}` : err.body.error);
        // A validation error means the request was rejected; the key is safe to reuse.
        if (err.status >= 500) idempotencyKey.current = null;
      } else {
        setError('Could not reach the API. Your submission is safe to retry.');
      }
      setSubmitting(false);
    }
  }

  return (
    <form className="card" onSubmit={onSubmit}>
      <h2>New batch</h2>
      <label>
        Name <span className="muted">(optional)</span>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Marketing site links" maxLength={120} />
      </label>
      <label>
        URLs, one per line <span className="muted">(max {LIMITS.MAX_URLS_PER_BATCH})</span>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={8}
          placeholder={'https://example.com\nhttps://example.org/about'}
          spellCheck={false}
        />
      </label>
      <div className="row">
        <label className="file">
          Upload CSV
          <input type="file" accept=".csv,text/csv,text/plain" onChange={onFile} />
        </label>
        <button type="button" className="secondary" onClick={() => setText(demoUrls().join('\n'))}>
          Fill with demo URLs
        </button>
        <span className="muted">{urls.length} URL{urls.length === 1 ? '' : 's'}</span>
        <button type="submit" disabled={submitting || urls.length === 0 || urls.length > LIMITS.MAX_URLS_PER_BATCH}>
          {submitting ? 'Submitting…' : 'Check URLs'}
        </button>
      </div>
      {error && <p className="error">{error}</p>}
    </form>
  );
}
