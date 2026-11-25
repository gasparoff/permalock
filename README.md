<h1 align="center">Permalock</h1>

<p align="center"><b>A lockfile for your site's URLs.</b></p>

<p align="center">
Every URL your site ever published keeps answering: a page, one redirect, or a removal you chose.<br>
When a page moves, Permalock writes the redirect. When a URL would vanish, the build fails.
</p>

<p align="center">
<a href="https://github.com/gasparoff/permalock/actions/workflows/ci.yml"><img src="https://github.com/gasparoff/permalock/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
<img src="https://img.shields.io/badge/spec-v1%20draft-blue" alt="Spec v1 draft">
<img src="https://img.shields.io/badge/license-MIT-green" alt="MIT">
</p>

```sh
npx astro add @permalock/astro   # Astro
npx permalock init               # any static site, after a build
```

<p align="center"><img src=".github/assets/demo.svg" width="860" alt="astro build with Permalock: two redirects created automatically, one orphan URL stops the build"></p>

<p align="center">
<a href="#quick-start">Quick start</a> ·
<a href="#how-it-works">How it works</a> ·
<a href="bench/README.md">Benchmark</a> ·
<a href="spec/permalock-v1.md">Specification</a> ·
<a href="https://permalock.dev">Scan a site</a>
</p>

## Why

A static site generator forgets the previous build. Rename a file, change a
slug or flip `trailingSlash`, and every link that pointed to the old URL
breaks: in forum posts, bookmarks, papers, search results. The build still
passes, and nobody finds out until someone clicks.

To see how often this happens to a careful team, I replayed the history of
the Astro docs (3,189 commits, June 2021 to November 2026) as if Permalock
had run on every merge:

- it would have written 32 redirects on its own. 31 match the rule the
  maintainers later wrote by hand, and the other one follows a CMS that was
  renamed. None points to the wrong page.
- 67 URLs were removed without a redirect. Some of those removals were surely
  on purpose. Today 25 of them answer 404 on docs.astro.build, and Permalock
  would have stopped each one at the pull request that removed it, asking for
  a redirect or an explicit removal.

The Astro docs are well maintained. The tooling just never told anyone. The
[method and data](bench/README.md) are in this repo, so you can rerun it.

