#!/usr/bin/env node
/**
 * Node.js bridge for TLS-PSK WebSocket connections.
 * Spawned by the homeconnect automation because Bun's tls data events are broken.
 *
 * Args: host key [port]
 * Stdin: JSON lines to send as WebSocket text frames
 * Stdout: JSON lines with {type, data/code/reason/message}
 */

import WebSocket from "ws";

const [,, host, key, port = "443"] = process.argv;
if (!host || !key) {
  process.stdout.write(JSON.stringify({ type: "error", message: "Usage: node psk-bridge.mjs <host> <key>" }) + "\n");
  process.exit(1);
}

const pskBuffer = Buffer.from(key + "==", "base64url");

const ws = new WebSocket(`wss://${host}:${port}/homeconnect`, {
  rejectUnauthorized: false,
  ciphers: "ECDHE-PSK-CHACHA20-POLY1305",
  minVersion: "TLSv1.2",
  pskCallback: () => ({
    identity: "Client_identity",
    psk: pskBuffer,
  }),
});

ws.on("open", () => {
  process.stdout.write(JSON.stringify({ type: "open" }) + "\n");
});

ws.on("message", (data) => {
  process.stdout.write(JSON.stringify({ type: "message", data: data.toString() }) + "\n");
});

ws.on("close", (code, reason) => {
  process.stdout.write(JSON.stringify({ type: "close", code, reason: reason.toString() }) + "\n");
  process.exit(0);
});

ws.on("error", (err) => {
  process.stdout.write(JSON.stringify({ type: "error", message: err.message }) + "\n");
});

let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk.toString();
  const lines = buf.split("\n");
  buf = lines.pop() ?? "";
  for (const line of lines) {
    if (line.trim() && ws.readyState === WebSocket.OPEN) {
      ws.send(line.trim());
    }
  }
});

process.stdin.on("end", () => ws.close());
