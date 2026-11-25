import { readFile } from 'node:fs/promises';
import { domainOf, headline, scanDomain } from 'permalock';

const HOST_RE = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const RESERVED = /(^|\.)(localhost|local|internal|intranet|lan|home|corp|test|example|invalid|onion)$/;
const MAX_CHECKS = Number(process.env.PERMALOCK_MAX_CHECKS ?? 200);
const RESULTS = new URL('../public/results/', import.meta.url);

/** A public hostname, or undefined: never an IP, localhost or an internal name. */
export function publicDomain(input) {
  const raw = String(input ?? '')
    .trim()
    .toLowerCase();
  if (!raw || raw.length > 300 || /\s/.test(raw)) return undefined;
  try {
    const d = domainOf(raw).replace(/\.$/, '');
    return HOST_RE.test(d) && !RESERVED.test(d) ? d : undefined;
  } catch {
    return undefined;
  }
}

/** A result computed ahead of time (public/results/<domain>.json), if any. */
export async function storedResult(domain) {
  try {
    return JSON.parse(await readFile(new URL(`${domain}.json`, RESULTS), 'utf8'));
  } catch {
    return undefined;
  }
}

// Per instance: recent successful scans, and fresh scans per client.
const recent = new Map();
const RECENT_MS = 60 * 60 * 1000;
const hits = new Map();
const LIMIT = Number(process.env.PERMALOCK_SCANS_PER_HOUR ?? 10);

/** A successful scan this instance ran in the last hour, if any. */
export function recentResult(domain) {
  const hit = recent.get(domain);
  return hit && Date.now() - hit.at < RECENT_MS ? hit.result : undefined;
}

function allowed(ip) {
  const now = Date.now();
  const list = (hits.get(ip) ?? []).filter((t) => now - t < 3600_000);
  if (list.length >= LIMIT) return false;
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 10_000) hits.clear();
  return true;
}

const ndjson = (lines, cache) =>
  new Response(lines.map((l) => JSON.stringify(l) + '\n').join(''), {
    headers: { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': cache, 'x-content-type-options': 'nosniff' },
  });

/**
 * GET /api/scan?d=example.com[&fresh=1] -> NDJSON stream, one event per line:
 *   {"start": {domain}}
 *   {"source": {name, count, error?}}       each history source as it finishes
 *   {"history": {published, checking}}      before the live checks
 *   {"progress": [done, total], counts}     live checks so far, throttled
 *   {"done": summary, "headline", stored?, notice?} | {"error": message}   always last
 *   (a failed live scan falls back to an earlier result, with the failure as notice)
 * Stored and recent results answer at once. Live scans are never cached by a CDN,
 * so an error or a partial result is never served twice.
 */
export async function handleScan(request, { fetch, ip } = {}) {
  const url = new URL(request.url);
  const domain = publicDomain(url.searchParams.get('d'));
  if (!domain) return Response.json({ error: 'Enter a public domain, like example.com' }, { status: 400 });
  const fresh = url.searchParams.has('fresh');

  if (!fresh) {
    const hit = recentResult(domain);
    if (hit) return ndjson([{ start: { domain } }, hit], 'no-store');
    const stored = await storedResult(domain);
    if (stored)
      return ndjson([{ start: { domain } }, { done: stored.done, headline: stored.headline, stored: true }], 'public, s-maxage=3600');
  }

  const client = ip ?? request.headers.get('x-forwarded-for')?.split(',')[0].trim() ?? 'local';
  if (!allowed(client))
    return Response.json({ error: 'Too many scans from your network in the last hour. Try again later.' }, { status: 429 });

  const enc = new TextEncoder();
  let closed = false;
  const body = new ReadableStream({
    async start(ctrl) {
      const send = (o) => {
        if (!closed) ctrl.enqueue(enc.encode(JSON.stringify(o) + '\n'));
      };
      let last = 0;
      const counts = { ok: 0, redirect: 0, chain: 0, broken: 0, error: 0 };
      try {
        send({ start: { domain } });
        const summary = await scanDomain(domain, {
          fetch,
          max: MAX_CHECKS,
          concurrency: 16,
          limit: 10000,
          timeoutMs: 30000,
          checkTimeoutMs: 10000,
          onSource: (name, count, error) => send({ source: { name, count, error } }),
          onHistory: (published, checking) => send({ history: { published, checking } }),
          onProgress: (done, total, check) => {
            counts[check.state]++;
            if (done === total || Date.now() - last > 200) {
              last = Date.now();
              send({ progress: [done, total], counts });
            }
          },
        });
        const result = { done: summary, headline: headline(summary) };
        if (!summary.errors.length) recent.set(domain, { at: Date.now(), result });
        if (recent.size > 500) recent.delete(recent.keys().next().value);
        send(result);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        // the live scan failed: an earlier full result is better than nothing, if there is one
        const earlier = recentResult(domain) ?? (await storedResult(domain));
        send(earlier ? { done: earlier.done, headline: earlier.headline, stored: true, notice: message } : { error: message });
      }
      if (!closed) ctrl.close();
    },
    cancel() {
      closed = true;
    },
  });
  return new Response(body, {
    headers: { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
  });
}
