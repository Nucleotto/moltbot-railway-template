/**
 * Moltbot Setup Service
 * 
 * This is a lightweight service that:
 * 1. Provides the /setup wizard for initial configuration
 * 2. Runs onboarding commands to configure Moltbot
 * 3. Proxies traffic to the separate Gateway service
 * 
 * Designed for Railway two-service deployment.
 */
import childProcess from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import express from "express";
import httpProxy from "http-proxy";
import * as tar from "tar";

// Railway commonly sets PORT=8080 for HTTP services.
const PORT = Number.parseInt(process.env.PORT ?? "8080", 10);
const STATE_DIR =
  process.env.MOLTBOT_STATE_DIR?.trim() ||
  path.join(os.homedir(), ".moltbot");
const WORKSPACE_DIR =
  process.env.MOLTBOT_WORKSPACE_DIR?.trim() ||
  path.join(STATE_DIR, "workspace");

// Protect /setup with a user-provided password.
const SETUP_PASSWORD = process.env.SETUP_PASSWORD?.trim();

// Gateway service URL (Railway private networking or public URL)
const GATEWAY_URL = process.env.GATEWAY_URL?.trim() || "http://gateway:8080";
const GATEWAY_INTERNAL_PORT = Number.parseInt(
  process.env.GATEWAY_INTERNAL_PORT ?? "8080",
  10,
);

// Gateway admin token - shared with gateway service via env or volume
function resolveGatewayToken() {
  const envTok = process.env.MOLTBOT_GATEWAY_TOKEN?.trim();
  if (envTok) return envTok;

  const tokenPath = path.join(STATE_DIR, "gateway.token");
  try {
    const existing = fs.readFileSync(tokenPath, "utf8").trim();
    if (existing) return existing;
  } catch {
    // ignore
  }

  const generated = crypto.randomBytes(32).toString("hex");
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(tokenPath, generated, { encoding: "utf8", mode: 0o600 });
  } catch {
    // best-effort
  }
  return generated;
}

const MOLTBOT_GATEWAY_TOKEN = resolveGatewayToken();
process.env.MOLTBOT_GATEWAY_TOKEN = MOLTBOT_GATEWAY_TOKEN;

// CLI for onboarding commands
const MOLTBOT_ENTRY =
  process.env.MOLTBOT_ENTRY?.trim() || "/moltbot/dist/entry.js";
const MOLTBOT_NODE = process.env.MOLTBOT_NODE?.trim() || "node";

function clawArgs(args) {
  return [MOLTBOT_ENTRY, ...args];
}

function configPath() {
  return (
    process.env.MOLTBOT_CONFIG_PATH?.trim() ||
    path.join(STATE_DIR, "moltbot.json")
  );
}

function isConfigured() {
  try {
    return fs.existsSync(configPath());
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForGatewayReady(opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const start = Date.now();
  const endpoints = ["/moltbot", "/", "/health"];
  
  while (Date.now() - start < timeoutMs) {
    for (const endpoint of endpoints) {
      try {
        const res = await fetch(`${GATEWAY_URL}${endpoint}`, {
          method: "GET",
          headers: { Authorization: `Bearer ${MOLTBOT_GATEWAY_TOKEN}` },
        });
        if (res) {
          console.log(`[gateway] ready at ${endpoint}`);
          return true;
        }
      } catch (err) {
        // not ready
      }
    }
    await sleep(250);
  }
  console.error(`[gateway] failed to become ready after ${timeoutMs}ms`);
  return false;
}

function requireSetupAuth(req, res, next) {
  if (!SETUP_PASSWORD) {
    return res
      .status(500)
      .type("text/plain")
      .send(
        "SETUP_PASSWORD is not set. Set it in Railway Variables before using /setup.",
      );
  }

  const header = req.headers.authorization || "";
  const [scheme, encoded] = header.split(" ");
  if (scheme !== "Basic" || !encoded) {
    res.set("WWW-Authenticate", 'Basic realm="Moltbot Setup"');
    return res.status(401).send("Auth required");
  }
  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  const idx = decoded.indexOf(":");
  const password = idx >= 0 ? decoded.slice(idx + 1) : "";
  if (password !== SETUP_PASSWORD) {
    res.set("WWW-Authenticate", 'Basic realm="Moltbot Setup"');
    return res.status(401).send("Invalid password");
  }
  return next();
}

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));

