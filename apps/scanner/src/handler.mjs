import { domainOf, headline, scanDomain } from 'permalock';

const HOST_RE = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const MAX_CHECKS = Number(process.env.PERMALOCK_MAX_CHECKS ?? 400);

/** A public hostname, or undefined: never an IP, localhost or an internal name. */
export function publicDomain(input) {
  try {
    const d = domainOf(String(input ?? '').trim().toLowerCase());
    return HOST_RE.test(d) && !/\.(local|internal|localhost|test|example)$/.test(d) ? d : undefined;
  } catch {
    return undefined;
  }
}

/**
 * GET /api/scan?d=example.com -> NDJSON stream: {"step"} and {"progress"} lines,
 * then {"done": summary, "headline"} or {"error"}.
 */
export async function handleScan(request, { fetch } = {}) {
  const domain = publicDomain(new URL(request.url).searchParams.get('d'));
  if (!domain) return Response.json({ error: 'Enter a public domain, like example.com' }, { status: 400 });
  const enc = new TextEncoder();
  const body = new ReadableStream({
    async start(ctrl) {
      const send = (o) => ctrl.enqueue(enc.encode(JSON.stringify(o) + '\n'));
      let last = 0;
      try {
        send({ step: `Collecting every URL ${domain} ever published…` });
        const summary = await scanDomain(domain, {
          fetch,
          max: MAX_CHECKS,
          concurrency: 12,
          limit: 20000,
          onStep: (step) => send({ step }),
          onProgress: (done, total) => {
            if (done === total || Date.now() - last > 250) send({ progress: [done, total] }), (last = Date.now());
          },
        });
        send({ done: summary, headline: headline(summary) });
      } catch (e) {
        send({ error: e instanceof Error ? e.message : String(e) });
      }
      ctrl.close();
    },
  });
  return new Response(body, {
    headers: { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'public, s-maxage=86400, stale-while-revalidate=604800' },
  });
}
