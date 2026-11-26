# Contributing

Thanks for helping. Permalock is small on purpose, so most changes are small too.

## Good places to start

- **The scanner.** See [The scanner](#the-scanner) below.
- **A scan looks wrong.** Open a [wrong scan result](https://github.com/gasparoff/permalock/issues/new?template=scan.yml) issue with the domain. Odd sites (no sitemap, anti-bot pages, many redirects) make the scanner better.
- **Your framework or host is missing.** The core works on any folder of HTML. Adapters for other frameworks and `emit` targets for other hosts are welcome.
- **Issues labelled [good first issue](https://github.com/gasparoff/permalock/labels/good%20first%20issue).**

## Setup

Node 22.23.4 or later (Astro 7, used by the tests and the example, needs it).

```sh
npm ci
npm run build
npm test
```

The scanner runs locally with `node apps/scanner/server.mjs` and opens on http://localhost:8787.

## The scanner

The scanner at [permalock.dev](https://permalock.dev) lives in [apps/scanner](apps/scanner). It is one HTML page (`public/index.html`, no framework, no build step) and a few small functions in `src/`. The functions stream a scan as JSON lines. The scan itself is `scanDomain` in the core package.

```sh
npm ci
npm run build -w permalock
node apps/scanner/server.mjs        # http://localhost:8787
npx vitest run apps/scanner         # unit tests, no network
node apps/scanner/probe.mjs example.com   # why a domain shows what it shows
```

Good changes for the scanner:

- a site it gets wrong (open a [wrong scan result](https://github.com/gasparoff/permalock/issues/new?template=scan.yml) issue first, with the domain);
- a clearer result page, on phones too;
- faster or more reliable history (the Wayback Machine is often slow).

Look for issues labelled [scanner](https://github.com/gasparoff/permalock/labels/scanner). The browser checks in `apps/scanner/e2e` run on every push to the scanner.

## Before you open a pull request

- Add or update a test. Tests sit next to each package in `test/`.
- Run `npm run format` and `npm test`.
- Keep the lockfile format stable. A change to `permalock.json` needs a note in [spec/](spec/) first.
- One change per pull request, with a short description of why.

## Reporting a security issue

Please don't open a public issue. Use [private vulnerability reporting](https://github.com/gasparoff/permalock/security/advisories/new) instead.
