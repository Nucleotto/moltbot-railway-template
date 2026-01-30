# Moltbot Railway Template

Deploy **Moltbot** on Railway with a web-based setup wizard. Two deployment options:

## Deployment Options

### Option 1: Single Service (Recommended)

Simplest setup - one container runs both setup wizard and gateway.

```
┌─────────────────────────────────────┐
│         Single Service              │
│                                     │
│  • /setup  → Onboarding wizard      │
│  • /*      → Moltbot Gateway        │
│                                     │
│  Uses Railway volume for storage    │
└─────────────────────────────────────┘
```

**Deploy:**
1. Fork this repo
2. Create Railway project → "Deploy from GitHub repo"
3. Add a **Volume** → mount at `/data`
4. Set environment variable: `SETUP_PASSWORD=<your-password>`
5. Enable public networking
6. Deploy!

### Option 2: Two Services with S3

For advanced setups needing separate scaling or redundancy.

```
┌──────────────────┐         ┌───────────────────┐
│  Setup Service   │  proxy  │  Gateway Service  │
│    (public)      │────────▶│    (internal)     │
└────────┬─────────┘         └─────────┬─────────┘
         │                             │
         └─────────┬───────────────────┘
                   ▼
          ┌────────────────┐
          │  S3 Storage    │
          └────────────────┘
```

**Deploy:**
1. Fork this repo
2. Create Railway project
3. Add **Object Storage** service (name it `molbot-data`)
4. Add **Gateway Service**: root = `services/gateway`
5. Add **Setup Service**: root = `services/setup`
6. Set env vars on both services (see below)
7. Enable public networking on Setup Service only

## Environment Variables

### Single Service

| Variable | Required | Description |
|----------|----------|-------------|
| `SETUP_PASSWORD` | **Yes** | Password to access `/setup` wizard |
| `MOLTBOT_STATE_DIR` | No | Config storage (default: `/data/.moltbot`) |
| `MOLTBOT_WORKSPACE_DIR` | No | Workspace (default: `/data/workspace`) |

### Two Services (S3 Mode)

**Both services:**

| Variable | Description |
|----------|-------------|
| `RAILWAY_S3_BUCKET` | `${{molbot-data.BUCKET}}` |
| `RAILWAY_S3_ENDPOINT` | `${{molbot-data.ENDPOINT}}` |
| `RAILWAY_S3_ACCESS_KEY_ID` | `${{molbot-data.ACCESS_KEY_ID}}` |
| `RAILWAY_S3_SECRET_ACCESS_KEY` | `${{molbot-data.SECRET_ACCESS_KEY}}` |
| `RAILWAY_S3_REGION` | `${{molbot-data.REGION}}` |

**Setup service only:**

| Variable | Required | Description |
|----------|----------|-------------|
| `SETUP_PASSWORD` | **Yes** | Password to access `/setup` |
| `GATEWAY_URL` | Yes | `http://gateway.railway.internal:8080` |

## Usage

1. Visit `https://<your-app>.up.railway.app/setup`
2. Enter setup password
3. Select AI provider and enter API key
4. Optionally add Telegram/Discord/Slack bot tokens
5. Click "Run setup"
6. Access Moltbot at `/` or `/moltbot`

## Getting Bot Tokens

### Telegram
1. Message `@BotFather` on Telegram
2. Run `/newbot`, follow prompts
3. Copy the token

### Discord
1. [Discord Developer Portal](https://discord.com/developers/applications) → New Application
2. Bot tab → Add Bot → Copy Token
3. **Enable MESSAGE CONTENT INTENT**
4. OAuth2 → URL Generator (scopes: `bot`, `applications.commands`)

## Local Development

```bash
# Single service mode
docker-compose up --build

# Or run directly
npm install
npm start
```

## Troubleshooting

**Setup wizard won't load?**
- Ensure `SETUP_PASSWORD` is set

**Gateway not starting after setup?**
- Single service: Check volume is mounted at `/data`
- Two services: Check S3 credentials, wait 30s for gateway to poll

**"Application failed to respond" error?**
- Gateway may still be starting - wait a few seconds
- Check logs for startup errors
