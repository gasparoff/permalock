// Any Node host: node server.mjs (PORT, default 8787)
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { handleScan } from './src/handler.mjs';

const page = new URL('./public/index.html', import.meta.url);

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname === '/api/scan') {
    const r = await handleScan(new Request(url));
    res.writeHead(r.status, Object.fromEntries(r.headers));
    return r.body ? Readable.fromWeb(r.body).pipe(res) : res.end();
  }
  if (url.pathname !== '/') return res.writeHead(404).end('Not found');
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(await readFile(page));
}).listen(Number(process.env.PORT ?? 8787), () => console.log(`scanner on http://localhost:${process.env.PORT ?? 8787}`));
