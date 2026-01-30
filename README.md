# Moltbot Railway Template (S3-Backed Two-Service Architecture)

This repo packages **Moltbot** for Railway with a **two-service architecture** using **S3 Object Storage** for persistent state sharing.

## Architecture

```
┌──────────────────┐                    ┌───────────────────┐
│  Setup Service   │      proxy         │  Gateway Service  │
│    (public)      │───────────────────▶│    (internal)     │
│                  │                    │                   │
│  • /setup wizard │                    │  • Moltbot Gateway│
│  • Onboarding CLI│                    │  • Control UI     │
│  • Proxy to GW   │                    │  • Chat channels  │
└────────┬─────────┘                    └─────────┬─────────┘
         │                                        │
         │  upload config                         │  poll for config
         │  after setup                           │  every 30s
         │                                        │
         └──────────────┬─────────────────────────┘
                        │
                        ▼
               ┌────────────────┐
               │  S3 Object     │
               │  Storage       │
               │                │
               │  • moltbot.json│
               │  • workspace/* │
               │  • tokens      │
               └────────────────┘
```

## How It Works

1. **Setup Service** downloads state from S3 on startup
2. User completes `/setup` wizard → config written locally → uploaded to S3
3. **Gateway Service** polls S3 every 30 seconds for config changes
4. Gateway detects new config → starts Moltbot gateway process
5. All traffic proxied through Setup Service → Gateway Service

**No shared volumes needed** - S3 is the source of truth.

## Railway Deploy Instructions

### Quick Deploy with railway.json

1. Fork this repo
2. Create new Railway project from repo
3. Railway will auto-detect `railway.json` and create:
   - Gateway Service
   - Setup Service  
   - Object Storage (S3)
4. Set `SETUP_PASSWORD` on Setup Service
5. Enable public networking on Setup Service only
6. Deploy!

### Manual Setup

1. Create Railway project
2. Add **Object Storage** service (provides S3 bucket)
3. Add **Gateway Service**:
   - Source: This repo, root = `services/gateway`
   - Add S3 env vars (see below)
4. Add **Setup Service**:
   - Source: This repo, root = `services/setup`
   - Add S3 env vars + `GATEWAY_URL`
   - Enable public networking

## Environment Variables

### Both Services (S3 Config)

| Variable | Description |
|----------|-------------|
| `S3_BUCKET` | Bucket name from Object Storage |
| `S3_ENDPOINT` | S3 endpoint URL |
| `S3_ACCESS_KEY_ID` | Access key |
| `S3_SECRET_ACCESS_KEY` | Secret key |
| `S3_REGION` | Region (usually `auto`) |
| `S3_PREFIX` | Key prefix (default: `moltbot/`) |

### Setup Service Only

| Variable | Required | Description |
|----------|----------|-------------|
| `SETUP_PASSWORD` | Yes | Password to access `/setup` |
| `GATEWAY_URL` | Yes | Internal gateway URL (e.g., `http://gateway.railway.internal:8080`) |

### Gateway Service Only

| Variable | Default | Description |
|----------|---------|-------------|
| `S3_SYNC_INTERVAL_MS` | `30000` | How often to check S3 for config changes (ms) |
| `HEALTH_PORT` | `8081` | Port for health check endpoint |

## Usage

1. Visit `https://<setup-service>.up.railway.app/setup`
2. Enter setup password
3. Configure AI provider (API key)
4. Optionally add Telegram/Discord/Slack bot tokens
5. Click "Run setup"
6. Wait for Gateway to detect config (~30 seconds)
7. Access Moltbot at `/` or `/moltbot`

## Getting Bot Tokens

### Telegram
1. Message `@BotFather` on Telegram
2. Run `/newbot`, follow prompts
3. Copy the token (looks like `123456789:AA...`)

### Discord
1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. New Application → Bot tab → Add Bot
3. Copy Bot Token
4. **Enable MESSAGE CONTENT INTENT** under Privileged Gateway Intents
5. Invite bot via OAuth2 URL Generator (scopes: `bot`, `applications.commands`)

## Local Development

```bash
# You'll need to set S3 env vars or use local MinIO
docker-compose up --build
```

## File Structure

```
services/
├── gateway/           # Moltbot gateway runner
│   ├── Dockerfile
│   ├── package.json
│   ├── shared/        # S3 storage module
│   └── src/
│       └── server.js
│
├── setup/             # Setup wizard + proxy
│   ├── Dockerfile
│   ├── package.json
│   ├── shared/        # S3 storage module
│   └── src/
│       ├── server.js
│       └── setup-app.js
│
└── shared/            # Source of truth for shared code
    └── s3-storage.js

railway.json           # Railway service definitions
```

## Troubleshooting

**Gateway not starting?**
- Check S3 credentials are correct
- Verify config was uploaded: check Setup logs for `[s3] Config uploaded successfully`
- Gateway polls every 30s - wait or check logs for `[s3] Config changed in S3`

**Setup wizard errors?**
- Ensure `SETUP_PASSWORD` is set
- Check S3 bucket exists and is accessible

**Proxy errors after setup?**
- Verify `GATEWAY_URL` points to correct internal hostname
- Check Gateway health endpoint: `http://gateway.railway.internal:8081/health`
