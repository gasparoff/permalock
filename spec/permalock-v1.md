# Permalock lockfile specification, version 1

Status: **draft** (v1.0.0-draft.1, 24 November 2026)
License: [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)

> URLs are a public API. `permalock.json` is their lockfile, and this document
> is their contract test.

This specification defines:

1. **The invariant**: what every URL a site has ever published must do.
2. **The lockfile**: a committed, framework-independent file that records
   every published URL and what it must do.
3. **The resolution algorithm**: how an implementation updates the lockfile
   after a build, and when it must refuse to.
4. **The verification procedure**: how the invariant is measured against a
   deployed site.

The key words MUST, MUST NOT, SHOULD, SHOULD NOT and MAY are to be
interpreted as described in RFC 2119.

A machine-readable JSON Schema is published next to this document
(`permalock.schema.json`), and a conformance suite lives in `conformance/`.

---

## 1. The invariant

Every URL recorded in the lockfile MUST, on the deployed site, do exactly one
of the following:

| Entry type | Expected response |
|---|---|
| `page` | `200`, with no redirect in between |
| `redirect` | exactly **one** `301` or `308` hop to its target, and the target answers `200` |
| `gone` | a *declared removal*: `410` where the host supports it, otherwise `404` |

A URL that once answered `200` and now answers anything else, without a
`redirect` or `gone` entry that says so, is an **orphan**. Orphans are the
failure this specification exists to prevent.

`gone` exists because some hosts (for example GitHub Pages, or Cloudflare
`_redirects`, which only accepts 3xx and 200) cannot answer `410`. A `404` on
a `gone` URL is acceptable; a `404` on a `page` URL is not. The difference is
that somebody decided it.

## 2. The lockfile

### 2.1 Location and name

The lockfile is named `permalock.json` and lives at the root of the project
(next to `package.json`, `astro.config.*`, `hugo.toml`, …). It MUST be
committed to version control.

Large sites MAY split the lockfile into shards (see 2.6).

### 2.2 Top-level structure

```json
{
  "permalock": 1,
  "site": "https://example.com",
  "urls": {
    "/": { "type": "page", "source": "src/pages/index.astro", "hash": "5f2b1e0c9a7d3e41", "sim": "c3a1f00e9b2d7a64" },
    "/blog/hello/": { "type": "page", "source": "src/content/blog/hello.md", "hash": "0a93c3c1d02e7f55", "sim": "8e11a0c4f2b97d03" },
    "/blog/hello-world/": { "type": "redirect", "to": "/blog/hello/", "reason": "same-source" },
    "/summer-promo/": { "type": "gone", "reason": "campaign ended" }
  }
}
```

| Field | Type | Required | Meaning |
|---|---|---|---|
| `permalock` | integer | yes | Format version. This document defines `1`. |
| `site` | string | no | Canonical origin of the site (`https://example.com`), without trailing slash. Used to recognise internal links and to verify. |
| `urls` | object | yes | Map from URL path to entry. |

Unknown top-level fields MUST be preserved by implementations that rewrite
the file, and MUST NOT cause a failure.

### 2.3 URL keys

A key is the **path** a visitor requests, exactly as served, including the
site's base path and trailing slash convention:

- it MUST start with `/`;
- it MUST NOT contain a scheme, host, query string or fragment;
- it SHOULD be percent-encoded as the site serves it (non-ASCII characters
  encoded, `/` not encoded);
- implementations SHOULD write one spelling per path: Unicode normalised to
  NFC before encoding, each character encoded once (an existing `%XX` escape
  is kept, not encoded again), and `?` and `#` that belong to the path
  encoded as `%3F` and `%23`. File systems differ (macOS often stores names
  in NFD), and the same build must give the same keys on every machine;
- `/about` and `/about/` are **different** URLs. A change of trailing-slash
  policy is a change of every URL and is handled like any other move.

### 2.4 Entries

Every entry is an object with a `type`.

**`page`**: the URL is served with `200`.

| Field | Required | Meaning |
|---|---|---|
| `type` | yes | `"page"` |
| `source` | no | Identity of the page (2.5). |
| `hash` | no | Content hash (2.5): 16 lowercase hex characters. |
| `sim` | no | Content similarity fingerprint (2.5): 16 lowercase hex characters. |
| `origin` | no | Where the URL was learned, when not from a build: `"sitemap"`, `"wayback"`, `"import"`. |

