export const USER_AGENT = 'permalock (+https://github.com/gasparoff/permalock)';

export type Fetch = typeof fetch;

export interface Hop {
  status: number;
  location?: string;
  /** meta refresh target found in a 200 HTML body */
  refresh?: string;
}

/** One request without following redirects. HEAD first, GET when HEAD is refused. */
export async function probe(url: string, opts: { fetch?: Fetch; timeoutMs?: number; wantBody?: boolean } = {}): Promise<Hop> {
  const f = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 15000;
  const req = async (method: 'HEAD' | 'GET') =>
    f(url, {
      method,
      redirect: 'manual',
      headers: { 'user-agent': USER_AGENT, accept: 'text/html,*/*;q=0.8' },
      signal: AbortSignal.timeout(timeoutMs),
    });
  let res = await req(opts.wantBody ? 'GET' : 'HEAD');
  if (!opts.wantBody && (res.status === 405 || res.status === 501 || res.status === 403)) res = await req('GET');
  const hop: Hop = { status: res.status };
  const loc = res.headers.get('location');
  if (loc) hop.location = new URL(loc, url).href;
  if (opts.wantBody && res.status === 200 && /html/i.test(res.headers.get('content-type') ?? 'text/html')) {
    const body = (await res.text()).slice(0, 8192);
    const m = /<meta\b[^>]*http-equiv\s*=\s*["']?refresh[^>]*>/i.exec(body);
    if (m) {
      const c = /content\s*=\s*["']\s*\d+\s*[;,]\s*url\s*=\s*['"]?([^'">]+)/i.exec(m[0]);
      if (c) hop.refresh = new URL(c[1].trim(), url).href;
    }
  } else {
    try {
      await res.body?.cancel();
    } catch {}
  }
  return hop;
}

/** Follow redirects by hand (max hops), returning every hop. */
export async function trace(url: string, opts: { fetch?: Fetch; timeoutMs?: number; maxHops?: number } = {}) {
  const hops: (Hop & { url: string })[] = [];
  let current = url;
  for (let i = 0; i <= (opts.maxHops ?? 5); i++) {
    const h = await probe(current, opts);
    hops.push({ ...h, url: current });
    if (h.status >= 300 && h.status < 400 && h.location) current = h.location;
    else break;
  }
  return hops;
}

export async function pool<T, R>(items: T[], concurrency: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  const worker = async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, worker));
  return out;
}

export async function withRetry<T>(fn: () => Promise<T>, retries = 1): Promise<T> {
  let last: unknown;
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (i < retries) await new Promise((r) => setTimeout(r, 500 * (i + 1)));
    }
  }
  throw last;
}
