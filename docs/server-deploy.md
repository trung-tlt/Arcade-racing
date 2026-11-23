# VOLTLINE race server: deploy runbook

One small Linux VM runs the authoritative Node 22 server (`dist-server/index.mjs`, systemd), Caddy terminates TLS in front of it. The browser game stays on Azure Static Web Apps. Nothing here deploys by itself: the GitHub workflow is manual and approval-gated. Files: `deploy/voltline-server.service`, `deploy/Caddyfile`, `deploy/server.env.example`, `deploy/activate.sh`, `.github/workflows/server-deploy.yml`.

## 1. Sizing

- 2 vCPU / 2 GB RAM is enough (about $6-12/month on a budget provider). The server's sim loop is single threaded, so a second core is for Caddy, the OS and headroom; more cores do not add rooms to one process.
- Measured memory is about 400-700 MB RSS for 1-24 rooms on a laptop (section 19 of `docs/multiplayer-release-plan.md`); the unit caps the process at 1.5 GB.
- Region: one region near most players. Players far away pay their RTT; there is no cross-region matchmaking in v1.
- Bandwidth: about 25 KB/s down and 8 KB/s up per player while racing. A full 12-room server (72 players) is roughly 1.8 MB/s (14 Mbit/s) outbound, about 6.5 GB per hour of continuous full load; check the provider's traffic allowance.
- Ubuntu 24.04 LTS or Debian 12, Node 22 LTS (NodeSource or `nvm` system-wide), `caddy` from the official repo, `rsync`, `curl`.

## 2. DNS and firewall

1. Point `race.example.com` (A and AAAA) at the VM. Caddy needs this before it can obtain a certificate.
2. Open 80/tcp (certificate challenge, redirect), 443/tcp and 22/tcp. Do **not** open 8080: the game server listens on loopback only (`HOST=127.0.0.1`).

## 3. One-time VM setup

```sh
sudo useradd --system --home /opt/voltline --shell /usr/sbin/nologin voltline
sudo useradd --create-home --shell /bin/bash voltline-deploy        # the user the workflow logs in as
sudo install -d -o voltline-deploy -g voltline -m 755 /opt/voltline /opt/voltline/releases
sudo install -d -m 750 -o root -g voltline /etc/voltline
sudo cp deploy/server.env.example /etc/voltline/server.env          # then edit
sudo chmod 640 /etc/voltline/server.env && sudo chgrp voltline /etc/voltline/server.env
sudo cp deploy/voltline-server.service /etc/systemd/system/
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile                       # edit the host name first
echo 'voltline-deploy ALL=(root) NOPASSWD: /usr/bin/systemctl restart voltline-server' | sudo tee /etc/sudoers.d/voltline-deploy
sudo systemctl daemon-reload && sudo systemctl enable voltline-server && sudo systemctl reload caddy
```

Add the deploy user's public key to `/home/voltline-deploy/.ssh/authorized_keys`. The service does not start until the first release exists (`/opt/voltline/current`).

## 4. Environment variables (server, `/etc/voltline/server.env`)

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | 8080 | Listen port (Caddy proxies to it). |
| `HOST` | 0.0.0.0 | Bind address. Use `127.0.0.1` behind Caddy. |
| `MAX_ROOMS` | 12 | Room cap (6 humans each). Past it create/quick-match are refused. Chosen from the load test; raise only after re-measuring on the real VM. |
| `REMATCH_SEC` | 30 | Rematch vote length on the results screen. |
| `LOG_LEVEL` | info | `debug`, `info`, `warn`, `error`, `silent`. One JSON line per event on stdout. |
| `TRUST_PROXY` | 0 | Number of proxy hops that append `X-Forwarded-For`. **Set `1` behind Caddy**, otherwise every client appears as 127.0.0.1 and the per-IP limits apply to everyone together. See `docs/server-security.md`. |
| `LEGACY_JOIN` | 1 | Set `0` in production: joins without a `mode` bypass the room-code brute-force throttle. |
| `MAX_CONNECTIONS`, `MAX_CONNECTIONS_PER_IP`, `MAX_ROOMS_PER_IP`, `MAX_ROOM_CREATES_PER_MIN`, `MAX_FAILED_JOINS_PER_MIN` | 200, 8, 4, 20, 10 | Abuse limits. |
| `SOLO_START` | off | `1` lets the host start alone. Dev/e2e only; never in production. |

Client build variable (set where the static site is built, e.g. the Static Web Apps workflow): `VITE_RACE_SERVER=wss://race.example.com`. Players can override per session with `?server=wss://...`. Without it the client tries `ws(s)://<page host>:8080`, which is wrong in production.

## 5. Deploy (manual, approved)

