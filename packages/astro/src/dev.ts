import path from 'node:path';
import { readLockfile, type Lockfile } from 'permalock';

interface Toolbar {
  send: (event: string, payload: unknown) => void;
  on: (event: string, cb: (data: any) => void) => void;
}

interface Logger {
  warn: (m: string) => void;
}

/** Dev server support: answers the toolbar app and warns when a locked page's source disappears. */
export function setupDev(opts: { root: string; lockfilePath: string; base: string; server: any; toolbar: Toolbar; logger: Logger }) {
  const { root, lockfilePath, server, toolbar, logger } = opts;
  let lock: Lockfile | undefined;
  const warnings: string[] = [];
  const load = async () => {
    try {
      lock = await readLockfile(lockfilePath);
    } catch (e) {
      logger.warn((e as Error).message);
    }
  };
  void load();

  const find = (p: string): string | undefined => {
    if (!lock) return undefined;
    const candidates = [p, p.endsWith('/') ? p.slice(0, -1) : p + '/'];
    for (const c of candidates) {
      if (lock.urls[c]) return c;
      try {
        const enc = encodeURI(decodeURI(c));
        if (lock.urls[enc]) return enc;
      } catch {}
    }
    return undefined;
  };

  toolbar.on('permalock:query', async ({ path: p }: { path: string }) => {
    if (!lock) await load();
    const key = find(p);
    const inbound = key
      ? Object.entries(lock!.urls)
          .filter(([, e]) => e.type === 'redirect' && e.to === key)
          .map(([from, e]) => ({ from, reason: (e as any).reason }))
      : [];
    toolbar.send('permalock:status', {
      path: p,
      key,
      entry: key ? lock!.urls[key] : undefined,
      inbound,
      total: lock ? Object.keys(lock.urls).length : 0,
      hasLockfile: !!lock,
      warnings: warnings.slice(-5),
    });
  });

  const watcher = server?.watcher;
  if (!watcher) return;
  watcher.add(lockfilePath);
  watcher.on('change', (file: string) => {
    if (path.resolve(file) === lockfilePath) void load();
  });
  watcher.on('add', (file: string) => {
    if (path.resolve(file) === lockfilePath) void load();
  });
  watcher.on('unlink', (file: string) => {
    if (!lock) return;
    const rel = path.relative(root, file).split(path.sep).join('/');
    const urls = Object.entries(lock.urls)
      .filter(([, e]) => e.type === 'page' && (e as any).source === rel)
      .map(([u]) => u);
    if (!urls.length) return;
    const msg = `${rel} published ${urls.join(', ')}. If you moved it, Permalock will redirect the old URL at the next build; if you deleted it, the build will ask you to redirect or retire ${urls.length > 1 ? 'them' : 'it'}.`;
    warnings.push(msg);
    logger.warn(msg);
    toolbar.send('permalock:warning', { message: msg });
  });
}
