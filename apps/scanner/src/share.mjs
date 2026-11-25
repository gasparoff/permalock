import { readFile } from 'node:fs/promises';
import { ImageResponse } from '@vercel/og';
import { publicDomain, recentResult, storedResult } from './handler.mjs';

const PAGE = new URL('../public/index.html', import.meta.url);
const ORIGIN = process.env.PERMALOCK_ORIGIN ?? 'https://permalock.dev';
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

async function resultFor(domain) {
  return domain ? (recentResult(domain) ?? (await storedResult(domain))) : undefined;
}

/** GET /d/<domain>: the scanner page with title and preview image for that domain. */
export async function handlePage(request) {
  const url = new URL(request.url);
  const domain = publicDomain(url.searchParams.get('d') ?? decodeURIComponent(/^\/d\/([^/]+)/.exec(url.pathname)?.[1] ?? ''));
  let html = await readFile(PAGE, 'utf8');
  if (domain) {
    const r = await resultFor(domain);
    const title = r ? r.headline : `How many URLs has ${domain} lost?`;
    const image = `${ORIGIN}/api/og?d=${encodeURIComponent(domain)}`;
    html = html
      .replace(/<title>[^<]*<\/title>/, `<title>${esc(title)} · Permalock</title>`)
      .replace(/(<meta property="og:title" content=")[^"]*/, `$1${esc(title)}`)
      .replace(/(<meta property="og:image" content=")[^"]*/, `$1${esc(image)}`)
      .replace(/(<meta property="og:url" content=")[^"]*/, `$1${esc(`${ORIGIN}/d/${domain}`)}`)
      .replace('</head>', `<script>window.PERMALOCK_DOMAIN=${JSON.stringify(domain)}</script>\n</head>`);
  }
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, s-maxage=600' } });
}

const h = (type, style, ...children) => ({ type, props: { style, children: children.length > 1 ? children : children[0] } });
const COLORS = { ok: '#4ade80', redirect: '#60a5fa', chain: '#fbbf24', broken: '#f87171', error: '#71717a' };

/** GET /api/og?d=<domain>: a 1200x630 preview that carries the domain's number. */
export async function handleOg(request) {
  const domain = publicDomain(new URL(request.url).searchParams.get('d'));
  const r = await resultFor(domain);
  const s = r?.done;
  const big = s ? `${s.counts.broken.toLocaleString('en-US')} broken URLs` : 'How many URLs has your site lost?';
  const small = s
    ? `${domain} has published ${s.published.toLocaleString('en-US')} URLs${s.firstSeen ? ` since ${s.firstSeen.slice(0, 4)}` : ''}. ${s.checked.toLocaleString('en-US')} checked today.`
    : domain
      ? `Scan ${domain}: every URL it ever published, checked today.`
      : 'Every URL you ever published, checked on your site today.';
  const bar = s
    ? h(
        'div',
        { display: 'flex', height: 18, width: '100%', borderRadius: 9, overflow: 'hidden' },
        ...Object.keys(COLORS)
          .filter((k) => s.counts[k])
          .map((k) => h('div', { flexGrow: s.counts[k], height: 18, background: COLORS[k], marginRight: 3 })),
      )
    : h('div', { display: 'flex', height: 18, width: '100%', borderRadius: 9, background: '#26272b' });
  const el = h(
    'div',
    {
      width: 1200,
      height: 630,
      display: 'flex',
      flexDirection: 'column',
      justifyContent: 'space-between',
      padding: '72px 80px',
      background: '#0e0f11',
      color: '#ececef',
      fontFamily: 'Noto Sans',
    },
    h('div', { display: 'flex', alignItems: 'center', fontSize: 34, fontWeight: 700 }, 'permalock'),
    h(
      'div',
      { display: 'flex', flexDirection: 'column' },
      h(
        'div',
        {
          fontSize: s ? 96 : 76,
          fontWeight: 700,
          letterSpacing: -2,
          lineHeight: 1.05,
          color: s && s.counts.broken ? '#f87171' : '#ececef',
        },
        big,
      ),
      h('div', { fontSize: 32, color: '#a1a1aa', marginTop: 24 }, small),
    ),
    h(
      'div',
      { display: 'flex', flexDirection: 'column' },
      bar,
      h(
        'div',
        { display: 'flex', justifyContent: 'space-between', marginTop: 20, fontSize: 26, color: '#a1a1aa' },
        h('div', {}, 'permalock.dev'),
        h('div', {}, 'free · open source'),
      ),
    ),
  );
  return new ImageResponse(el, {
    width: 1200,
    height: 630,
    headers: { 'cache-control': s ? 'public, s-maxage=3600' : 'public, s-maxage=300' },
  });
}