**`redirect`**: the URL answers one permanent redirect.

| Field | Required | Meaning |
|---|---|---|
| `type` | yes | `"redirect"` |
| `to` | yes | Target: a path (`/new/`) or, only when recorded by an explicit human decision, an absolute `https:` URL. |
| `reason` | no | Why the redirect exists: `"same-source"`, `"same-content"`, `"similar:<score>"`, `"manual"`, or free text. |

**`gone`**: the URL was removed on purpose.

| Field | Required | Meaning |
|---|---|---|
| `type` | yes | `"gone"` |
| `reason` | no | Free text, for humans. |

### 2.5 Identity

Identity lets an implementation tell, with certainty, that a page moved
instead of guessing. It is stored **in the lockfile** so that resolution
does not depend on version-control history (CI checkouts are usually
shallow, and rename detection in git is itself a similarity guess).

- **`source`** is a stable identifier of what produced the page. Its value is
  implementation-defined but MUST be stable across builds and independent of
  the URL. Recommended forms:
  - a project-relative source file path with `/` separators
    (`src/content/blog/hello.md`, `src/pages/about.astro`);
  - `id:<value>` for an identifier chosen by the author (for example a
    `permalock` field in front matter, or
    `<meta name="permalock:id" content="…">` in the page);
  - a source that produces more than one URL (a template rendering many
    pages) MUST NOT be used as `source` for those URLs.
- **`hash`** is the first 16 hex characters of the SHA-256 of the page's
  *normalised main text* (2.5.1).
- **`sim`** is a 64-bit SimHash of the normalised main text, as 16 hex
  characters (2.5.2).

#### 2.5.1 Normalised main text

1. Take the HTML of the page.
2. If it contains a `<main>` element, keep only the content of the first
   one; otherwise, if it contains `<article>`, keep the first one; otherwise
   keep `<body>`.
3. Remove `<script>`, `<style>`, `<noscript>`, `<template>`, `<svg>`, `<nav>`,
   `<header>`, `<footer>` and `<aside>` elements with their content, and HTML
   comments.
4. Remove all remaining tags, decode entities, lowercase, and collapse
   whitespace to single spaces; trim.

#### 2.5.2 SimHash

Tokens are the words of the normalised text (maximal sequences of Unicode
letters or digits). Features are overlapping word 3-grams joined by a single
space (or single words when there are fewer than 3). Each feature is hashed
to 64 bits with FNV-1a 64 over its UTF-8 bytes; the
fingerprint bit *i* is 1 when the features with bit *i* set outnumber those
without. Similarity between two fingerprints is
`1 − popcount(a XOR b) / 64`.

Pages whose normalised text has fewer than **40 words** are *too short to
compare*: implementations MUST omit both `hash` and `sim` for them, so that
neither can be used to create a redirect automatically.

### 2.6 Shards

A lockfile MAY be split. When files named `permalock.<name>.json` exist next
to `permalock.json`, the effective lockfile is the union of their `urls`. A
URL MUST NOT appear in more than one shard. The recommended shard name is the
first path segment of the URL (`/docs/a/` → `permalock.docs.json`), with
`permalock.json` holding the root and the remaining URLs.

### 2.7 Serialisation (merge-friendly)

To keep diffs reviewable and merges predictable, implementations that write
the lockfile MUST produce exactly this layout:

- UTF-8, `\n` line endings, final newline;
- the top-level object with fields in the order `permalock`, `site`, any
  unknown fields, then `urls`, each on its own line, indented by two spaces;
- **one line per URL**, indented by four spaces, in ascending order of the
  key compared by UTF-16 code units;
- entry fields in the order `type`, `to`, `source`, `hash`, `sim`,
  `origin`, `reason`, then unknown fields in ascending order; separators
  `": "` and `", "`; no spaces inside braces other than those.

Two implementations given the same logical content MUST produce
byte-identical files.

A three-way merge of two lockfiles (base, ours, theirs) is computed per URL:
when only one side changed the entry relative to base (including adding or
removing it), that side wins; when both sides made the same change, it is
kept; when both changed it differently but the `type` and `to` agree, ours
wins (the remaining fields are regenerated by the next build); otherwise the
URL is a conflict. Implementations SHOULD ship a git merge driver that does
this and leaves conflicts to a person.

