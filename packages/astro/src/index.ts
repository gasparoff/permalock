import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AstroConfig, AstroIntegration, IntegrationResolvedRoute } from 'astro';
import {
  checkProject,
  emit,
  fileToUrl,
  formatResolution,
  LOCKFILE_NAME,
  passes,
  readLockfile,
  summaryLine,
  writeEmitted,
  type Lockfile,
  type ResolveOptions,
} from 'permalock';
import { createMatcher, loadEntries } from './content.js';
import { setupDev } from './dev.js';

export interface PermalockOptions {
  /** Lockfile path, relative to the project root. Default "permalock.json" */
  lockfile?: string;
  /** URL path globs to ignore, e.g. ["/drafts/**"] */
  exclude?: string[];
  /**
   * What fails the build. "orphans" (default): any URL that disappeared without
   * a redirect or a declared removal. "never": report only.
   */
  failOn?: 'orphans' | 'never';
  /** Update permalock.json after the build. Default: true, except in CI. */
  write?: boolean;
  /** In CI, also fail when permalock.json is out of date. Default false */
  frozen?: boolean;
  /** Create redirects from estimated similarity (rule 2.3). Default true */
  similar?: boolean;
  /** Advanced thresholds for resolution. */
  thresholds?: Omit<ResolveOptions, 'autoThreshold'> & { auto?: number };
  /** Identify pages rendered from content collections by their entry. Default true */
  contentIdentity?: boolean;
  /**
   * Also write redirect rules for your host into the build output, including
   * 410 for removed URLs where the host supports it.
   * Static hosts: "netlify", "cloudflare", "apache" (.htaccess), "nginx", "json".
   */
  emit?: EmitTarget | EmitTarget[];
  /** Show the Permalock app in the dev toolbar and warn when a locked page's file disappears. Default true */
  devToolbar?: boolean;
  /** Split the lockfile into shards (large sites). */
  shard?: boolean | number;
}

export type EmitTarget = 'netlify' | 'cloudflare' | 'apache' | 'nginx' | 'json';

export function isCI(env = process.env): boolean {
  if (env.CI && env.CI !== 'false' && env.CI !== '0') return true;
  return !!(env.GITHUB_ACTIONS || env.GITLAB_CI || env.BUILDKITE || env.CIRCLECI || env.NETLIFY || env.VERCEL || env.CF_PAGES);
}

/** Apply Astro's base to a root-relative path. */
export function withBase(p: string, base: string): string {
  const b = base.replace(/\/+$/, '');
  if (!b) return p;
  if (p === b || p.startsWith(b + '/')) return p;
  return b + p;
}

export function stripBase(p: string, base: string): string {
  const b = base.replace(/\/+$/, '');
  if (!b || !p.startsWith(b)) return p;
  return p.slice(b.length) || '/';
}

const PAGE_EXT = /\.(astro|md|mdx|markdown|html|js|ts)$/;

/**
 * URL paths (without base, without trailing slash) of the static page files in
 * src/pages. A lockfile redirect must never shadow one of them: in Astro a
 * redirect silently replaces a page with the same path.
 */
export async function staticPagePaths(pagesDir: string): Promise<Set<string>> {
  const out = new Set<string>();
  async function walk(dir: string, rel: string) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('_') || e.name.startsWith('.') || e.name.includes('[')) continue;
      if (e.isDirectory()) await walk(path.join(dir, e.name), `${rel}/${e.name}`);
      else if (PAGE_EXT.test(e.name) && !/\.d\.ts$/.test(e.name)) {
        const name = e.name.replace(PAGE_EXT, '');
        out.add(name === 'index' ? rel || '/' : `${rel}/${name}`);
      }
    }
  }
  await walk(pagesDir, '');
  return out;
}

const bare = (p: string) => (p.length > 1 ? p.replace(/\/+$/, '') : p);

/** Redirects to inject into the Astro config: lockfile redirects, keys without base. */
export function lockRedirects(lock: Lockfile, base: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [url, e] of Object.entries(lock.urls)) {
    // redirects served by the site's own configuration stay there: injecting
    // them could hide a page that later replaces them (i18n fallbacks)
    if (e.type !== 'redirect' || e.reason === 'config') continue;
    const from = decodeURI(stripBase(url, base));
    if (/[[\]]/.test(from)) continue;
    out[from] = /^https?:\/\//.test(e.to) ? e.to : withBase(stripBase(e.to, base), base);
  }
  return out;
}

