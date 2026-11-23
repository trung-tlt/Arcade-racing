# Race server security

Scope: the authoritative `ws` server (`src/server`). Threat model: an anonymous, hostile client on the internet. There are no accounts, so the goals are: no crash, no unbounded memory or CPU, no room or slot hogging, no cheating beyond what the server's authority already prevents, and no way to make the server a harassment or amplification tool.

## What is enforced, and where

| Threat                                                                           | Defence                                                                                                                                                                                                                                | Where                               |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| Oversized, deeply nested, binary or compressed frames                            | `maxPayload` 1200 B, 600-char message cap, binary frames rejected, no permessage-deflate (no zip bombs). Nesting is bounded by the 600-char cap.                                                                                       | `NetServer`, `parseClientMessage`   |
| Prototype pollution                                                              | Messages are read by field, never merged; `__proto__` keys are inert (tested).                                                                                                                                                         | `protocol.ts`                       |
| NaN, Infinity, huge, negative or fractional ticks                                | Strict `isNum`; input `tick` must be an integer in `0..2^31-1`; analog axes clamped.                                                                                                                                                   | `parseClientMessage`                |
| Frame-buffer memory growth                                                       | Frames more than 90 ticks ahead are dropped, duplicates ignored, consumed frames deleted: at most ~90 frames per player. A far-future tick cannot set `ackTick`.                                                                       | `Room.onInput`                      |
| Names: controls, RTL/bidi overrides, zero-width, BOM, C1, lone surrogates, zalgo | Stripped or limited (3 combining marks in a row), NFC-normalised, capped at 16 code points (a pair is never split), markup characters removed, empty -> `Player`. Emoji are allowed.                                                   | `sanitizeName`                      |
| Room codes                                                                       | Joins by code are cleaned to the alphabet; codes are generated with `crypto.randomInt`.                                                                                                                                                | `protocol.ts`, `NetServer.newCode`  |
| Room-code brute force (32^6 codes, `not_found` is an oracle)                     | Per IP, `MAX_FAILED_JOINS_PER_MIN` (10) misses on `mode: join` per minute, then `rate`.                                                                                                                                                | `NetServer.rejectJoin`, `limits.ts` |
| Message flooding                                                                 | Input: token bucket (180/s, burst 120; 600 drops -> disconnect). Every other message type: bucket of 10/s, burst 30 (each ready/car/settings/rematch fans out to the whole room); 200 drops -> `rate` + disconnect. `leave` is exempt. | `Room.handle`                       |
| Join/leave churn creating and closing rooms                                      | Per IP: at most `MAX_ROOMS_PER_IP` (4) open rooms and 20 room creations per minute; rooms are reaped when empty.                                                                                                                       | `NetServer.pickRoom`                |
| Room-cap exhaustion by one IP                                                    | The per-IP room cap above, plus `MAX_ROOMS` global.                                                                                                                                                                                    | same                                |
| Connection floods                                                                | Per IP (`MAX_CONNECTIONS_PER_IP`, 8) and global (`MAX_CONNECTIONS`, 200). Pre-upgrade sockets are capped by `http.maxConnections`.                                                                                                     | `NetServer.onConnection`            |
| Real client IP behind Caddy                                                      | See below.                                                                                                                                                                                                                             | `limits.clientIp`                   |
| Slow-loris and half-open sockets                                                 | HTTP `headersTimeout`/`requestTimeout` 10 s; a socket must `join` within 5 s; 30 s without any message closes it. Timeouts use `terminate()` (a half-open peer never answers a close frame).                                           | `NetServer`                         |
| Clients that do not read (buffer growth)                                         | `bufferedAmount` above 1 MiB (`maxBufferedBytes`, about 15 s of snapshots) -> terminate.                                                                                                                                               | `limits.guardedSend`                |
| Host-only messages from non-hosts, settings outside the lobby                    | `settings` and `start` need `host` and the lobby phase; ignored otherwise (tested).                                                                                                                                                    | `Room.handle`                       |
| Lag-comp `vt` claim                                                              | Clamped to `0..1e9` by the parser, then to `[now - maxRewindMs, now]` by the sim, so a claim cannot reach further back than the rewind cap.                                                                                            | `parseClientMessage`, `RaceSim`     |
| A message or tick that throws                                                    | The message handler is wrapped: only that player's socket is terminated. `Room.tick` is wrapped per room: the room is closed and its players dropped; other rooms and the process keep running (tested by making a room throw).        | `NetServer.pump`, `onMessage`       |

## Client IP and TRUST_PROXY

Default: the socket's remote address. `X-Forwarded-For` is client-controlled and is ignored, so spoofing it cannot dodge or poison a limit.

Behind Caddy (or any reverse proxy) every client shares the proxy's address, so the per-IP limits would hit everyone at once. Set `TRUST_PROXY=<hops>` (`1` for a single Caddy; `true` means 1). The server then takes the entry `hops` from the right of `X-Forwarded-For`: that is the address your own proxy appended. Anything to its left was supplied by the client and is ignored. A malformed entry, or a header with fewer entries than hops, falls back to the socket address. Only enable it when the server is reachable only through the proxy; otherwise a client can connect directly and send a forged header.

## Environment knobs

| Variable                   | Default       | Meaning                                                                                                                                             |
| -------------------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`, `HOST`             | 8080, 0.0.0.0 | Listen address                                                                                                                                      |
| `MAX_ROOMS`                | 20            | Rooms across all players                                                                                                                            |
| `MAX_ROOMS_PER_IP`         | 4             | Open rooms one IP may create                                                                                                                        |
| `MAX_CONNECTIONS`          | 200           | Global open connections                                                                                                                             |
| `MAX_CONNECTIONS_PER_IP`   | 8             | Per IP                                                                                                                                              |
| `MAX_FAILED_JOINS_PER_MIN` | 10            | Missed code joins per IP before `rate`                                                                                                              |
| `TRUST_PROXY`              | 0             | Trusted proxy hops for `X-Forwarded-For`                                                                                                            |
| `LEGACY_JOIN`              | 1             | `0` rejects a `join` without a `mode` (join-or-create by name, a dev/test path that the brute-force limiter does not cover). Set `0` in production. |

Further options (`NetServerOptions`: `maxRoomCreatesPerMin`, `maxBufferedBytes`, `idleTimeoutMs`, `joinTimeoutMs`) are code-level.

## Residual risks

- No accounts: anyone can use any name, including a copy of someone else's (impersonation is by design; names are display-only and the roster shows ids).
- Volumetric DDoS needs provider-level protection (the host's network filtering or a proxy/CDN in front). In-process limits only bound what a few addresses can cost.
- IPv6: limits are per address, so an attacker with a /64 can rotate addresses. Keying by /64 is a possible later change.
- Many distinct IPs (botnet) can still fill the global connection and room caps; that is a denial of service the caps contain, not prevent.
- `Origin` is not checked: any web page can open a socket from a visitor's browser (no cookies or credentials are involved, so the cost is an extra connection counted against that visitor's IP).
- Joins in legacy mode are not covered by the failed-join limiter (use `LEGACY_JOIN=0`).
- Lag compensation trusts the claimed view tick within the rewind cap (about 200 ms of favour to a lying shooter), by design.
- A bug that throws inside a room closes that room for its players; it is logged but there is no alerting.
