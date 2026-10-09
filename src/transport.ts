// The connection to an appliance, in the three shapes it comes in. All three
// deliver the same events (open, message with the text of one frame, close
// with code and reason, error), so the session above does not care which one
// carries it.
//
// - psk: wss://<ip>:443/homeconnect over TLS-PSK with the appliance's key,
//   opened in this process. Node's tls does PSK; this is the normal case.
// - psk-bridge: the same socket, opened by a small Node subprocess that
//   speaks JSON lines over stdio. For runtimes without TLS-PSK (Bun).
// - aes: ws://<ip>:80/homeconnect with every frame encrypted and
//   authenticated by AesChannel (newer appliances, which have an iv next to
//   their key).
import { EventEmitter } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { AesChannel, keyBytes } from "./aes.ts";

export type TransportKind = "psk" | "psk-bridge" | "aes";

export interface TransportOptions {
  host: string;
  key: string;
  /** The appliance's iv, with an AES key. */
  iv?: string;
  /** 443 for psk, 80 for aes unless the appliance says otherwise. */
  port?: number;
}

export interface Transport extends EventEmitter {
  connect(): void;
  /** False when nothing is open to send on. */
  send(text: string): boolean;
  close(): void;
  readonly open: boolean;
}

/** The kind an appliance's key type calls for, on this runtime. */
export function chooseTransport(keyType: "tls" | "aes"): TransportKind {
  if (keyType === "aes") return "aes";
  return process.versions.bun ? "psk-bridge" : "psk";
}

export function createTransport(kind: TransportKind, opts: TransportOptions): Transport {
  switch (kind) {
    case "psk": return new PskTransport(opts);
    case "psk-bridge": return new BridgeTransport(opts);
    case "aes": return new AesTransport(opts);
  }
}

// A PSK handshake carries no certificate, so there is nothing to verify.
const PSK_TLS = {
  rejectUnauthorized: false,
  ciphers: "ECDHE-PSK-CHACHA20-POLY1305",
  minVersion: "TLSv1.2",
};

/** One frame as ws hands it over, as a Buffer. */
function frameOf(data: WebSocket.RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(new Uint8Array(data));
}

class PskTransport extends EventEmitter implements Transport {
  private ws: WebSocket | null = null;
  private readonly opts: TransportOptions;
  constructor(opts: TransportOptions) { super(); this.opts = opts; }

  get open(): boolean { return this.ws?.readyState === WebSocket.OPEN; }

  connect(): void {
    const psk = keyBytes(this.opts.key);
    const url = `wss://${this.opts.host}:${this.opts.port ?? 443}/homeconnect`;
    const ws = new WebSocket(url, { ...PSK_TLS, pskCallback: () => ({ identity: "Client_identity", psk }) } as unknown as WebSocket.ClientOptions);
    this.ws = ws;
    ws.on("open", () => this.emit("open"));
    ws.on("message", (data) => this.emit("message", frameOf(data).toString("utf8")));
    ws.on("close", (code, reason) => { this.ws = null; this.emit("close", code, reason.toString()); });
    ws.on("error", (err) => this.emit("error", err));
  }

  send(text: string): boolean {
    if (!this.open) return false;
    this.ws!.send(text);
    return true;
  }

  close(): void {
    this.ws?.close();
    this.ws = null;
  }
}

class AesTransport extends EventEmitter implements Transport {
  private ws: WebSocket | null = null;
  private channel: AesChannel | null = null;
  private readonly opts: TransportOptions;
  constructor(opts: TransportOptions) { super(); this.opts = opts; }

  get open(): boolean { return this.ws?.readyState === WebSocket.OPEN; }

  connect(): void {
    if (!this.opts.iv) throw new Error("the aes transport needs the appliance's iv");
    this.channel = new AesChannel(keyBytes(this.opts.key), keyBytes(this.opts.iv), "client");
    const url = `ws://${this.opts.host}:${this.opts.port ?? 80}/homeconnect`;
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.on("open", () => this.emit("open"));
    ws.on("message", (data) => {
      const text = this.channel!.decrypt(frameOf(data));
      if (text === null) {
        // Out of step with the appliance (a lost or tampered frame): the
        // chained hmacs cannot recover, so the session ends and reconnects.
        this.emit("error", new Error("hmac mismatch on a received frame"));
        ws.close(4000, "hmac mismatch");
        return;
      }
      this.emit("message", text);
    });
    ws.on("close", (code, reason) => { this.ws = null; this.emit("close", code, reason.toString()); });
    ws.on("error", (err) => this.emit("error", err));
  }

  send(text: string): boolean {
    if (!this.open || !this.channel) return false;
    this.ws!.send(this.channel.encrypt(text));
    return true;
  }

  close(): void {
    this.ws?.close();
    this.ws = null;
  }
}

class BridgeTransport extends EventEmitter implements Transport {
  private proc: ChildProcess | null = null;
  private isOpen = false;
  private readonly opts: TransportOptions;
  constructor(opts: TransportOptions) { super(); this.opts = opts; }

  get open(): boolean { return this.isOpen && !!this.proc?.stdin?.writable; }

  connect(): void {
    const bridgePath = fileURLToPath(new URL("../bridge/psk-bridge.mjs", import.meta.url));
    const proc = spawn("node", [bridgePath, this.opts.host, this.opts.key, String(this.opts.port ?? 443)], { stdio: ["pipe", "pipe", "pipe"] });
    this.proc = proc;
    let buf = "";
    proc.stdout!.on("data", (chunk: Buffer) => {
      buf += chunk.toString();
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let event: { type: string; data?: string; code?: number; reason?: string; message?: string };
        try { event = JSON.parse(line); } catch { continue; }
        if (event.type === "open") { this.isOpen = true; this.emit("open"); }
        else if (event.type === "message") this.emit("message", event.data ?? "");
        else if (event.type === "close") { this.isOpen = false; this.emit("close", event.code ?? 0, event.reason ?? ""); }
        else if (event.type === "error") this.emit("error", new Error(event.message ?? "bridge error"));
      }
    });
    proc.stderr!.on("data", (chunk: Buffer) => this.emit("error", new Error(`bridge: ${chunk.toString().trim()}`)));
    proc.on("exit", () => {
      if (this.isOpen) { this.isOpen = false; this.emit("close", 1006, "bridge exited"); }
      this.proc = null;
    });
  }

  send(text: string): boolean {
    if (!this.open) return false;
    this.proc!.stdin!.write(text + "\n");
    return true;
  }

  close(): void {
    this.isOpen = false;
    if (this.proc) {
      this.proc.stdin?.end();
      this.proc.kill();
      this.proc = null;
    }
  }
}
