# Server Inventory — `ser918228796695`

**Read-only service inventory for the "Server Center" monitoring page.**

| Field | Value |
|---|---|
| Hostname | `ser918228796695` |
| OS | Ubuntu 24.04.1 LTS (noble) |
| Kernel | `6.8.0-48-generic` x86_64 |
| Public IP | `186.244.203.27` |
| SSH | port `28987`, user `root` |
| Snapshot taken | 2026-09-30 ~12:22–12:26 UTC (server clock) |

> **Method / limits.** All data below was collected with read-only inspection commands (`docker ps`/`inspect`, `systemctl`, `ss`, `nginx -T`, `ufw status`, `curl`, `free`/`nproc`/`df`/`uptime`) executed over SSH via `scripts/remote-exec.py`. No state-changing command was run: no restart/stop/prune, no `systemctl start/stop/reload`, no `nginx -s reload`, no package installs, no writes outside `/tmp`. No secret value (API key, token, password, private key) appears in this document; the CPA key was held only in a shell variable from which its **length** was measured, and is reported as `REDACTED`. Items that could not be determined are marked **NOT DETERMINED** rather than guessed.

---

## 1. Docker containers

`docker ps -a --format` plus `docker inspect` (health, restart policy, port bindings, restart count, compose labels).

| Name | Image | State | Health | Published ports | Restart policy |
|---|---|---|---|---|---|
| `open-webui` | `open-webui-legacy-cpu:local` | running | **healthy** | `0.0.0.0:3000 -> 8080/tcp` | `unless-stopped` |
| `cli-proxy-api` | `eceasy/cli-proxy-api:latest` | running | *no healthcheck defined* | **none published** (`network_mode: host`) | `unless-stopped` |
| `sub2api` | `weishaw/sub2api:latest` | running | **healthy** | `127.0.0.1:8080 -> 8080/tcp` | `unless-stopped` |
| `sub2api-redis` | `redis:8-alpine` | running | **healthy** | `6379/tcp` (container-internal only) | `unless-stopped` |
| `sub2api-postgres` | `postgres:18-alpine` | running | **healthy** | `5432/tcp` (container-internal only) | `unless-stopped` |

### Detail

| Name | Created (UTC) | Restart count | Networks / IP | Healthcheck command | Compose project |
|---|---|---|---|---|---|
| `open-webui` | 2026-09-29T09:40:27Z | 0 | `bridge` @ `172.17.0.2` | `curl --silent --fail http://localhost:${PORT:-8080}/health \| jq -ne 'input.status == true' \|\| exit 1` | *(none — no compose labels)* |
| `cli-proxy-api` | 2026-09-30T07:57:03Z | — | **host** network | *(none)* | `cliproxyapi` — `/opt/cliproxyapi`, `/opt/cliproxyapi/docker-compose.yml` |
| `sub2api` | 2026-09-29T04:48:19Z | — | `sub2api_sub2api-network` @ `172.18.0.4` | `wget -q -T 5 -O /dev/null http://localhost:8080/health` | `sub2api` — `/opt/sub2api`, `/opt/sub2api/docker-compose.yml` |
| `sub2api-redis` | 2026-09-24T14:26:05Z | — | `sub2api_sub2api-network` | `redis-cli ping` | `sub2api` |
| `sub2api-postgres` | 2026-09-24T14:26:04Z | — | `sub2api_sub2api-network` | `pg_isready -U sub2api -d sub2api` | `sub2api` |

Notes:

- Uptime at snapshot: `open-webui` "Up 27 hours", `cli-proxy-api` "Up 4 hours", `sub2api` "Up 32 hours", `sub2api-redis`/`sub2api-postgres` "Up 5 days".
- `cli-proxy-api` publishes **no** host ports because it uses `network_mode: host`; the `CLIProxyAPI` process therefore binds the host loopback directly (see §3). Its `docker port` output is empty.
- `open-webui` has **no** compose project labels and no compose file was found for it under `/opt`, `/root`, or `/etc` — it was created directly with `docker run` (mount: named volume `open-webui` → `/app/backend/data`).
- `sub2api` port mapping comes from `ports: - "${BIND_HOST:-0.0.0.0}:${SERVER_PORT:-8080}:8080"` in `/opt/sub2api/docker-compose.yml`; the effective `BIND_HOST` in `/opt/sub2api/.env` is loopback (observed binding is `127.0.0.1`). The `.env` file was **not** opened.
- Local image inventory includes `open-webui-legacy-cpu:local` (6.6 GB, image ID `7e26de53c2ac`, built ~27 h before snapshot from `/root/open-webui-legacy-cpu/Dockerfile`) and the upstream `ghcr.io/open-webui/open-webui:main` (6.51 GB).
- `/var/lib/docker` on-disk usage: **6.5 GB**.

