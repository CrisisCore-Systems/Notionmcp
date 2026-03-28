# Remote Private Host Deployment

This repo is designed for one long-lived Node host with writable local state.
If you want the supported `remote-private-host` posture, use a single VPS or VM rather than a stateless platform.

Recommended baseline:

- Ubuntu 24.04 LTS VPS
- 2 vCPU / 4 GB RAM minimum
- One persistent volume or local disk you control
- One HTTPS hostname such as `https://notionmcp.example.com`
- Caddy or nginx as the reverse proxy
- `systemd` to keep the Node process running

## Why this host shape

`remote-private-host` assumes all of the following are true:

- one instance is handling the durable jobs
- the process can stay alive across long research runs
- `.notionmcp-data/` is writable and persists across restarts
- the browser UI talks to exactly one allowed origin

That is why Vercel is a weak fit here and a VPS is the simplest supported shape.

## Required environment

Set these for remote private mode:

```env
NOTIONMCP_DEPLOYMENT_MODE=remote-private-host
APP_ALLOWED_ORIGIN=https://notionmcp.example.com
APP_ACCESS_TOKEN=replace-with-a-long-random-shared-secret
PERSISTED_STATE_ENCRYPTION_KEY=replace-with-a-stable-32-byte-random-secret
```

You still also need the normal app variables such as:

```env
GEMINI_API_KEY=...
NOTION_TOKEN=...
NOTION_PARENT_PAGE_ID=...
NOTION_CLIENT_ID=...
NOTION_CLIENT_SECRET=...
NOTION_OAUTH_REDIRECT_URI=https://notionmcp.example.com/api/notion/callback
```

Guidance:

- `APP_ALLOWED_ORIGIN` must be the exact browser origin that loads the UI
- `APP_ACCESS_TOKEN` must match what you enter in the operator UI for remote access
- `PERSISTED_STATE_ENCRYPTION_KEY` must stay stable or existing encrypted state becomes unreadable
- leave `NOTIONMCP_RUN_JOBS_INLINE` unset
- leave `NOTIONMCP_HOST_DURABILITY` unset on a real VPS host

## Server setup

Install the system packages:

```bash
sudo apt update
sudo apt install -y curl git build-essential
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node --version
npm --version
```

Create the app user and directories:

```bash
sudo useradd --system --create-home --shell /bin/bash notionmcp
sudo mkdir -p /srv/notionmcp
sudo chown -R notionmcp:notionmcp /srv/notionmcp
```

Clone and install:

```bash
sudo -u notionmcp -H bash -lc '
  cd /srv/notionmcp
  git clone https://github.com/CrisisCore-Systems/Notionmcp.git app
  cd app
  npm install
  npm run build
'
```

## Production environment file

Create `/srv/notionmcp/app/.env.local` with your production values.

Recommended persisted-state paths:

```env
JOB_STATE_DIR=/srv/notionmcp/data/jobs
WRITE_AUDIT_DIR=/srv/notionmcp/data/write-audits
NOTION_CONNECTION_DIR=/srv/notionmcp/data/notion-connections
NOTION_QUEUE_BINDING_DIR=/srv/notionmcp/data/notion-queue-bindings
REMOTE_RATE_LIMIT_DIR=/srv/notionmcp/data/request-rate-limits
OPERATOR_METRICS_PATH=/srv/notionmcp/data/operator-metrics.json
```

Then create the directories:

```bash
sudo mkdir -p /srv/notionmcp/data/jobs
sudo mkdir -p /srv/notionmcp/data/write-audits
sudo mkdir -p /srv/notionmcp/data/notion-connections
sudo mkdir -p /srv/notionmcp/data/notion-queue-bindings
sudo mkdir -p /srv/notionmcp/data/request-rate-limits
sudo chown -R notionmcp:notionmcp /srv/notionmcp/data
```

## systemd service

Create `/etc/systemd/system/notionmcp.service`:

```ini
[Unit]
Description=Notion MCP Backlog Desk
After=network.target

[Service]
Type=simple
User=notionmcp
Group=notionmcp
WorkingDirectory=/srv/notionmcp/app
Environment=NODE_ENV=production
ExecStart=/usr/bin/npm run start -- --hostname 127.0.0.1 --port 3000
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Start it:

```bash
sudo systemctl daemon-reload
sudo systemctl enable notionmcp
sudo systemctl start notionmcp
sudo systemctl status notionmcp
```

## Caddy reverse proxy

Create `/etc/caddy/Caddyfile`:

```caddy
notionmcp.example.com {
  encode gzip zstd

  reverse_proxy 127.0.0.1:3000
}
```

Reload Caddy:

```bash
sudo systemctl reload caddy
```

## Update flow

Deploy updates with:

```bash
sudo -u notionmcp -H bash -lc '
  cd /srv/notionmcp/app
  git fetch origin
  git checkout main
  git pull --ff-only origin main
  npm install
  npm run build
'
sudo systemctl restart notionmcp
```

## Validation checklist

After cutover, verify all of these:

1. `/api/status` loads over your HTTPS hostname.
2. The landing page no longer depends on the Vercel alias.
3. `GET /api/notion/connect` redirects to Notion OAuth using your VPS hostname callback.
4. Research jobs survive a browser refresh.
5. New files appear under `/srv/notionmcp/data/` after runs and writes.

## Practical recommendation

If you want the least-friction supported setup, use:

- one small Ubuntu VPS
- one hostname
- one Node process
- one persisted local data directory

That is the closest match to the runtime assumptions already baked into this repo.
