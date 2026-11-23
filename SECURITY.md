# Security policy

## Reporting a vulnerability

Please do **not** open a public issue for a security problem. Report it privately through GitHub's
[private vulnerability reporting](https://github.com/trung-tlt/racing/security/advisories/new) for this repository
(Security tab, "Report a vulnerability"). Include what you found, how to reproduce it and the impact you expect. You
can expect an acknowledgement within a few days.

## Scope

- The race server (`src/server/`, `src/shared/protocol.ts`): message validation, rate limits, connection limits, room
  handling. How it is hardened, and what is deliberately not covered, is in [docs/server-security.md](docs/server-security.md).
- The browser client (`src/`), including how it handles server messages.

Out of scope: volumetric denial of service (use your host's or a CDN's protection), and the fact that there are no
accounts (players are guests with typed names, by design).

## Running your own server

Follow [docs/server-deploy.md](docs/server-deploy.md). In production set `TRUST_PROXY=1` behind a reverse proxy and
`LEGACY_JOIN=0`, and keep the game server's port closed to the internet.
