import http from 'node:http';
import type { AddressInfo } from 'node:net';

export type Route = { status: number; location?: string; body?: string; type?: string };

/** Tiny HTTP server answering from a route table. */
export async function serve(routes: Record<string, Route>, opts: { noHead?: boolean } = {}) {
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    if (opts.noHead && req.method === 'HEAD') {
      res.writeHead(405).end();
      return;
    }
    const r = routes[req.url!.split('?')[0]] ?? { status: 404, body: 'not found' };
    res.writeHead(r.status, { 'content-type': r.type ?? 'text/html', ...(r.location ? { location: r.location } : {}) });
    res.end(req.method === 'HEAD' ? undefined : r.body ?? '');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { origin, hits, close: () => new Promise((r) => server.close(r)) };
}
