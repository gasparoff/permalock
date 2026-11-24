# Permalock scanner

The public page behind `permalock scan`: type a domain, see how many of the
URLs it ever published are broken today. Results are shareable
(`/?d=example.com`) and cached for a day.

- `public/index.html`: the page
- `src/handler.mjs`: `GET /api/scan?d=<domain>`, an NDJSON stream of progress
  and the final summary. Only public hostnames are accepted; at most
  `PERMALOCK_MAX_CHECKS` (default 400) URLs are checked per scan.

## Run

```sh
npm run build -w permalock   # from the repository root
node apps/scanner/server.mjs # http://localhost:8787
```

## Deploy

- **Vercel**: new project from this repository, root directory `apps/scanner`.
  `vercel.json` builds the core package; `api/scan.mjs` runs up to 300 s.
- **Netlify**: new site from this repository; `netlify.toml` sets everything.
- **Any Node host**: `node apps/scanner/server.mjs` (`PORT` sets the port).
