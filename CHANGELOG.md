# Changelog

Versions of `permalock` and `@permalock/astro`, which are released together.

## 0.1.0 (26 November 2026)

First public release.

- `permalock.json`: one line per URL (`page`, `redirect`, `gone`), sorted and
  deterministic, with a git merge driver. The format is a
  [draft specification](spec/permalock-v1.md) with a conformance suite.
- Moved pages are recognised by source file, stable id, content hash or text
  similarity, and get a redirect. A URL that disappears without a decision
  fails the build.
- CLI: `init`, `update`, `check`, `resolve`, `redirect`, `retire`, `forget`,
  `emit` (Netlify, Cloudflare, Vercel, nginx, Apache, HTML, JSON), `verify`,
  `scan`, `import`.
- `@permalock/astro`: redirects through Astro's own `redirects`, orphans fail
  `astro build`, a dev toolbar app, `410` middleware for on-demand sites.
- Needs Node 22 or later, and Astro 7 or later for the integration.
