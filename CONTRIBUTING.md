# Contributing

Thanks for helping. Permalock is small on purpose, so most changes are small too.

## Good places to start

- **A scan looks wrong.** Open a [wrong scan result](https://github.com/gasparoff/permalock/issues/new?template=scan.yml) issue with the domain. Odd sites (no sitemap, anti-bot pages, many redirects) make the scanner better.
- **Your framework or host is missing.** The core works on any folder of HTML. Adapters for other frameworks and `emit` targets for other hosts are welcome.
- **Issues labelled [good first issue](https://github.com/gasparoff/permalock/labels/good%20first%20issue).**

## Setup

Node 22 or later.

```sh
npm ci
npm run build
npm test
```

The scanner runs locally with `node apps/scanner/server.mjs` and opens on http://localhost:8787.

## Before you open a pull request

- Add or update a test. Tests sit next to each package in `test/`.
- Run `npm run format` and `npm test`.
- Keep the lockfile format stable. A change to `permalock.json` needs a note in [spec/](spec/) first.
- One change per pull request, with a short description of why.

## Reporting a security issue

Please don't open a public issue. Use [private vulnerability reporting](https://github.com/gasparoff/permalock/security/advisories/new) instead.