---

## 2. systemd services

`systemctl is-active` / `is-enabled` / `SubState`.

| Unit | Active | Enabled | Sub-state | Notes |
|---|---|---|---|---|
| `nginx.service` | active | enabled | running | nginx/1.24.0 (Ubuntu), 1 master + 4 workers |
| `docker.service` | active | enabled | running | `dockerd -H fd://` |
| `containerd.service` | active | enabled | running | |
| `ssh.service` | active | enabled | running | `sshd.service` is an **alias** → `ssh.service`; listener on `:28987` |
| `fail2ban.service` | active | enabled | running | 1 jail (`sshd`); 0 currently banned, 0 total banned |
| `cron.service` | active | enabled | running | 4 files in `/etc/cron.d` (see below) |
| `open-terminal.service` | active | enabled | running | **app-like.** Custom unit `/etc/systemd/system/open-terminal.service`, `User=aiops`, `open-terminal run --host 172.17.0.1 --port 8000`; restarts `on-failure` |
| `ufw.service` | active | enabled | exited | firewall (one-shot); UFW status `active` |
| `unattended-upgrades.service` | active | enabled | running | |
| `rsyslog.service` | active | enabled | running | |
| `snapd.service` | active | enabled | running | |
| `systemd-resolved.service` | active | enabled | running | also owns `:53` |
| `certbot.service` | **inactive** | *(n/a)* | dead | `certbot.timer` is **enabled + active**; next run 2026-09-30 15:28 UTC |
| `fail2ban` / `sshd` jail detail | — | — | — | filter matches `_SYSTEMD_UNIT=sshd.service` |

Other notable active units: `systemd-networkd`, `systemd-journald`, `systemd-logind`, `systemd-udevd`, `polkit`, `dbus`, `multipathd`, `thermald` (inactive/dead), `apparmor` (active/exited). `snap.lxd.*` units exist on disk but are inactive.

Scheduled maintenance (timers + cron):

- `certbot.timer` — enabled/active, next 2026-09-30 15:28 UTC.
- `/etc/cron.d/ai-gateway-backup` — `20 1,7,13,19 * * *` → `/usr/local/sbin/ai-gateway-backup` (log `/var/log/ai-gateway-backup.log`).
- `/etc/cron.d/server-backup` — `0 */6 * * *` → `server-backup postgres`; `15 3 * * *` → `server-backup full` (log `/var/log/server-backup.log`).
- `/etc/cron.d/certbot` — 12-hourly guarded renewal.
- `/etc/cron.d/sysstat`, `/etc/cron.d/e2scrub_all` — stock Ubuntu.
- `crontab -l` for root: *no crontab*.
- Enabled timers also include `apt-daily`, `apt-daily-upgrade`, `dpkg-db-backup`, `logrotate`, `fstrim`, `e2scrub_all`, `man-db`, `motd-news`, `update-notifier-*`, `systemd-tmpfiles-clean`.

---

## 3. Listening TCP ports

`ss -lntp` on the host (container-internal listeners are invisible to it).

| Port | Bind address | PID / process | Belongs to |
|---|---|---|---|
| `443` | `0.0.0.0` and `[::]` | nginx (master 2364659 + 4 workers) | nginx TLS ingress |
| `80` | `0.0.0.0` and `[::]` | nginx (master 2364659 + 4 workers) | nginx HTTP (ACME + redirects) |
| `3000` | **`0.0.0.0`** | `docker-proxy` pid 1978620 | → `172.17.0.2:8080` = **open-webui** |
| `8080` | `127.0.0.1` | `docker-proxy` pid 1887219 | → `sub2api` container |
| `8317` | `127.0.0.1` | `CLIProxyAPI` pid 2400460 (host network) | CLI Proxy API (CPA) |
| `8000` | `172.17.0.1` | `open-terminal` pid 2364655 (user `aiops`) | Open Terminal bare-metal API |
| `28987` | `0.0.0.0` and `[::]` | `sshd` pid 2364633 | SSH |
| `53` | `127.0.0.53`, `127.0.0.54` | `systemd-resolve` pid 2364647 | DNS stub (TCP+UDP) |