1. GitHub: Settings > Environments > create `production-server`, add **Required reviewers**. Add secrets `DEPLOY_HOST`, `DEPLOY_USER` (`voltline-deploy`), `DEPLOY_SSH_KEY` (private key, no passphrase, used only here), `DEPLOY_KNOWN_HOSTS` (output of `ssh-keyscan -t ed25519 <host>`); optional variable `DEPLOY_PATH` (default `/opt/voltline`).
2. Actions > `server-deploy` > Run workflow (choose the ref). It runs `tsc`, `vitest` and `npm run server:build`, then stops at the approval gate. After approval it rsyncs the release to `/opt/voltline/releases/<utc>-<sha>/` and runs `activate.sh` there.
3. `activate.sh` installs runtime deps (`npm ci --omit=dev`: `ws`, `three`, `@dimforge/rapier3d-compat`, which the bundle imports as externals), flips `/opt/voltline/current`, restarts the service, polls `/health` for 30 s and **rolls back automatically** to the previous release if it does not answer. It keeps the last 4 releases.

A release directory must contain exactly: `dist-server/index.mjs`, `data/colliders/*.json`, `package.json`, `package-lock.json`, `node_modules/` (after `activate.sh`). **`data/colliders` must sit next to the working directory** (`WorkingDirectory=/opt/voltline/current`): the server loads `data/colliders/<track>.json` relative to `process.cwd()` and, if a file is missing, silently races without scenery collision, which then disagrees with the clients' prediction.

## 6. Checks and operations

- Health: `curl -s https://race.example.com/health` returns rooms, players, tick p50/p99/max (last 60 s of steps), uptime, snapshot rate, RSS. Expect `tickMsP99` well under 8 and `snapshotsPerSec` about `players x 20` while racing.
- Metrics (Prometheus text): `curl -s http://127.0.0.1:8080/metrics` on the VM (Caddy answers 404 for `/metrics`): rooms, players by phase, tick ms, snapshot bytes/s, rejects by reason, late/rate-limited input frames, CPU seconds, RSS, uptime.
- Logs: `journalctl -u voltline-server -f` (JSON lines: `room_created`, `room_closed`, `race_start`, `race_end` with `durationSec`, `reject` at `LOG_LEVEL=debug`).
- Load check before launch or after changing the cap, from a dev machine: `node scripts/loadtest.mjs --url wss://race.example.com --rooms 4,8,12 --measure 60` (use a spare server, it fills rooms with bots; the server must allow many connections from your IP).
- Restart: `sudo systemctl restart voltline-server` (connected races end; there is no reconnect in v1).

## 7. Rollback

Automatic when the health check fails during a deploy. Manual, to any kept release:

```sh
ls -1t /opt/voltline/releases
ln -sfn /opt/voltline/releases/<id> /opt/voltline/current.new && mv -Tf /opt/voltline/current.new /opt/voltline/current
sudo systemctl restart voltline-server
```

Rolling back the server also needs a compatible client: the client and server must agree on the protocol version and the data hash or joins are refused (`version` / `data` rejects). Deploy the server first when a change is additive, and keep the previous client reachable until players have refreshed.

## 8. Not covered

TLS and DNS were not exercised from this repository (no VM was touched). First deploy should be rehearsed on a throwaway VM; see the "could not verify" list in section 19 of the release plan.

## 9. First real deployment (2026-11-23)

Rehearsal notes from the first VM (AWS EC2, ap-southeast-1, Ubuntu 26.04, **1 vCPU / 951 MB**, x86_64), installed as this runbook says with these differences:
- Deploy user is `ubuntu` (already has sudo) instead of `voltline-deploy`; the service still runs as the `voltline` system user. A 2 GB swap file was added.
- Node 22.22 and Caddy 2.6.2 come from the Ubuntu repos (`apt install nodejs npm caddy`). Caddy 2.6 does not know `stream_close_delay`; the line was removed from the VM's Caddyfile (a Caddy reload can then cut live races, so reload only when the server is empty).
- **Domain:** `racing-server.craftmann.app` (Route 53 A record to the VM, TTL 300; the zone is in another AWS account than the one this repo's tooling reaches). Caddy obtained the certificate on its own. Let's Encrypt refuses `*.amazonaws.com` names, so the EC2 hostname cannot be used; `47-129-48-111.sslip.io` served as a stopgap for the first hour. The game client (`racing.craftmann.app`, Amplify) needs the build variable `VITE_RACE_SERVER=wss://racing-server.craftmann.app`.
- Release uploaded with rsync (`dist-server/index.mjs`, `data/colliders`, `package.json`, `package-lock.json`) and `deploy/activate.sh`; the GitHub workflow was not used.
- Load test from a laptop through an SSH tunnel (port 8080 stays closed): see section 18.5 of the release plan. `MAX_ROOMS=6` in production.
- Ports 80, 443 and 22 are open in the security group; 8080 is not.