// Minimal health endpoint for Railway.
app.get("/setup/healthz", (_req, res) => res.json({ ok: true }));

app.get("/setup/app.js", requireSetupAuth, (_req, res) => {
  res.type("application/javascript");
  res.send(
    fs.readFileSync(path.join(process.cwd(), "src", "setup-app.js"), "utf8"),
  );
});

app.get("/setup", requireSetupAuth, (_req, res) => {
  res.type("html").send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Moltbot Setup</title>
  <style>
    body { font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial; margin: 2rem; max-width: 900px; }
    .card { border: 1px solid #ddd; border-radius: 12px; padding: 1.25rem; margin: 1rem 0; }
    label { display:block; margin-top: 0.75rem; font-weight: 600; }
    input, select { width: 100%; padding: 0.6rem; margin-top: 0.25rem; }
    button { padding: 0.8rem 1.2rem; border-radius: 10px; border: 0; background: #111; color: #fff; font-weight: 700; cursor: pointer; }
    code { background: #f6f6f6; padding: 0.1rem 0.3rem; border-radius: 6px; }
    .muted { color: #555; }
    .info-box { background: #f0f9ff; border: 1px solid #0ea5e9; border-radius: 8px; padding: 1rem; margin: 1rem 0; }
  </style>
</head>
<body>
  <h1>Moltbot Setup</h1>
  <p class="muted">This wizard configures Moltbot by running the same onboarding command it uses in the terminal, but from the browser.</p>

  <div class="info-box">
    <strong>Two-Service Architecture:</strong> Setup service proxies to Gateway service at <code>${GATEWAY_URL}</code>
  </div>

  <div class="card">
    <h2>Status</h2>
    <div id="status">Loading...</div>
    <div style="margin-top: 0.75rem">
      <a href="/moltbot" target="_blank">Open Moltbot UI</a>
      &nbsp;|&nbsp;
      <a href="/setup/export" target="_blank">Download backup (.tar.gz)</a>
    </div>
  </div>

  <div class="card">
    <h2>1) Model/auth provider</h2>
    <p class="muted">Matches the groups shown in the terminal onboarding.</p>
    <label>Provider group</label>
    <select id="authGroup"></select>

    <label>Auth method</label>
    <select id="authChoice"></select>

    <label>Key / Token (if required)</label>
    <input id="authSecret" type="password" placeholder="Paste API key / token if applicable" />

    <label>Wizard flow</label>
    <select id="flow">
      <option value="quickstart">quickstart</option>
      <option value="advanced">advanced</option>
      <option value="manual">manual</option>
    </select>
  </div>

  <div class="card">
    <h2>2) Optional: Channels</h2>
    <p class="muted">You can also add channels later inside Moltbot, but this helps you get messaging working immediately.</p>

    <label>Telegram bot token (optional)</label>
    <input id="telegramToken" type="password" placeholder="123456:ABC..." />
    <div class="muted" style="margin-top: 0.25rem">
      Get it from BotFather: open Telegram, message <code>@BotFather</code>, run <code>/newbot</code>, then copy the token.
    </div>

    <label>Discord bot token (optional)</label>
    <input id="discordToken" type="password" placeholder="Bot token" />
    <div class="muted" style="margin-top: 0.25rem">
      Get it from the Discord Developer Portal: create an application, add a Bot, then copy the Bot Token.<br/>
      <strong>Important:</strong> Enable <strong>MESSAGE CONTENT INTENT</strong> in Bot → Privileged Gateway Intents, or the bot will crash on startup.
    </div>

    <label>Slack bot token (optional)</label>
    <input id="slackBotToken" type="password" placeholder="xoxb-..." />

    <label>Slack app token (optional)</label>
    <input id="slackAppToken" type="password" placeholder="xapp-..." />
  </div>

  <div class="card">
    <h2>3) Run onboarding</h2>
    <button id="run">Run setup</button>
    <button id="pairingApprove" style="background:#1f2937; margin-left:0.5rem">Approve pairing</button>
    <button id="reset" style="background:#444; margin-left:0.5rem">Reset setup</button>
    <pre id="log" style="white-space:pre-wrap"></pre>
    <p class="muted">Reset deletes the Moltbot config file so you can rerun onboarding. Pairing approval lets you grant DM access when dmPolicy=pairing.</p>
  </div>

  <script src="/setup/app.js"></script>
</body>
</html>`);
});

app.get("/setup/api/status", requireSetupAuth, async (_req, res) => {
  const version = await runCmd(MOLTBOT_NODE, clawArgs(["--version"]));
  const channelsHelp = await runCmd(
    MOLTBOT_NODE,
    clawArgs(["channels", "add", "--help"]),
  );

  const authGroups = [
    {
      value: "openai",
      label: "OpenAI",
      hint: "Codex OAuth + API key",
      options: [
        { value: "codex-cli", label: "OpenAI Codex OAuth (Codex CLI)" },
        { value: "openai-codex", label: "OpenAI Codex (ChatGPT OAuth)" },
        { value: "openai-api-key", label: "OpenAI API key" },
      ],
    },
    {
      value: "anthropic",
      label: "Anthropic",
      hint: "Claude Code CLI + API key",
      options: [
        { value: "claude-cli", label: "Anthropic token (Claude Code CLI)" },
        { value: "token", label: "Anthropic token (paste setup-token)" },
        { value: "apiKey", label: "Anthropic API key" },
      ],
    },
    {
      value: "google",
      label: "Google",
      hint: "Gemini API key + OAuth",
      options: [
        { value: "gemini-api-key", label: "Google Gemini API key" },
        { value: "google-antigravity", label: "Google Antigravity OAuth" },
        { value: "google-gemini-cli", label: "Google Gemini CLI OAuth" },
      ],
    },
    {
      value: "openrouter",
      label: "OpenRouter",
      hint: "API key",
      options: [{ value: "openrouter-api-key", label: "OpenRouter API key" }],
    },
    {
      value: "ai-gateway",
      label: "Vercel AI Gateway",
      hint: "API key",
      options: [
        { value: "ai-gateway-api-key", label: "Vercel AI Gateway API key" },
      ],
    },
    {
      value: "moonshot",
      label: "Moonshot AI",
      hint: "Kimi K2 + Kimi Code",
      options: [
        { value: "moonshot-api-key", label: "Moonshot AI API key" },
        { value: "kimi-code-api-key", label: "Kimi Code API key" },
      ],
    },
    {
      value: "zai",
      label: "Z.AI (GLM 4.7)",
      hint: "API key",
      options: [{ value: "zai-api-key", label: "Z.AI (GLM 4.7) API key" }],
    },
    {
      value: "minimax",
      label: "MiniMax",
      hint: "M2.1 (recommended)",
      options: [
        { value: "minimax-api", label: "MiniMax M2.1" },
        { value: "minimax-api-lightning", label: "MiniMax M2.1 Lightning" },
      ],
    },
    {
      value: "qwen",
      label: "Qwen",
      hint: "OAuth",
      options: [{ value: "qwen-portal", label: "Qwen OAuth" }],
    },
    {
      value: "copilot",
      label: "Copilot",
      hint: "GitHub + local proxy",
      options: [
        {
          value: "github-copilot",
          label: "GitHub Copilot (GitHub device login)",
        },
        { value: "copilot-proxy", label: "Copilot Proxy (local)" },
      ],
    },
    {
      value: "synthetic",
      label: "Synthetic",
      hint: "Anthropic-compatible (multi-model)",
      options: [{ value: "synthetic-api-key", label: "Synthetic API key" }],
    },
    {
      value: "opencode-zen",
      label: "OpenCode Zen",
      hint: "API key",
      options: [
        { value: "opencode-zen", label: "OpenCode Zen (multi-model proxy)" },
      ],
    },
  ];

  // Check gateway connectivity
  let gatewayStatus = "unknown";
  try {
    const gwRes = await fetch(`${GATEWAY_URL}/health`, { method: "GET" });
    gatewayStatus = gwRes.ok ? "connected" : "error";
  } catch {
    gatewayStatus = "unreachable";
  }

  res.json({
    configured: isConfigured(),
    gatewayUrl: GATEWAY_URL,
    gatewayStatus,
    moltbotVersion: version.output.trim(),
    channelsAddHelp: channelsHelp.output,
    authGroups,
  });
});

function buildOnboardArgs(payload) {
  const args = [
    "onboard",
    "--non-interactive",
    "--accept-risk",
    "--json",
    "--no-install-daemon",
    "--skip-health",
    "--workspace",
    WORKSPACE_DIR,
    // Gateway runs externally, configure it to bind to all interfaces
    "--gateway-bind",
    "0.0.0.0",
    "--gateway-port",
    String(GATEWAY_INTERNAL_PORT),
    "--gateway-auth",
    "token",
    "--gateway-token",
    MOLTBOT_GATEWAY_TOKEN,
    "--flow",
    payload.flow || "quickstart",
  ];

  if (payload.authChoice) {
    args.push("--auth-choice", payload.authChoice);

    const secret = (payload.authSecret || "").trim();
    const map = {
      "openai-api-key": "--openai-api-key",
      apiKey: "--anthropic-api-key",
      "openrouter-api-key": "--openrouter-api-key",
      "ai-gateway-api-key": "--ai-gateway-api-key",
      "moonshot-api-key": "--moonshot-api-key",
      "kimi-code-api-key": "--kimi-code-api-key",
      "gemini-api-key": "--gemini-api-key",
      "zai-api-key": "--zai-api-key",
      "minimax-api": "--minimax-api-key",
      "minimax-api-lightning": "--minimax-api-key",
      "synthetic-api-key": "--synthetic-api-key",
      "opencode-zen": "--opencode-zen-api-key",
    };
    const flag = map[payload.authChoice];
    if (flag && secret) {
      args.push(flag, secret);
    }

    if (payload.authChoice === "token" && secret) {
      args.push("--token-provider", "anthropic", "--token", secret);
    }
  }

  return args;
}

function runCmd(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const proc = childProcess.spawn(cmd, args, {
      ...opts,
      env: {
        ...process.env,
        MOLTBOT_STATE_DIR: STATE_DIR,
        MOLTBOT_WORKSPACE_DIR: WORKSPACE_DIR,
      },
    });

    let out = "";
    proc.stdout?.on("data", (d) => (out += d.toString("utf8")));
    proc.stderr?.on("data", (d) => (out += d.toString("utf8")));

    proc.on("error", (err) => {
      out += `\n[spawn error] ${String(err)}\n`;
      resolve({ code: 127, output: out });
    });

    proc.on("close", (code) => resolve({ code: code ?? 0, output: out }));
  });
}

app.post("/setup/api/run", requireSetupAuth, async (req, res) => {
  try {
    if (isConfigured()) {
      return res.json({
        ok: true,
        output:
          "Already configured.\nUse Reset setup if you want to rerun onboarding.\nGateway service should auto-detect the config.\n",
      });
    }

    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.mkdirSync(WORKSPACE_DIR, { recursive: true });

    const payload = req.body || {};
    const onboardArgs = buildOnboardArgs(payload);
    const onboard = await runCmd(MOLTBOT_NODE, clawArgs(onboardArgs));

    let extra = "";

    const ok = onboard.code === 0 && isConfigured();

    if (ok) {
      // Configure gateway settings in config
      await runCmd(MOLTBOT_NODE, clawArgs(["config", "set", "gateway.mode", "local"]));
      await runCmd(
        MOLTBOT_NODE,
        clawArgs(["config", "set", "gateway.auth.mode", "token"]),
      );
      await runCmd(
        MOLTBOT_NODE,
        clawArgs([
          "config",
          "set",
          "gateway.auth.token",
          MOLTBOT_GATEWAY_TOKEN,
        ]),
      );
      await runCmd(
        MOLTBOT_NODE,
        clawArgs(["config", "set", "gateway.bind", "0.0.0.0"]),
      );
      await runCmd(
        MOLTBOT_NODE,
        clawArgs([
          "config",
          "set",
          "gateway.port",
          String(GATEWAY_INTERNAL_PORT),
        ]),
      );
      await runCmd(
        MOLTBOT_NODE,
        clawArgs(["config", "set", "gateway.controlUi.allowInsecureAuth", "true"]),
      );

      const channelsHelp = await runCmd(
        MOLTBOT_NODE,
        clawArgs(["channels", "add", "--help"]),
      );
      const helpText = channelsHelp.output || "";

      const supports = (name) => helpText.includes(name);

      if (payload.telegramToken?.trim()) {
        if (!supports("telegram")) {
          extra +=
            "\n[telegram] skipped (this moltbot build does not list telegram in `channels add --help`)\n";
        } else {
          const token = payload.telegramToken.trim();
          const cfgObj = {
            enabled: true,
            dmPolicy: "pairing",
            botToken: token,
            groupPolicy: "allowlist",
            streamMode: "partial",
          };
          const set = await runCmd(
            MOLTBOT_NODE,
            clawArgs([
              "config",
              "set",
              "--json",
              "channels.telegram",
              JSON.stringify(cfgObj),
            ]),
          );
          extra += `\n[telegram config] exit=${set.code}\n${set.output || "(no output)"}`;
        }
      }

      if (payload.discordToken?.trim()) {
        if (!supports("discord")) {
          extra +=
            "\n[discord] skipped (this moltbot build does not list discord in `channels add --help`)\n";
        } else {
          const token = payload.discordToken.trim();
          const cfgObj = {
            enabled: true,
            token,
            groupPolicy: "allowlist",
            dm: {
              policy: "pairing",
            },
          };
          const set = await runCmd(
            MOLTBOT_NODE,
            clawArgs([
              "config",
              "set",
              "--json",
              "channels.discord",
              JSON.stringify(cfgObj),
            ]),
          );
          extra += `\n[discord config] exit=${set.code}\n${set.output || "(no output)"}`;
        }
      }

      if (payload.slackBotToken?.trim() || payload.slackAppToken?.trim()) {
        if (!supports("slack")) {
          extra +=
            "\n[slack] skipped (this moltbot build does not list slack in `channels add --help`)\n";
        } else {
          const cfgObj = {
            enabled: true,
            botToken: payload.slackBotToken?.trim() || undefined,
            appToken: payload.slackAppToken?.trim() || undefined,
          };
          const set = await runCmd(
            MOLTBOT_NODE,
            clawArgs([
              "config",
              "set",
              "--json",
              "channels.slack",
              JSON.stringify(cfgObj),
            ]),
          );
          extra += `\n[slack config] exit=${set.code}\n${set.output || "(no output)"}`;
        }
      }

      extra += "\n\nGateway service should auto-detect the new config and start.\n";
      extra += `Waiting for gateway at ${GATEWAY_URL}...\n`;
      
      // Give the gateway service time to detect config and start
      await sleep(3000);
      const ready = await waitForGatewayReady({ timeoutMs: 30_000 });
      extra += ready ? "Gateway is ready!\n" : "Gateway not responding yet (may still be starting).\n";
    }

    return res.status(ok ? 200 : 500).json({
      ok,
      output: `${onboard.output}${extra}`,
    });
  } catch (err) {
    console.error("[/setup/api/run] error:", err);
    return res
      .status(500)
      .json({ ok: false, output: `Internal error: ${String(err)}` });
  }
});

app.get("/setup/api/debug", requireSetupAuth, async (_req, res) => {
  const v = await runCmd(MOLTBOT_NODE, clawArgs(["--version"]));
  const help = await runCmd(
    MOLTBOT_NODE,
    clawArgs(["channels", "add", "--help"]),
  );
  res.json({
    wrapper: {
      node: process.version,
      port: PORT,
      stateDir: STATE_DIR,
      workspaceDir: WORKSPACE_DIR,
      configPath: configPath(),
      gatewayUrl: GATEWAY_URL,
      gatewayTokenFromEnv: Boolean(process.env.MOLTBOT_GATEWAY_TOKEN?.trim()),
      gatewayTokenPersisted: fs.existsSync(
        path.join(STATE_DIR, "gateway.token"),
      ),
      railwayCommit: process.env.RAILWAY_GIT_COMMIT_SHA || null,
    },
    moltbot: {
      entry: MOLTBOT_ENTRY,
      node: MOLTBOT_NODE,
      version: v.output.trim(),
      channelsAddHelpIncludesTelegram: help.output.includes("telegram"),
    },
  });
});

app.post("/setup/api/pairing/approve", requireSetupAuth, async (req, res) => {
  const { channel, code } = req.body || {};
  if (!channel || !code) {
    return res
      .status(400)
      .json({ ok: false, error: "Missing channel or code" });
  }
  const r = await runCmd(
    MOLTBOT_NODE,
    clawArgs(["pairing", "approve", String(channel), String(code)]),
  );
  return res
    .status(r.code === 0 ? 200 : 500)
    .json({ ok: r.code === 0, output: r.output });
});

app.post("/setup/api/reset", requireSetupAuth, async (_req, res) => {
  try {
    fs.rmSync(configPath(), { force: true });
    res
      .type("text/plain")
      .send("OK - deleted config file. You can rerun setup now.\nNote: Gateway service will stop until reconfigured.");
  } catch (err) {
    res.status(500).type("text/plain").send(String(err));
  }
});

app.get("/setup/export", requireSetupAuth, async (_req, res) => {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.mkdirSync(WORKSPACE_DIR, { recursive: true });

  res.setHeader("content-type", "application/gzip");
  res.setHeader(
    "content-disposition",
    `attachment; filename="moltbot-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.tar.gz"`,
  );

  const stateAbs = path.resolve(STATE_DIR);
  const workspaceAbs = path.resolve(WORKSPACE_DIR);

  const dataRoot = "/data";
  const underData = (p) => p === dataRoot || p.startsWith(dataRoot + path.sep);

  let cwd = "/";
  let paths = [stateAbs, workspaceAbs].map((p) => p.replace(/^\//, ""));

  if (underData(stateAbs) && underData(workspaceAbs)) {
    cwd = dataRoot;
    paths = [
      path.relative(dataRoot, stateAbs) || ".",
      path.relative(dataRoot, workspaceAbs) || ".",
    ];
  }

  const stream = tar.c(
    {
      gzip: true,
      portable: true,
      noMtime: true,
      cwd,
      onwarn: () => {},
    },
    paths,
  );

  stream.on("error", (err) => {
    console.error("[export]", err);
    if (!res.headersSent) res.status(500);
    res.end(String(err));
  });

  stream.pipe(res);
});

// Proxy to gateway service
const proxy = httpProxy.createProxyServer({
  target: GATEWAY_URL,
  ws: true,
  xfwd: true,
});

proxy.on("error", (err, _req, _res) => {
  console.error("[proxy]", err);
});

proxy.on("proxyReq", (proxyReq, req, res) => {
  proxyReq.setHeader("Authorization", `Bearer ${MOLTBOT_GATEWAY_TOKEN}`);
});

proxy.on("proxyReqWs", (proxyReq, req, socket, options, head) => {
  proxyReq.setHeader("Authorization", `Bearer ${MOLTBOT_GATEWAY_TOKEN}`);
});

app.use(async (req, res) => {
  if (!isConfigured() && !req.path.startsWith("/setup")) {
    return res.redirect("/setup");
  }

  return proxy.web(req, res, { target: GATEWAY_URL });
});

const server = app.listen(PORT, () => {
  console.log(`[setup-service] listening on port ${PORT}`);
  console.log(`[setup-service] setup wizard: http://localhost:${PORT}/setup`);
  console.log(`[setup-service] configured: ${isConfigured()}`);
  console.log(`[setup-service] gateway URL: ${GATEWAY_URL}`);
});

server.on("upgrade", async (req, socket, head) => {
  if (!isConfigured()) {
    socket.destroy();
    return;
  }
  proxy.ws(req, socket, head, { target: GATEWAY_URL });
});

process.on("SIGTERM", () => {
  process.exit(0);
});