- **No host listener** exists on `6379` (Redis) or `5432` (Postgres) — confirmed absent from `ss -lntp`; those containers expose their ports only inside `sub2api_sub2api-network`.
- UDP: only `systemd-resolved` on `127.0.0.53` and `127.0.0.54`.

### External reachability (verified from an off-server Windows host)

| Port | Result from outside | Evidence |
|---|---|---|
| `3000` | **OPEN — reachable** | `curl http://186.244.203.27:3000/health` → `200`, body `{"status":true}` |
| `80` | open | `curl http://186.244.203.27:80` (nginx) |
| `443` | open | `https://api.stellarbit.site/health` → `200` |
| `28987` | open | SSH |
| `8317` | **NOT reachable** (filtered/timeout) | `curl http://186.244.203.27:8317/healthz` → `000` after 5.3 s |
| `8080` | **NOT reachable** (filtered/timeout) | `curl http://186.244.203.27:8080/health` → `000` after 5.3 s |

---

## 4. Nginx routing

`nginx -T` full dump. Only **one** site is enabled: `/etc/nginx/sites-enabled/domains.conf` → `/etc/nginx/sites-available/domains.conf`. `/etc/nginx/sites-available/sub2api.conf` and `.../default` exist on disk but are **not symlinked into `sites-enabled`** (so they are inert). No `streams-enabled` directory exists. `conf.d/` holds only `sub2api-limits.conf` (rate-limit zones + `$connection_upgrade` map).

### Hostname → upstream

| Hostname | Listener | `proxy_pass` upstream | Backend service | Rate limiting |
|---|---|---|---|---|
| `api.stellarbit.site` | `443 ssl` + `[::]:443 ssl ipv6only=on` | `http://127.0.0.1:8080` | **sub2api** | `limit_conn sub2api_conn 40`; `~ ^/(auth\|api/auth)/` → `sub2api_auth` 5 r/s burst 10; `~ ^/(v1/)?(embeddings\|alpha/search)$` → `sub2api_api` 30 r/s burst 60, body ≤ 32 m; `location /` → `sub2api_api` burst 60 |
| `cpa.stellarbit.site` | `443 ssl` + `[::]:443 ssl` | `http://127.0.0.1:8317` | **CPA (cli-proxy-api)** | none |
| `api.stellarbit.site` | `80` + `[::]:80` | none | — | `if ($host = api.stellarbit.site) return 301 https://…`; otherwise `return 404` |
| `cpa.stellarbit.site` | `80` + `[::]:80` | none | — | `if ($host = cpa.stellarbit.site) return 301 https://…`; otherwise `return 404` |

Both TLS vhosts share the same certificate lineage: `stellarbit-services`.
Both vhosts `include` a proxy snippet (`/etc/nginx/snippets/sub2api-proxy.conf`, `/etc/nginx/snippets/cpa-proxy.conf`) with: `proxy_http_version 1.1`, `Host`/`X-Real-IP`/`X-Forwarded-For`/`X-Forwarded-Proto` headers, WebSocket upgrade headers, buffering **off**, `proxy_read_timeout 1800s`.
`http.client_max_body_size` for `api.stellarbit.site` is `256m` (32 m on the embeddings/search location); `client_header_timeout 10s`; `large_client_header_buffers 4 16k`.

**Exhaustive `server_name` list found anywhere in `/etc/nginx/`** (only two real hostnames):

1. `api.stellarbit.site`
2. `cpa.stellarbit.site`

Every other `server_name` match is a stock file: `uwsgi_params`/`scgi_params`/`fastcgi_params` (`SERVER_NAME $server_name`), the commented `server_names_hash_bucket_size`, and the **disabled** `/etc/nginx/sites-available/default` (`server_name _`) and `sites-available/sub2api.conf` (`server_name _`).

### Default-host behaviour (important)

No `default_server` is declared on `443`. nginx therefore serves the **first** `443` server block — `api.stellarbit.site` (Sub2API) — for any unmatched `Host`. Verified:

- `curl -k https://127.0.0.1/ -H 'Host: open-webui'` → `200`, body `<title>Sub2API - AI API Gateway</title>` (CSP + `X-Frame-Options: DENY` headers).
- `curl -k https://127.0.0.1/health -H 'Host: open-webui'` → `200`, body `{"status":"ok"}` — i.e. **Sub2API's** health payload, not Open WebUI's.

On port `80`, an unmatched `Host` gets `404` (from the `return 404` in the ACME vhosts).

---

## 5. TLS certificates (`/etc/letsencrypt/live/`)

Directory names under `/etc/letsencrypt/live/`:

