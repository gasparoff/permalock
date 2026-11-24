# Permalock conformance suite

Implementation-independent test cases for the [specification](../permalock-v1.md).
Any implementation that claims to follow the spec should pass all of them.

## `resolve/`

Each file is one case:

```json
{
  "description": "what the case proves",
  "lock": { "permalock": 1, "urls": { } },
  "build": [ { "url": "/a/", "source": "…", "hash": "…", "sim": "…" } ],
  "knownRedirects": { "/alias/": "/target/" },
  "options": { "autoThreshold": 0.94 },
  "expect": {
    "lock": { "permalock": 1, "urls": { } },
    "orphans": ["/url/"],
    "suggestions": { "/url/": "/suggested/" },
    "errors": [ { "url": "/a/", "kind": "cycle" } ]
  }
}
```

Run resolution (spec section 3) with `lock` as the previous lockfile,
`build` as the built pages and `knownRedirects` (optional) as the redirects
the site serves from its own configuration, then compare:

- `expect.lock`: the resulting lockfile, compared after serialisation
  (spec 2.7), so it must be byte-identical;
- `expect.orphans`: the set of orphan URLs;
- `expect.suggestions` (optional): suggested target per orphan;
- `expect.errors`: the set of `(url, kind)` pairs.

## `serialize/`

`input.json` files are parsed and serialised again; the output must equal the
`expected.json` next to them byte for byte.
