# Security

## Reporting a vulnerability

Please don't open a public issue. Use
[private vulnerability reporting](https://github.com/gasparoff/permalock/security/advisories/new)
on GitHub. You will get an answer within a few days.

## What is in scope

- The `permalock` CLI and library, and `@permalock/astro`: the latest
  published version.
- The public scanner at [permalock.dev](https://permalock.dev)
  ([apps/scanner](apps/scanner)). It fetches addresses chosen by visitors, so
  reports about requests it should refuse are especially welcome.

A scan that shows wrong numbers is a bug, not a vulnerability: open a
[wrong scan result](https://github.com/gasparoff/permalock/issues/new?template=scan.yml)
issue.
