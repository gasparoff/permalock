# Benchmarks

## Git history replay

`git-history.mjs` replays a documentation site's repository commit by commit,
as if Permalock had run in CI on every merge, and compares each automatic
redirect with the redirect the maintainers eventually wrote by hand.

```sh
git clone https://github.com/withastro/docs /tmp/docs
npm run build
node bench/git-history.mjs /tmp/docs --json bench/results/withastro-docs.json
```

### Method

- Every first-parent commit that touches English content is replayed in
  order (`src/pages/en/**`, later `src/content/docs/en/**`).
- Pages come from content files, not from a real build. The URL is the file
  path (`/en/guides/routing/`). Text is the source with front matter, imports,
  tags and code fences removed. Real builds give the integration better
  signals (source identity, rendered text), so this is a conservative setting.
- Because the URL is the file path, the "same source" rule can never fire
  here: every automatic redirect comes from **identical content** or
  **similar content**.
- When a URL becomes an orphan, the script decides it the way the maintainers
  eventually did: their redirect rule if one exists at `HEAD` (`worker.js`),
  otherwise a removal.
- Ground truth: the redirect rules in `worker.js` at `HEAD`, expanded for
  `:lang`.

### Results: withastro/docs (docs.astro.build), English, HEAD `6304b44b4`

| Measure | Value |
|---|---|
| Commits replayed | 3,189 (June 2021 to November 2026), 46 s |
| URLs ever published | 528 |
| URLs live at HEAD | 430 |
| URLs that disappeared | 98 |
| **Automatic redirects** | **32** (29 identical content, 3 similar content) |
| Automatic redirects matching the maintainers' rule | 31 |
| Automatic redirects contradicting the maintainers' rule | **0** |
| Automatic redirect with no maintainer rule | 1 (`/en/guides/cms/netlify-cms/` → `/en/guides/cms/decap-cms/`, the CMS was renamed) |
| URLs that needed a human decision (orphans) | 67 |
| …that the maintainers later redirected | 40 |
| …with **no redirect rule today** | 27 |

What this says:

- About four in ten of the URL moves the maintainers handled by hand would
  have been handled automatically, with no wrong redirect.
- 27 URLs that were once published have no redirect rule today. Some may
  still answer through another route, so this is a list to verify on the live
  site (`permalock verify`), not yet a count of broken links. Permalock would
  have stopped each of them at the pull request that removed it.

The full list of decisions and orphans is in
[`results/withastro-docs.json`](results/withastro-docs.json).