## 3. Resolution

Resolution takes the previous lockfile **L** and the set **B** of pages
produced by a build (each with its URL and, when available, `source`, `hash`,
`sim`), and produces a new lockfile **L′** plus a list of problems.

Steps, in order:

1. **Built pages.** For every page *p* in B, `L′[p.url]` becomes a `page`
   entry with p's identity. If `L[p.url]` was a `redirect` or a `gone`, it is
   *revived*; implementations SHOULD report it.
2. **Missing pages.** Every URL *u* with `L[u].type = "page"` that is not in B
   is *missing*. For each, in this order, the first rule that applies wins:
   1. **Same source** (certain). `L[u].source` is set and exactly one page in
      B has the same `source` → `redirect` with reason `same-source`.
   2. **Same content** (certain). `L[u].hash` is set and exactly one page in
      B has the same `hash` →
      `redirect` with reason `same-content`.
   3. **Similar content** (estimated). Both `sim` values are set; the
      best-scoring page in B scores at least the
      *auto threshold* (default **0.94**) and beats the second best by at
      least **0.05** → `redirect` with reason `similar:<score>` (two
      decimals). Implementations MUST allow disabling this rule.
   4. **Suggestion.** The best score is at least the *suggest threshold*
      (default **0.80**), or the URL path is similar enough to a page in B
      → the URL is reported as an **orphan with a suggestion**; L′ keeps the
      `page` entry unchanged.
   5. Otherwise the URL is reported as an **orphan**; L′ keeps the `page`
      entry unchanged.
3. **Redirect hygiene.** For every `redirect` in L′:
   - chains are collapsed: while the target is itself a `redirect`, the
     target is replaced with that redirect's target;
   - a cycle is an error;
   - a target that is `gone`, or that is neither a `page` in L′ nor an
     absolute URL, is an error (**broken redirect**).
4. Automatic redirects (rules 2.1–2.3) MUST target paths on the same site.
   An absolute target is only ever written by an explicit human decision.
5. Rules 2.1–2.3 consider only pages in the same language. When one of the
   first two path segments of *u* and of a candidate both look like a locale
   (two letters, optionally followed by a region: `fr`, `pt-br`) and differ,
   the candidate is skipped. Sites often serve the original text as a
   fallback for untranslated pages, so the same content in another language
   is not a page's new home.

A build **passes** when resolution reports no orphans and no errors. In
continuous integration, implementations SHOULD fail the build when it does
not pass.

Decisions made by people (`redirect <from> <to>`, `retire <url>`) are written
to the lockfile directly and are never overridden by resolution, except by
step 1 (a page that is built again is a page).

## 4. Verification against a deployed site

Given an origin (production or a preview deployment), the verifier requests
every URL of the lockfile without following redirects and checks the
invariant of section 1:

- `page`: the response is `200`;
- `redirect`: the response is `301` or `308`, its `Location` resolves to the
  entry's target (a path is resolved against the origin being verified), and
  a request to that target answers `200` without further redirects;
- `gone`: the response is `410` or `404`.

A `page` that answers a single redirect to the same path with a different
trailing slash MUST be reported as a failure with a specific hint, because it
turns every redirect pointing at it into a two-hop chain.

Some hosts cannot answer a 3xx at all (GitHub Pages, for example). There a
`redirect` MAY be served as an HTML page answering `200` with an immediate
`<meta http-equiv="refresh">` to the target. Verifiers MUST report such a
response as a **soft redirect**, distinct from both a pass and a failure, and
MAY let the user accept soft redirects as passing.

The verifier SHOULD use `HEAD` and fall back to `GET` when `HEAD` is not
allowed, SHOULD limit concurrency, and MUST report each failing URL with the
expected and the observed behaviour.

---

## Appendix A. Rationale

- **Why a lockfile and not a config file?** Because it is written by the
  tool and reviewed by people, like `package-lock.json`: a pull request that
  moves URLs shows it in a diff.
- **Why store identity?** So that the certain cases (same source, same
  content) are certain in every environment, including shallow CI
  checkouts.
- **Why one line per URL?** So that two branches that add pages never
  conflict on the same line, and a reviewer sees one changed line per moved
  URL.
- **Why does `gone` accept 404?** Because the contract must be satisfiable
  on every host. The decision is what matters; the status code is the host's
  best effort.