Link rot is not rare. Pew Research Center found that
[38% of the web pages that existed in 2013 were gone ten years later](https://www.pewresearch.org/data-labs/2024/05/17/when-online-content-disappears/).

> **Status: pre-release (0.1).** The lockfile format is a
> [draft specification](spec/permalock-v1.md). Feedback is very welcome,
> especially from people running sites with thousands of pages.

## Quick start

### Astro

```sh
npx astro add @permalock/astro
```

```js
// astro.config.mjs
import { defineConfig } from 'astro/config';
import permalock from '@permalock/astro';

export default defineConfig({
  site: 'https://example.com',
  integrations: [permalock()],
});
```

Build once and commit `permalock.json`. From the next build on:

- pages that moved get a redirect automatically, injected into Astro's own
  `redirects` so every adapter serves it natively;
- a URL that disappears without a decision fails the build;
- in CI the lockfile is checked, never rewritten.

See [`packages/astro`](packages/astro/README.md) for options.

### Any static site (Hugo, Eleventy, Jekyll, Next export, VitePress, Docusaurus…)

```sh
npx permalock init          # after your first build: creates permalock.json
# …change things, build again…
npx permalock update        # records moves, reports orphans
npx permalock emit netlify  # writes _redirects (or cloudflare, vercel, nginx, apache, html)
```

In CI:

```sh
npx permalock check         # exits 1 if any URL would break
```

### How many URLs has a site already lost?

```sh
npx permalock scan example.com
```

```text
example.com has published 1,284 URLs since 2014. 212 of them are broken today.
  sources: Wayback Machine 1,190 · current sitemaps 412 · archived sitemaps 600

  ✓   1,031  answer 200
  →       0  answer one redirect
  ⤳      41  take two or more redirects
  ✗     212  are broken (404 or 410)  16.5%
```

(Numbers above are an illustration.) No install needed: the same scan runs
in the browser at **[permalock.dev](https://permalock.dev)**. `scan` reads the Wayback Machine and the
site's current and archived sitemaps, then checks every URL on the live site.
Add `--html report.html` for a shareable page. `permalock import <domain>`
adds those historic URLs to your lockfile, so you can decide where each one
should go.

## How it works

### The invariant

| Entry in `permalock.json` | The deployed site must answer |
|---|---|
| `page` | `200`, no redirect in between |
| `redirect` | exactly one `301`/`308` to the target, which answers `200` |
| `gone` | `410` where the host supports it, otherwise `404`: a removal somebody decided |

`permalock verify --against https://preview.example.com` measures it on a real
deployment, where adapters, CDNs and host rules can still get it wrong. It
catches temporary redirects, two-hop chains (often a trailing-slash rule on
the host) and soft redirects.

### The lockfile

One line per URL, sorted, deterministic. A pull request that moves URLs shows
it in the diff, and two branches that add pages don't conflict.

```json
{
  "permalock": 1,
  "site": "https://example.com",
  "urls": {
    "/": { "type": "page", "source": "src/pages/index.astro" },
    "/blog/hello-world/": { "type": "redirect", "to": "/blog/hello/", "reason": "same-source" },
    "/blog/hello/": { "type": "page", "source": "src/content/blog/hello-world.md", "hash": "f18e39f53bbb8f9f", "sim": "885503254c55289d" },
    "/summer-sale/": { "type": "gone", "reason": "campaign ended" }
  }
}
```

`npx permalock init` also installs a git merge driver, so concurrent changes
to the lockfile merge on their own.

### How a moved page is recognised

Identity is stored in the lockfile, so it works in shallow CI checkouts and
never depends on git history.

| What changed | Signal | Certainty | Action |
|---|---|---|---|
| The URL, not the page (slug, `trailingSlash`, `base`, locale prefix) | Same source file, or same `permalock` id in front matter | Certain | Redirect |
| The file was moved or renamed, content identical | Same content hash | Certain | Redirect |
| Moved **and** edited | Text similarity (SimHash) above 0.94, clearly ahead of the runner-up | Estimated | Redirect, labelled with its score (can be disabled) |
| Rewritten, merged, split or deleted | Weak or no similarity | None | You decide: `redirect` or `retire`. Permalock suggests the closest page. |

Automatic redirects always stay on your domain. Pages with fewer than 40 words
are never matched by content. Want certainty for a page whatever happens to
it? Give it a stable id: `permalock: my-id` in Astro front matter, or
`<meta name="permalock:id" content="my-id">` in any HTML page.

## Commands

| Command | What it does |
|---|---|
| `permalock update [dir]` | Scan the build, update `permalock.json`, report changes |
| `permalock check [dir]` | Same, for CI: writes nothing, exits 1 on orphans (`--frozen`: also when the lockfile is stale) |
| `permalock resolve [dir]` | Decide orphan URLs one by one, with suggestions |
| `permalock redirect <from> <to>` | Record a permanent redirect (external targets allowed only here) |
| `permalock retire <url> [--reason]` | Declare a URL removed on purpose |
| `permalock forget <url>` | Drop a URL that was never public |
| `permalock emit <format>` | Write host rules: `netlify`, `cloudflare`, `vercel`, `nginx`, `apache`, `html`, `json` |
| `permalock verify [--against url]` | Check every locked URL on a deployed site |
| `permalock scan <domain>` | Find a domain's historic URLs and how many are broken today |
| `permalock import <domain>` | Add historic URLs to the lockfile (`--check-live` adopts existing redirects) |
| `permalock init` | Create the lockfile and install the git merge driver |

The build directory is detected (`dist`, `build`, `out`, `_site`, `public`).
Common options: `--base /docs`, `--exclude "/drafts/**"`, `--no-similar`,
`--json`.

## Hosts

| Host | Redirects | Declared removals |
|---|---|---|
| Netlify | `_redirects` (`emit netlify`) | `410` |
| Cloudflare Pages | `_redirects` (`emit cloudflare`) | `404` (no `410` in `_redirects`) |
| Vercel | `vercel.json` (`emit vercel`) | `404` |
| nginx / Apache | `emit nginx` / `emit apache` | `410` |
| GitHub Pages and other plain static hosts | HTML redirect pages (`emit html`): soft redirects, reported as such by `verify` | `404` |
| Astro with an adapter | Native, through Astro's `redirects` | `410` via middleware for on-demand sites |

## CI example (GitHub Actions)

```yaml
- run: npm ci
- run: npm run build            # with @permalock/astro, orphans fail here
- run: npx permalock check      # for other generators
# after deploying a preview:
- run: npx permalock verify --against ${{ steps.deploy.outputs.url }}
```

## With AI coding agents

Agents rename and delete pages all day, and they don't know which URLs the
rest of the web depends on. Permalock tells them, and tells them how to fix it:

- `permalock check --json` lists each orphan with `fixes`, commands ready to run.
- [`skills/permalock`](skills/permalock/SKILL.md) is an agent skill for any
  tool that reads `SKILL.md`: copy it into your agent's skills folder.
- Or add one line to your `AGENTS.md`:
  *"After changing pages, run `npx permalock check --json` and settle every
  orphan with one of its `fixes`."*

## The specification

The lockfile format, the resolution algorithm and the verification procedure
are an open, framework-independent [specification](spec/permalock-v1.md)
(CC BY 4.0) with a [conformance suite](spec/conformance). Astro is the first
deep integration, not the only one: a second implementation is very welcome.

## What Permalock does not promise

- Rankings or citations by AI assistants. The only guarantee is the URL
  invariant above.
- Zero configuration for pages rendered on demand: their URLs are not known
  at build time. Prerendered pages are covered; a runtime recorder is planned.

## Development

```sh
npm install
npm test           # unit tests, conformance suite, CLI and real Astro builds
npm run build
```

## License

MIT for the code, CC BY 4.0 for the specification.

Made by [@gasparoff](https://github.com/gasparoff). [Contributions](CONTRIBUTING.md) and [sponsors](https://github.com/sponsors/gasparoff) keep it going.