function configRedirects(config: AstroConfig): Map<string, string> {
  const out = new Map<string, string>();
  for (const [from, target] of Object.entries(config.redirects ?? {})) {
    if (/[[\]*]/.test(from)) continue;
    const to = typeof target === 'string' ? target : (target as any)?.destination;
    if (typeof to !== 'string' || /[[\]*]/.test(to)) continue;
    out.set(encodeURI(withBase(from, config.base)), /^https?:\/\//.test(to) ? to : encodeURI(withBase(to, config.base)));
  }
  return out;
}

/** Identity of static routes: URL -> the page file that produced it. */
function routeSources(routes: IntegrationResolvedRoute[], assets: Map<string, URL[]>, outDir: string, config: AstroConfig) {
  const byPattern = new Map(routes.map((r) => [r.pattern, r]));
  const sources = new Map<string, string>();
  for (const [pattern, files] of assets) {
    const route = byPattern.get(pattern);
    if (route?.type !== 'page' || route.params.length > 0 || route.origin !== 'project') continue;
    for (const f of files) {
      const file = fileURLToPath(f);
      if (file.endsWith('.html'))
        sources.set(fileToUrl(path.relative(outDir, file), { base: config.base, trailingSlash: config.trailingSlash }), route.entrypoint);
    }
  }
  return sources;
}

export default function permalock(options: PermalockOptions = {}): AstroIntegration {
  let config: AstroConfig;
  let lockfilePath = '';
  let routes: IntegrationResolvedRoute[] = [];
  let injected: Record<string, string> = {};
  let goneList: string[] = [];

  return {
    name: 'permalock',
    hooks: {
      'astro:config:setup': async ({ config: cfg, command, updateConfig, addMiddleware, addDevToolbarApp, logger }) => {
        const root = fileURLToPath(cfg.root);
        lockfilePath = path.resolve(root, options.lockfile ?? LOCKFILE_NAME);
        let lock: Lockfile | undefined;
        try {
          lock = await readLockfile(lockfilePath);
        } catch (e) {
          logger.error((e as Error).message);
          throw e;
        }
        const update: Record<string, any> = {};
        if (lock) {
          const fromLock = lockRedirects(lock, cfg.base);
          const pages = await staticPagePaths(fileURLToPath(new URL('pages/', cfg.srcDir)));
          // redirects written by hand in astro.config win over the lockfile, and
          // a page that exists again wins over a redirect (it is revived after the build)
          injected = {};
          for (const [k, v] of Object.entries(fromLock)) {
            if (k in (cfg.redirects ?? {})) continue;
            if (pages.has(bare(k))) {
              logger.info(`${k} is a page again: its redirect in ${path.basename(lockfilePath)} is no longer applied`);
              continue;
            }
            injected[k] = v;
          }
          if (Object.keys(injected).length) update.redirects = injected;
          goneList = Object.entries(lock.urls)
            .filter(([, e]) => e.type === 'gone')
            .map(([u]) => u);
        }
        const virtualId = 'virtual:permalock/gone';
        update.vite = {
          plugins: [
            {
              name: 'permalock:gone',
              resolveId: (id: string) => (id === virtualId ? '\0' + virtualId : undefined),
              load: (id: string) => (id === '\0' + virtualId ? `export default ${JSON.stringify(goneList)};` : undefined),
            },
          ],
        };
        updateConfig(update);
        if (command === 'dev' && options.devToolbar !== false) {
          addDevToolbarApp({
            id: 'permalock',
            name: 'Permalock',
            icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>',
            entrypoint: new URL('./toolbar-app.js', import.meta.url),
          });
        }
        if (goneList.length) addMiddleware({ entrypoint: new URL('./middleware.js', import.meta.url), order: 'pre' });
        if (command === 'build' && lock)
          logger.debug(`${Object.keys(injected).length} redirect(s) from ${path.basename(lockfilePath)}`);
      },

      'astro:config:done': ({ config: cfg }) => {
        config = cfg;
      },

      'astro:server:setup': ({ server, toolbar, logger }) => {
        if (options.devToolbar === false) return;
        setupDev({ root: fileURLToPath(config.root), lockfilePath, base: config.base, server, toolbar, logger });
      },

      'astro:routes:resolved': ({ routes: r }) => {
        routes = r;
      },

      'astro:build:done': async ({ dir, assets, logger }) => {
        const root = fileURLToPath(config.root);
        const outDir = fileURLToPath(dir);
        const ci = isCI();
        const write = options.write ?? !ci;

        const sources = routeSources(routes, assets, outDir, config);

        const knownRedirects = configRedirects(config);
        const resolve: ResolveOptions = {
          ...(options.thresholds ?? {}),
          ...(options.similar === false ? { autoThreshold: false } : options.thresholds?.auto ? { autoThreshold: options.thresholds.auto } : {}),
        };
        const t0 = Date.now();
        const identify =
          options.contentIdentity === false ? undefined : createMatcher(await loadEntries(fileURLToPath(config.cacheDir)));
        const result = await checkProject({
          cwd: root,
          dir: outDir,
          lockfile: lockfilePath,
          base: config.base,
          trailingSlash: config.trailingSlash,
          site: config.site,
          exclude: options.exclude,
          sources,
          identify,
          knownRedirects,
          resolve,
          write,
          shard: options.shard,
        });
        const res = result.resolution;

        // redirects decided in this build cannot reach the (closed) config:
        // serve them as HTML redirect pages now; they become native next build.
        const fresh = res.redirected.filter((r) => r.reason !== 'config');
        if (fresh.length) {
          const only: Lockfile = { permalock: 1, site: res.lock.site, urls: {} };
          for (const r of fresh) {
            const e = res.lock.urls[r.from];
            only.urls[r.from] = { type: 'redirect', to: e.type === 'redirect' ? e.to : r.to };
          }
          await writeEmitted(emit(only, 'html', { out: outDir, base: config.base }));
        }

        const targets = options.emit ? (Array.isArray(options.emit) ? options.emit : [options.emit]) : [];
        for (const target of targets) {
          const out = emit(res.lock, target, { out: outDir, base: config.base });
          const { written } = await writeEmitted(out);
          for (const w of out.warnings) logger.warn(w);
          if (written.length) logger.info(`${target}: ${out.redirects} redirect(s)${out.gone ? `, ${out.gone} removal(s)` : ''} → ${written.map((f) => path.relative(root, f)).join(', ')}`);
        }

        const ms = Date.now() - t0;
        if (result.created && !result.written) {
          logger.warn(
            `no ${path.basename(result.lockfilePath)} yet, so no URL is protected. Run "astro build" locally and commit the file it creates.`,
          );
          return;
        }
        if (result.created) {
          logger.info(
            `created ${path.relative(root, result.lockfilePath)} with ${res.added.length} URLs (${ms} ms). Commit it: from the next build these URLs are protected.`,
          );
        } else {
          logger.info(`${summaryLine(res)} (${ms} ms)`);
          const body = formatResolution(res, { cmd: 'npx permalock' });
          if (body) for (const line of body.split('\n')) logger.info(line);
          if (fresh.length)
            logger.info(`${fresh.length} new redirect(s) served as HTML pages in this build; they become native ${config.output === 'server' ? 'server' : 'host'} redirects from the next build.`);
          if (result.written) logger.info(`updated ${path.relative(root, result.lockfilePath)}: commit it with this change.`);
          if (!write && res.changed) {
            const msg = `${path.basename(result.lockfilePath)} is out of date: run "astro build" locally and commit it.`;
            if (ci && options.frozen) throw new Error(`[permalock] ${msg}`);
            logger.warn(msg);
          }
        }
        if (!passes(res) && (options.failOn ?? 'orphans') === 'orphans') {
          const n = res.orphans.length + res.errors.length;
          throw new Error(
            `[permalock] ${n} URL(s) would break. For each one, add a redirect (npx permalock redirect <old> <new>) or declare it removed (npx permalock retire <old>), then build again.`,
          );
        }
      },
    },
  };
}

