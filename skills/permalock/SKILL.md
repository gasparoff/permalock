---
name: permalock
description: Keep every published URL of a site working. Use when a build or CI fails with Permalock orphan URLs, when pages are renamed, moved, merged or deleted, or when editing permalock.json or redirects.
---

# Permalock

`permalock.json` locks every URL the site ever published. Each entry must keep
answering: `page` (200), `redirect` (one 301 to `to`), or `gone` (removed on
purpose). Never edit `permalock.json` by hand and never delete entries to make
a build pass.

## When the build fails with orphans

1. Rebuild the site, then run `npx permalock check --json`.
2. For each item in `orphans`, pick one of its `fixes` (ready-to-run commands):
   - the page moved or was merged: `permalock redirect <old> <new>`. Use the
     `suggestion.to` target when it is the page that replaced the old one.
     Check that the target exists in the build.
   - the content was removed on purpose: `permalock retire <old> --reason "<why>"`.
   - the URL was never public (a draft, a preview): `permalock forget <old>`.
3. Run `npx permalock check` again. It must exit 0.
4. Commit `permalock.json` with the change that moved the pages.

If you cannot tell whether a removal was intended, ask the user instead of
retiring the URL: retiring tells every visitor the page is gone for good.

## When moving or renaming pages

Prefer a stable id so the redirect is certain: `permalock: <id>` in the
front matter (Astro) or `<meta name="permalock:id" content="<id>">`. After the
change, run `npx permalock update` (or the site build with `@permalock/astro`)
and review the `redirected` list.

## Useful facts

- `permalock check` writes nothing and fails on orphans; `permalock update`
  records automatic redirects.
- Automatic redirects come from the same source file, identical content, or
  very similar content (labelled `similar:0.97`).
- `npx permalock verify --against <deploy-url> --json` checks a real deployment.
