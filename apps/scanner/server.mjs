// Any Node host: node server.mjs (PORT, default 8787)
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { handleScan } from './src/handler.mjs';
import { handleOg, handlePage } from './src/share.mjs';

const PUBLIC = new URL('./public/', import.meta.url);
const TYPES = { html: 'text/html; charset=utf-8', svg: 'image/svg+xml', png: 'image/png', json: 'application/json' };

async function send(res, r) {
  res.writeHead(r.status, Object.fromEntries(r.headers));
  if (!r.body) return res.end();
  const body = Readable.fromWeb(r.body);
  res.on('close', () => body.destroy());
  body.pipe(res);
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname === '/api/scan') return send(res, await handleScan(new Request(url), { ip: req.socket.remoteAddress }));
  if (url.pathname === '/api/og') return send(res, await handleOg(new Request(url)));
  if (url.pathname.startsWith('/d/')) return send(res, await handlePage(new Request(url)));
  const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  if (!/^(results\/[a-z0-9.-]+\.json|[\w-]+\.(html|svg|png))$/.test(name)) return res.writeHead(404).end('Not found');
  try {
    const file = await readFile(new URL(name, PUBLIC));
    res.writeHead(200, { 'content-type': TYPES[name.split('.').pop()] }).end(file);
  } catch {
    res.writeHead(404).end('Not found');
  }
}).listen(Number(process.env.PORT ?? 8787), () => console.log(`scanner on http://localhost:${process.env.PORT ?? 8787}`));