1. `README` *(file, not a lineage)*
2. **`stellarbit-services`** ← the only certificate lineage

Contents of `/etc/letsencrypt/live/stellarbit-services/`: `README`, `cert.pem`, `chain.pem`, `fullchain.pem`, `privkey.pem`. *(File names only; no key or certificate material was read or copied.)*

Public-certificate metadata (from `openssl x509 -noout`, no private data):

| Field | Value |
|---|---|
| Subject CN | `api.stellarbit.site` |
| SAN | `DNS:api.stellarbit.site`, `DNS:cpa.stellarbit.site` |
| Issuer | `C = US, O = Let's Encrypt, CN = YE2` |
| Not after | **Dec 23 14:17:49 2026 GMT** |
| Renewal config | `/etc/letsencrypt/renewal/stellarbit-services.conf` (sole file) |

There is **no** certificate for any Open WebUI hostname.

---

## 6. Open WebUI reachability — verdict

> ### VERDICT: **NO public HTTPS hostname exists for Open WebUI.**
> Open WebUI is reachable from the internet **only** as plaintext HTTP on a raw IP + port: **`http://186.244.203.27:3000/`** (health: `http://186.244.203.27:3000/health`, HTTP 200, `{"status":true}`). It is **not** proxied by nginx on any hostname, and it is **not** covered by TLS.

Evidence:

