# Moltbot Railway Template (Two-Service Architecture)

This repo packages **Moltbot** for Railway with a **two-service architecture** and a **/setup** web wizard so users can deploy and onboard **without running any commands**.

## What you get

- **Moltbot Gateway Service** - Runs the actual Moltbot gateway (scales independently)
- **Setup/Proxy Service** - Web wizard at `/setup` + proxies traffic to Gateway
- Persistent state via **Railway Volume** (shared between services)
- One-click **Export backup** (so users can migrate off Railway later)

## Architecture

```
┌─────────────────┐     ┌─────────────────────┐
│  Setup Service  │────▶│   Gateway Service   │
│   (port 8080)   │     │     (port 8080)     │
│                 │     │                     │
│  • /setup       │     │  • Moltbot Gateway  │
│  • Onboarding   │     │  • Control UI       │
│  • Proxy to GW  │     │  • WebSocket        │
└────────┬────────┘     └──────────┬──────────┘
         │                         │
         └─────────┬───────────────┘
                   │
           ┌───────▼───────┐
           │ Shared Volume │
           │   (/data)     │
           └───────────────┘
```

**Why two services?**
- **Reliability**: Gateway crashes don't take down setup/proxy
- **Scaling**: Gateway can scale independently for heavy workloads
- **Resource isolation**: Better memory/CPU management
- **Faster deploys**: Changes to setup don't rebuild gateway

## Railway Deploy Instructions

### Option A: Deploy as Multi-Service Template

In Railway Template Composer:

1. Create a new template from this GitHub repo
2. Add **two services** from the repo:
   - **Gateway Service**: Root path = `services/gateway`
   - **Setup Service**: Root path = `services/setup`
3. Add a **shared Volume** mounted at `/data` for both services
4. Set environment variables:

**Shared (both services):**
- `MOLTBOT_STATE_DIR=/data/.moltbot`
- `MOLTBOT_WORKSPACE_DIR=/data/workspace`
- `MOLTBOT_GATEWAY_TOKEN` — generate a secret, must be the same for both services

**Setup Service only:**
- `SETUP_PASSWORD` — user-provided password to access `/setup`
- `GATEWAY_URL=http://gateway.railway.internal:8080` (Railway private networking)

5. Enable **Public Networking** only for Setup Service
6. Deploy

### Option B: Deploy Services Manually

1. Create a new Railway project
2. Add Gateway Service:
   - New Service → GitHub Repo → Select this repo
   - Settings → Root Directory: `services/gateway`
   - Add volume at `/data`
3. Add Setup Service:
   - New Service → GitHub Repo → Select this repo
   - Settings → Root Directory: `services/setup`
   - Share the same volume at `/data`
4. Configure variables as above
5. Enable public networking on Setup Service

### After Deployment

1. Visit `https://<your-setup-service>.up.railway.app/setup`
2. Complete the setup wizard
3. Visit `https://<your-setup-service>.up.railway.app/` or `/moltbot`

## Getting chat tokens (so you don't have to scramble)

### Telegram bot token

1. Open Telegram and message **@BotFather**
2. Run `/newbot` and follow the prompts
3. BotFather will give you a token that looks like: `123456789:AA...`
4. Paste that token into `/setup`

### Discord bot token

1. Go to the Discord Developer Portal: https://discord.com/developers/applications
2. **New Application** → pick a name
3. Open the **Bot** tab → **Add Bot**
4. Copy the **Bot Token** and paste it into `/setup`
5. Invite the bot to your server (OAuth2 URL Generator → scopes: `bot`, `applications.commands`; then choose permissions)

## Local Development with Docker Compose

```bash
# Build and run both services
docker-compose up --build

# Open setup wizard at http://localhost:8080/setup (password: test)
```

## Single-Service Mode (Legacy)

The original single-service deployment is still available in the root `Dockerfile` and `src/` folder. 
However, the two-service architecture is recommended for production Railway deployments.

```bash
# Legacy single-service local test
docker build -t moltbot-railway-template .

docker run --rm -p 8080:8080 \
  -e PORT=8080 \
  -e SETUP_PASSWORD=test \
  -e MOLTBOT_STATE_DIR=/data/.moltbot \
  -e MOLTBOT_WORKSPACE_DIR=/data/workspace \
  -v $(pwd)/.tmpdata:/data \
  moltbot-railway-template
```

## Environment Variables Reference

| Variable | Service | Required | Description |
|----------|---------|----------|-------------|
| `SETUP_PASSWORD` | Setup | Yes | Password to access `/setup` wizard |
| `MOLTBOT_STATE_DIR` | Both | Recommended | Where Moltbot stores config (`/data/.moltbot`) |
| `MOLTBOT_WORKSPACE_DIR` | Both | Recommended | Workspace directory (`/data/workspace`) |
| `MOLTBOT_GATEWAY_TOKEN` | Both | Recommended | Auth token for gateway (generate once, use in both) |
| `GATEWAY_URL` | Setup | Yes | URL to gateway service (use Railway private networking) |
| `PORT` | Both | No | HTTP port (default: 8080) |
