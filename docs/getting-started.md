# Getting started with any static site

Permalock reads the HTML your generator writes, so it works the same way with
Hugo, Eleventy, Jekyll, VitePress, Docusaurus or a folder of hand-written
pages. This guide uses Hugo and Eleventy. Astro has its own integration:
see [packages/astro](../packages/astro/README.md).

## 1. Lock the URLs you have today

Build the site, then create the lockfile from the build:

```sh
hugo                      # writes public/
npx permalock init        # finds public/, writes permalock.json
```

```sh
npx @11ty/eleventy        # writes _site/
npx permalock init        # finds _site/, writes permalock.json
```

`init` looks for `dist`, `build`, `out`, `_site` and `public`. Pass the folder
if yours is elsewhere: `npx permalock init site/`. Commit `permalock.json`.

If the site lives under a path, like `https://example.com/docs/`, add
`--base /docs` to every command.

## 2. Change things, build again

Rename a post, move a section, delete a page. Then:

```sh
hugo && npx permalock update
```

```text
permalock 5 URLs locked · 1 new · 1 redirect created · 1 orphan
  + /posts/hello/                        new page
  → /posts/hello-world/ → /posts/hello/  identical content
  ✗ /posts/summer-sale/                  orphan
      suggestion: /  (content 0.86)
      fix: permalock redirect /posts/summer-sale/ /   or   permalock retire /posts/summer-sale/

1 URL would break. Decide each one, then build again.
```

A page that moved gets a redirect in the lockfile. A page that disappeared is
an **orphan**: decide what it should answer.

```sh
npx permalock redirect /posts/summer-sale/ /posts/   # it lives on somewhere else
npx permalock retire /posts/summer-sale/ --reason "campaign ended"   # removed on purpose
npx permalock resolve                                 # or go through them one by one
```

## 3. Tell your host about the redirects

Static hosts serve redirects from their own config file. Write it after every
build:

```sh
npx permalock emit netlify      # public/_redirects
npx permalock emit cloudflare   # _redirects, Cloudflare Pages syntax
npx permalock emit vercel       # vercel.json
npx permalock emit nginx        # an nginx include
npx permalock emit html         # a small redirect page per old URL (GitHub Pages)
```

In a Hugo or Eleventy project the usual place is the build script:

```json
{
  "scripts": {
    "build": "hugo && npx permalock check && npx permalock emit netlify"
  }
}
```

## 4. Fail the build in CI

```yaml
# .github/workflows/site.yml
- run: hugo
- run: npx permalock check   # exits 1 if a URL would break
```

`check` never writes the lockfile. Developers run `update` locally and commit
the result, the same way you commit a `package-lock.json`.

## Make moves certain

Without help, Permalock recognises a moved page by its text: identical text is
certain, very similar text is labelled with its score. Two small template
changes make it certain even when you edit a page while you move it.

**Mark the source file.** Pages that come from the same file keep their
identity whatever their URL becomes, so a changed slug or a new section path
always gets its redirect.

Hugo, in your base layout:

```go-html-template
{{ with .File }}<span data-permalock-source="{{ .Path }}" hidden></span>{{ end }}
```

Eleventy (Nunjucks or Liquid), in your base layout:

```njk
<span data-permalock-source="{{ page.inputPath }}" hidden></span>
```

Permalock removes these markers from the text it compares, so they never
change a page's fingerprint.

**Or give a page a stable id** that survives renaming the file too. In the
front matter, `permalock: pricing`, and in the layout:

```go-html-template
{{ with .Params.permalock }}<meta name="permalock:id" content="{{ . }}">{{ end }}
```

```njk
{% if permalock %}<meta name="permalock:id" content="{{ permalock }}">{% endif %}
```

## Already lost some URLs?

`npx permalock import example.com` adds every URL the Wayback Machine and your
old sitemaps remember to the lockfile. With `--check-live` it first keeps the
redirects your host already serves. Then run `npx permalock resolve` and give
each old URL a home.

## With a coding agent

Copy [skills/permalock](../skills/permalock/SKILL.md) into your agent's skills
folder, or add this line to `AGENTS.md`:

> After changing pages, build the site, run `npx permalock check --json` and
> settle every orphan with one of its `fixes`.