1. **No nginx hostname routes to it.** `grep -rn '3000' /etc/nginx/` → *NO MATCH*. `grep -rniE 'webui|chat\.|ai\.|llm' /etc/nginx/` → *NO MATCH*. The only two `server_name` values in the entire nginx configuration are `api.stellarbit.site` and `cpa.stellarbit.site`, which proxy to `127.0.0.1:8080` and `127.0.0.1:8317` respectively. The only `proxy_pass` targets in the whole config are `http://127.0.0.1:8080` (×6) and `http://127.0.0.1:8317` (×1) — none points at `:3000`.
2. **No certificate.** `/etc/letsencrypt/live/` contains a single lineage, `stellarbit-services`, whose SANs are only `api.stellarbit.site` and `cpa.stellarbit.site`. No webui/chat/ai hostname is covered.
3. **No compose definition.** The only compose files under `/opt` are `/opt/cliproxyapi/docker-compose.yml` and `/opt/sub2api/docker-compose.yml`; a recursive case-insensitive search of `/opt` for `open-webui|open_webui|3000|webui` across `*.yml|*.yaml|*.conf|*.env|*.json` returned **nothing**. The `open-webui` container carries **no** `com.docker.compose.*` labels, and no launch script referencing `open-webui-legacy-cpu` was found under `/root`, `/usr/local/sbin`, `/usr/local/bin`, or `/etc`. It runs standalone via `docker run`.
4. **The port is deliberately open to the world.** `ufw status verbose` → `[5] 3000/tcp ALLOW IN Anywhere # open-webui` and `[9] 3000/tcp (v6) ALLOW IN Anywhere (v6) # open-webui`. Docker's NAT confirms the publish: `-A DOCKER ! -i docker0 -p tcp --dport 3000 -j DNAT --to-destination 172.17.0.2:8080`, and `docker port open-webui` → `8080/tcp -> 0.0.0.0:3000`. UFW default policy is **deny (incoming)**.
5. **Confirmed live from outside the server.** From an external Windows host: `curl http://186.244.203.27:3000/health` → **HTTP 200**, body `{"status":true}`; `curl http://186.244.203.27:3000/` → **HTTP 200**.
6. **HTTPS on 443 does *not* reach it.** An arbitrary/unknown `Host` on `:443` falls through to the Sub2API vhost (proved in §4: the response is `Sub2API - AI API Gateway`, and `https://<unknown-host>/health` returns Sub2API's `{"status":"ok"}`). This is not an Open WebUI route.

Consequences worth flagging for the monitoring feature: Open WebUI traffic is **unencrypted** and served **without a reverse proxy**, so its URL must be presented as `http://186.244.203.27:3000` (no hostname, no TLS, no cert to monitor). Any "public HTTPS URL" field for Open WebUI should be reported as **none**.

---

## 7. HTTP health probes

All probes used `curl -s -o /dev/null -w '%{http_code}' --max-time 8`, issued **on the server** unless labelled *external*.

| Service | Exact URL | Status | Response body | Notes |
|---|---|---|---|---|
| **open-webui** | `http://127.0.0.1:3000/health` | **200** | `{"status":true}` | ✅ **Use this.** Matches the container's own healthcheck. Also `http://127.0.0.1:3000/` → 200 (`<title>Open WebUI</title>`, `server: uvicorn`), `/api/config` → 200 |
| **open-webui** *(external)* | `http://186.244.203.27:3000/health` | **200** | `{"status":true}` | ✅ Confirmed from an off-server host |
| **CPA (cli-proxy-api)** | `http://127.0.0.1:8317/healthz` | **200** | `{"status":"ok"}` | ✅ **Use this — unauthenticated, no key needed.** |
| **CPA** *(through nginx)* | `https://cpa.stellarbit.site/healthz` | **200** | `{"status":"ok"}` | ✅ Verified with `--resolve cpa.stellarbit.site:443:127.0.0.1` |
| **CPA** *(no key)* | `http://127.0.0.1:8317/v1/models` | 401 | `{"error":"Missing API key"}` | key required |
| **CPA** *(with key)* | `http://127.0.0.1:8317/v1/models` | **200** | model list, e.g. `{"data":[{"id":"gemini-3.7-flash-high",…` | key read from `/opt/cliproxyapi/config.yaml` into a shell variable; value never printed |
| **CPA** | `http://127.0.0.1:8317/health` | **404** | *(empty)* | ⚠️ does **not** exist (404 with and without the key) — do not monitor this path |
| **sub2api** | `http://127.0.0.1:8080/health` | **200** | `{"status":"ok"}` | ✅ **Use this.** Matches the container's own healthcheck |
| **sub2api** *(through nginx)* | `https://api.stellarbit.site/health` | **200** | `{"status":"ok"}` | ✅ Verified with `--resolve api.stellarbit.site:443:127.0.0.1` |
| **sub2api** | `http://127.0.0.1:8080/api/health` | 404 | *(empty)* | does not exist |
| **open-terminal** | `http://172.17.0.1:8000/` (and `/ports`, `/files/cwd`, `/execute`) | 200 | — | reached only from `172.17.0.0/16` (Docker bridge); UFW-scoped |

### Route-discrimination check (avoids false-positive probes)

Several backends serve a single-page app that answers **any** unknown path with `200`. Probing `/healthz` on sub2api would therefore look "up" even if the app were broken:

| URL | Status | Body | Interpretation |
|---|---|---|---|
| `http://127.0.0.1:8080/health` | 200 | `{"status":"ok"}` | genuine health route |
| `http://127.0.0.1:8080/healthz` | 200 | SPA HTML | ⚠️ **false positive** — SPA catch-all |
| `http://127.0.0.1:8080/zzz-not-a-real-route` | 200 | SPA HTML | confirms catch-all behaviour |
| `http://127.0.0.1:3000/health` | 200 | `{"status":true}` | genuine health route |
| `http://127.0.0.1:3000/zzz-not-a-real-route` | 200 | SPA HTML | SPA catch-all (so `/health` must be checked for its JSON body) |
| `http://127.0.0.1:8317/healthz` | 200 | `{"status":"ok"}` | genuine health route |
| `http://127.0.0.1:8317/zzz-not-a-real-route` | 404 | *(empty)* | CPA is **not** a catch-all → `/healthz` is trustworthy |
| `http://127.0.0.1:8317/` | 200 | `{"endpoints":["POST /v1/chat/completions",…],"message":"CLI Proxy API Server"}` | root metadata |

**Recommended monitoring probes (all HTTP 200 today, none require a secret):**

- open-webui → `http://127.0.0.1:3000/health`
- CPA → `http://127.0.0.1:8317/healthz`
- sub2api → `http://127.0.0.1:8080/health`

### CPA key handling (no secret disclosed)

The key was extracted *on the server* from `/opt/cliproxyapi/config.yaml` (top-level key `api-keys:` at line 12, containing exactly **1** list item) into the shell variable `CPA_KEY`, used only inside `curl -H "Authorization: Bearer $CPA_KEY"`, and `unset` immediately after. Only its **length (67 characters)** was reported. The key value is **REDACTED** and appears nowhere in this document or in any log. Other top-level keys observed in that file (names only): `host: "127.0.0.1"`, `port: 8317`, `trusted-proxies`, `tls`, `remote-management`, `auth-dir`, `api-keys`, `debug: false`, `pprof`, `discovery`, `oauth-model-alias`, `oauth-excluded-models`, `payload`, `proxy-url: ""`, `plugins`, `credential-concurrency`, `credential-in-flight`, `redis-usage-queue-retention-seconds`, `disable-cooling`, `request-retry`, `ws-auth`. Unauthenticated probes returned `401 {"error":"Missing API key"}` (`/v1/models`) and `401 {"error":"missing management key"}` (`/v0/management/config`), confirming auth is enforced.

---

## 8. Host resources

| Metric | Value | Source |
|---|---|---|
| **CPU count** | **4** vCPU (`QEMU Virtual CPU version 2.5+`) | `nproc`, `/proc/cpuinfo` |
| **Total memory** | **3915 MiB** (`MemTotal: 4009300 kB` ≈ 3.82 GiB) | `free -m`, `/proc/meminfo` |
| Memory used | 1542–1547 MiB | `free -m` |
| Memory free | 191–343 MiB | `free -m` |
| Memory available | 2367–2372 MiB | `free -m` |
| buff/cache | 2358–2516 MiB | `free -m` |
| Shared | 43 MiB | `free -m` |
| **Swap** | **0 MiB total, 0 used** (no swap configured) | `free -m` |
| **Disk `/`** | `/dev/vda1` — **49 G total, 15 G used, 34 G available, 30 % used** | `df -h /` |
| `/boot/efi` | `/dev/vda15` — 105 M total, 6.1 M used, 99 M avail, 6 % | `df -h` |
| `/dev/shm` | tmpfs 2.0 G, 0 used | `df -h` |
| `/run` | tmpfs 392 M, 1.6 M used, 1 % | `df -h` |
| `/var/lib/docker` | 6.5 G | `du -sh` |
| **Uptime** | **up 5 days, 22:12** (as of 12:25 UTC) | `uptime` |
| Load average | 0.14 / 0.11 / 0.04 (1/5/15 min) | `uptime`, `/proc/loadavg` |
| Logged-in users | 2 | `uptime` |
| Processes | 349 tasks (from `/proc/loadavg`) | `/proc/loadavg` |

Disk headroom: ~34 GB free of 49 GB (30 % used). Memory headroom: ~2.3 GB available of 3.9 GB, but note there is **no swap**, so memory pressure has no overflow buffer.

---

## 9. Firewall summary (read-only observation)

`ufw status verbose` — **Status: active**, default **deny (incoming)**, allow (outgoing), deny (routed).

| # | To | Action | From | Comment |
|---|---|---|---|---|
| 1 | OpenSSH-Custom (`28987/tcp`) | ALLOW IN | Anywhere | |
| 2 | `80/tcp` | ALLOW IN | Anywhere | HTTP ACME and redirects |
| 3 | `443/tcp` | ALLOW IN | Anywhere | HTTPS application ingress |
| 4 | `8000/tcp` | ALLOW IN | `172.17.0.0/16` | webui-to-open-terminal |
| 5 | **`3000/tcp`** | **ALLOW IN** | **Anywhere** | **open-webui** |
| 6 | OpenSSH-Custom (v6) | ALLOW IN | Anywhere (v6) | |
| 7 | `80/tcp` (v6) | ALLOW IN | Anywhere (v6) | |
| 8 | `443/tcp` (v6) | ALLOW IN | Anywhere (v6) | |
| 9 | **`3000/tcp` (v6)** | **ALLOW IN** | **Anywhere (v6)** | **open-webui** |

Backing `iptables`/`nftables`: `INPUT` policy `DROP`, `FORWARD` policy `DROP`, `OUTPUT` `ACCEPT`; UFW chains applied. `DOCKER-USER` is present but **empty** (no restrictive rules). Docker NAT rules: `3000` → `172.17.0.2:8080` (open-webui) and `127.0.0.1:8080` → `172.18.0.4:8080` (sub2api). Note `8317` and host `8080` have **no** UFW allow rule and no external NAT, hence unreachable from outside — consistent with the external timeout results in §3.

---

## 10. Explicitly NOT determined

- The value/content of `/opt/sub2api/.env` (not opened — only its existence and effective `BIND_HOST` behaviour were inferred from the observed `127.0.0.1:8080` binding).
- Contents of `/opt/cliproxyapi/auths/`, `/opt/sub2api/data`, `/opt/sub2api/postgres_data`, `/opt/sub2api/redis_data` (credential/state stores — out of scope and deliberately not read).
- Any secret value, API key, token, password, or private key (all REDACTED by policy; `privkey.pem` was never read).
- Whether application-level failures would be caught by an *external* uptime monitor — no external monitor was queried.
- Historical/trend data (this is a point-in-time snapshot at ~12:22–12:26 UTC 2026-09-30).
