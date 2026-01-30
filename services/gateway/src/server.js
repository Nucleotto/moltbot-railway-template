/**
 * Moltbot Gateway Service (S3-backed storage)
 * 
 * This service:
 * 1. Downloads state from S3 on startup
 * 2. Runs the Moltbot gateway process
 * 3. Periodically checks S3 for config changes
 */
import childProcess from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import express from "express";
import { initStorage, getStorage } from "./s3-storage.js";

const PORT = Number.parseInt(process.env.PORT ?? "8080", 10);

// Local state directory (ephemeral - synced from S3)
const STATE_DIR = process.env.MOLTBOT_STATE_DIR?.trim() || "/tmp/moltbot-state/.moltbot";
const WORKSPACE_DIR = process.env.MOLTBOT_WORKSPACE_DIR?.trim() || "/tmp/moltbot-state/workspace";

// S3 sync interval (check for config changes)
const S3_SYNC_INTERVAL_MS = Number.parseInt(process.env.S3_SYNC_INTERVAL_MS ?? "30000", 10);

// Built-from-source CLI entry
const MOLTBOT_ENTRY = process.env.MOLTBOT_ENTRY?.trim() || "/moltbot/dist/entry.js";
const MOLTBOT_NODE = process.env.MOLTBOT_NODE?.trim() || "node";

function clawArgs(args) {
  return [MOLTBOT_ENTRY, ...args];
}

function configPath() {
  return process.env.MOLTBOT_CONFIG_PATH?.trim() || path.join(STATE_DIR, "moltbot.json");
}

function isConfigured() {
  try {
    return fs.existsSync(configPath());
  } catch {
    return false;
  }
}

// Gateway token is stored in config - read from moltbot.json or generate
function resolveGatewayToken() {
  // First check env var
  const envTok = process.env.MOLTBOT_GATEWAY_TOKEN?.trim();
  if (envTok) return envTok;

  // Try to read from config file
  try {
    const config = JSON.parse(fs.readFileSync(configPath(), "utf8"));
    if (config.gateway?.auth?.token) {
      return config.gateway.auth.token;
    }
  } catch {
    // Config doesn't exist yet
  }

  // Fall back to token file (legacy)
  const tokenPath = path.join(STATE_DIR, "gateway.token");
  try {
    const existing = fs.readFileSync(tokenPath, "utf8").trim();
    if (existing) return existing;
  } catch {
    // ignore
  }

  // Generate new token
  const generated = crypto.randomBytes(32).toString("hex");
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(tokenPath, generated, { encoding: "utf8", mode: 0o600 });
  } catch {
    // best-effort
  }
  return generated;
}

let MOLTBOT_GATEWAY_TOKEN = null;
let gatewayProc = null;
let configLastModified = null;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function startGateway() {
  if (gatewayProc) return;
  if (!isConfigured()) {
    console.log("[gateway] not configured yet, waiting...");
    return;
  }

  // Resolve token now that config exists
  MOLTBOT_GATEWAY_TOKEN = resolveGatewayToken();
  process.env.MOLTBOT_GATEWAY_TOKEN = MOLTBOT_GATEWAY_TOKEN;

  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.mkdirSync(WORKSPACE_DIR, { recursive: true });

  const args = [
    "gateway",
    "run",
    "--bind",
    "0.0.0.0",
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

  // Track config modification time
  try {
    const stats = fs.statSync(configPath());
    configLastModified = stats.mtimeMs;
  } catch {
    // ignore
  }

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

async function restartGateway() {
  if (gatewayProc) {
    console.log("[gateway] restarting due to config change...");
    try {
      gatewayProc.kill("SIGTERM");
    } catch {
      // ignore
    }
    await sleep(1000);
    gatewayProc = null;
  }
  await startGateway();
}

// Check S3 for config updates and restart if changed
async function checkForConfigUpdates() {
  try {
    const storage = getStorage();
    const configKey = ".moltbot/moltbot.json";
    
    // Download latest config from S3
    const downloaded = await storage.downloadFile(storage.prefix + configKey);
    
    if (downloaded && isConfigured()) {
      const stats = fs.statSync(configPath());
      
      // If config changed and gateway is running, restart it
      if (configLastModified && stats.mtimeMs !== configLastModified) {
        console.log("[s3] Config changed in S3, restarting gateway...");
        configLastModified = stats.mtimeMs;
        await restartGateway();
      } else if (!gatewayProc) {
        // Config exists but gateway not running - start it
        await startGateway();
      }
    }
  } catch (err) {
    console.error("[s3] Error checking for config updates:", err.message);
  }
}

// Health check server
const healthApp = express();
healthApp.disable("x-powered-by");

healthApp.get("/health", (_req, res) => {
  res.json({
    ok: true,
    configured: isConfigured(),
    gatewayRunning: gatewayProc !== null,
    token: MOLTBOT_GATEWAY_TOKEN ? MOLTBOT_GATEWAY_TOKEN.slice(0, 8) + "..." : null,
  });
});

healthApp.get("/token", (req, res) => {
  // Internal endpoint for setup service to retrieve the token
  const authHeader = req.headers["x-internal-secret"];
  const expectedSecret = process.env.INTERNAL_SECRET?.trim();
  
  if (expectedSecret && authHeader !== expectedSecret) {
    return res.status(403).json({ error: "Forbidden" });
  }
  
  if (!MOLTBOT_GATEWAY_TOKEN) {
    return res.status(503).json({ error: "Token not yet resolved" });
  }
  
  res.json({ token: MOLTBOT_GATEWAY_TOKEN });
});

// Start health server on a different port
const HEALTH_PORT = Number.parseInt(process.env.HEALTH_PORT ?? "8081", 10);

// Main startup
async function main() {
  console.log("[gateway-service] starting...");
  
  // Initialize S3 storage - download all state
  try {
    await initStorage({
      localDir: "/tmp/moltbot-state",
    });
  } catch (err) {
    console.error("[gateway-service] S3 init failed:", err.message);
    console.log("[gateway-service] Continuing without S3 state (first run?)");
  }
  
  // Start health server
  healthApp.listen(HEALTH_PORT, () => {
    console.log(`[health] listening on port ${HEALTH_PORT}`);
  });
  
  console.log(`[gateway-service] configured: ${isConfigured()}`);
  
  if (isConfigured()) {
    await startGateway();
  } else {
    console.log("[gateway-service] waiting for configuration from S3...");
  }
  
  // Periodically check S3 for config updates
  setInterval(checkForConfigUpdates, S3_SYNC_INTERVAL_MS);
}

main().catch((err) => {
  console.error("[gateway-service] Fatal error:", err);
  process.exit(1);
});

process.on("SIGTERM", () => {
  try {
    if (gatewayProc) gatewayProc.kill("SIGTERM");
  } catch {
    // ignore
  }
  process.exit(0);
});
