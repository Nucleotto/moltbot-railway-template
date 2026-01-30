/**
 * Moltbot Gateway Service
 * 
 * This service runs the actual Moltbot gateway process and exposes it
 * on the configured port. It's designed to be deployed as a separate
 * Railway service from the setup/proxy service.
 */
import childProcess from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import express from "express";

const PORT = Number.parseInt(process.env.PORT ?? "8080", 10);
const STATE_DIR =
  process.env.MOLTBOT_STATE_DIR?.trim() ||
  path.join(os.homedir(), ".moltbot");
const WORKSPACE_DIR =
  process.env.MOLTBOT_WORKSPACE_DIR?.trim() ||
  path.join(STATE_DIR, "workspace");

// Gateway admin token - must match what the setup service uses
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

// Built-from-source CLI entry
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

let gatewayProc = null;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function startGateway() {
  if (gatewayProc) return;
  if (!isConfigured()) {
    console.log("[gateway] not configured yet, waiting...");
    return;
  }

  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.mkdirSync(WORKSPACE_DIR, { recursive: true });

  const args = [
    "gateway",
    "run",
    "--bind",
    "0.0.0.0",  // Bind to all interfaces for Railway private networking
    "--port",
    String(PORT),
    "--auth",
    "token",
    "--token",
    MOLTBOT_GATEWAY_TOKEN,
  ];

  console.log(`[gateway] starting with command: ${MOLTBOT_NODE} ${clawArgs(args).join(" ")}`);
  console.log(`[gateway] STATE_DIR: ${STATE_DIR}`);
  console.log(`[gateway] WORKSPACE_DIR: ${WORKSPACE_DIR}`);
  console.log(`[gateway] config path: ${configPath()}`);

  gatewayProc = childProcess.spawn(MOLTBOT_NODE, clawArgs(args), {
    stdio: "inherit",
    env: {
      ...process.env,
      MOLTBOT_STATE_DIR: STATE_DIR,
      MOLTBOT_WORKSPACE_DIR: WORKSPACE_DIR,
    },
  });

  gatewayProc.on("error", (err) => {
    console.error(`[gateway] spawn error: ${String(err)}`);
    gatewayProc = null;
  });

  gatewayProc.on("exit", (code, signal) => {
    console.error(`[gateway] exited code=${code} signal=${signal}`);
    gatewayProc = null;
    // Auto-restart after brief delay
    setTimeout(() => {
      if (!gatewayProc && isConfigured()) {
        console.log("[gateway] attempting restart...");
        startGateway();
      }
    }, 2000);
  });
}

// Health check server (runs alongside gateway)
const healthApp = express();
healthApp.disable("x-powered-by");

healthApp.get("/health", (_req, res) => {
  res.json({
    ok: true,
    configured: isConfigured(),
    gatewayRunning: gatewayProc !== null,
    token: MOLTBOT_GATEWAY_TOKEN.slice(0, 8) + "...",
  });
});

healthApp.get("/token", (req, res) => {
  // Internal endpoint for setup service to retrieve the token
  // Should only be accessible via Railway private networking
  const authHeader = req.headers["x-internal-secret"];
  const expectedSecret = process.env.INTERNAL_SECRET?.trim();
  
  if (expectedSecret && authHeader !== expectedSecret) {
    return res.status(403).json({ error: "Forbidden" });
  }
  
  res.json({ token: MOLTBOT_GATEWAY_TOKEN });
});

// Start health server on a different port
const HEALTH_PORT = Number.parseInt(process.env.HEALTH_PORT ?? "8081", 10);
healthApp.listen(HEALTH_PORT, () => {
  console.log(`[health] listening on port ${HEALTH_PORT}`);
});

// Main startup
console.log(`[gateway-service] starting...`);
console.log(`[gateway-service] configured: ${isConfigured()}`);

if (isConfigured()) {
  startGateway();
} else {
  console.log("[gateway-service] waiting for configuration...");
  // Poll for config file
  const checkInterval = setInterval(() => {
    if (isConfigured()) {
      console.log("[gateway-service] configuration detected, starting gateway...");
      clearInterval(checkInterval);
      startGateway();
    }
  }, 5000);
}

process.on("SIGTERM", () => {
  try {
    if (gatewayProc) gatewayProc.kill("SIGTERM");
  } catch {
    // ignore
  }
  process.exit(0);
});
