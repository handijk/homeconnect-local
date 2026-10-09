/**
 * Home Connect Local Protocol
 *
 * Connects to Home Connect appliances via TLS-PSK WebSocket.
 * Uses a Node.js subprocess for the TLS-PSK connection (Bun's tls
 * data events are broken). Communication via stdin/stdout JSON lines.
 *
 * A request's reply carries the request's msgID; `request()` waits for it
 * so a caller learns whether the appliance accepted a program or a value.
 */

import { EventEmitter } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

export interface DeviceConfig {
  host: string;
  ip: string;
  key: string;
  keyType: "tls" | "aes";
}

export interface HCMessage {
  sID: number;
  msgID: number;
  resource: string;
  version: number;
  action: string;
  data?: any[];
  /** Set on a refused request */
  code?: number;
  info?: string;
}

export interface StateUpdate {
  uid: number;
  value: any;
}

export interface ProgramUpdate {
  resource: "/ro/activeProgram" | "/ro/selectedProgram";
  program: number | null;
  options?: { uid: number; value: any }[];
}

export const REQUEST_TIMEOUT_MS = 5000;

export class HomeConnectDevice extends EventEmitter {
  private proc: ChildProcess | null = null;
  private config: DeviceConfig;
  private sessionId = 0;
  private txMsgId = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private isConnected = false;
  private pollIntervalMs: number;
  private pending = new Map<number, { resolve: (m: HCMessage | null) => void; timer: ReturnType<typeof setTimeout> }>();

  constructor(config: DeviceConfig, pollIntervalMs = 60_000) {
    super();
    this.config = config;
    this.pollIntervalMs = pollIntervalMs;
  }

  /** The session is up: initial values exchanged, requests possible. */
  get connected(): boolean {
    return this.isConnected;
  }

  async connect(): Promise<void> {
    const host = this.config.ip || this.config.host;
    const bridgePath = fileURLToPath(new URL("../bridge/psk-bridge.mjs", import.meta.url));

    this.proc = spawn("node", [bridgePath, host, this.config.key], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let buf = "";
    this.proc.stdout!.on("data", (chunk: Buffer) => {
      buf += chunk.toString();
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (event.type === "open") {
            this.emit("log", "WebSocket connected (via Node bridge)");
          } else if (event.type === "message") {
            this.handleMessage(Buffer.from(event.data));
          } else if (event.type === "close") {
            this.emit("log", `WebSocket closed: ${event.code} ${event.reason}`);
            this.dropSession();
            this.scheduleReconnect();
          } else if (event.type === "error") {
            this.emit("log", `WebSocket error: ${event.message}`);
          }
        } catch {}
      }
    });

    this.proc.stderr!.on("data", (chunk: Buffer) => {
      this.emit("log", `Bridge: ${chunk.toString().trim()}`);
    });

    this.proc.on("exit", () => {
      if (this.isConnected) {
        this.dropSession();
        this.scheduleReconnect();
      }
    });
  }

  disconnect(): void {
    this.stopPolling();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.proc) {
      this.proc.stdin!.end();
      this.proc.kill();
      this.proc = null;
    }
    this.dropSession();
  }

  /** Send a request and wait for the appliance's reply; null when none came within the timeout. */
  request(resource: string, version = 1, action = "GET", data?: any[], timeoutMs = REQUEST_TIMEOUT_MS): Promise<HCMessage | null> {
    if (!this.proc?.stdin?.writable) {
      this.emit("log", "Cannot send — bridge not ready");
      return Promise.resolve(null);
    }
    const msgID = this.txMsgId++;
    const msg: HCMessage = { sID: this.sessionId, msgID, resource, version, action };
    if (data) msg.data = data;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(msgID);
        resolve(null);
      }, timeoutMs);
      this.pending.set(msgID, { resolve, timer });
      this.sendRaw(msg);
    });
  }

  /** Write one value (a setting, an option, a command: commands take `true`). */
  setValue(uid: number, value: any): Promise<HCMessage | null> {
    return this.request("/ro/values", 1, "POST", [{ uid, value }]);
  }

  /** Start a program with its options in the same message, as the appliance expects. */
  startProgram(programUid: number, options: { uid: number; value: any }[] = []): Promise<HCMessage | null> {
    const item: Record<string, unknown> = { program: programUid };
    if (options.length) item.options = options;
    return this.request("/ro/activeProgram", 1, "POST", [item]);
  }

  /** Select a program without starting it (the appliance shows it; options can follow). */
  selectProgram(programUid: number, options: { uid: number; value: any }[] = []): Promise<HCMessage | null> {
    const item: Record<string, unknown> = { program: programUid };
    if (options.length) item.options = options;
    return this.request("/ro/selectedProgram", 1, "POST", [item]);
  }

  requestAllValues(): void {
    this.send("/ro/allMandatoryValues");
  }

  private handleMessage(data: Buffer): void {
    let msg: HCMessage;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      this.emit("log", `Invalid JSON: ${data.toString().slice(0, 100)}`);
      return;
    }

    if (msg.action === "RESPONSE") {
      const waiting = this.pending.get(msg.msgID);
      if (waiting) {
        clearTimeout(waiting.timer);
        this.pending.delete(msg.msgID);
        waiting.resolve(msg);
      }
    }

    if (msg.resource === "/ei/initialValues" && msg.action === "POST") {
      this.handleInitialValues(msg);
      return;
    }

    if (
      msg.resource === "/ro/values" ||
      msg.resource === "/ro/allMandatoryValues" ||
      msg.resource === "/ro/activeProgram" ||
      msg.resource === "/ro/selectedProgram"
    ) {
      if (msg.data && Array.isArray(msg.data)) {
        const updates: StateUpdate[] = [];
        for (const item of msg.data) {
          if (item && typeof item === "object" && "uid" in item && "value" in item) {
            updates.push({ uid: item.uid, value: item.value });
          }
          if (item && typeof item === "object" && "program" in item && (msg.resource === "/ro/activeProgram" || msg.resource === "/ro/selectedProgram")) {
            const update: ProgramUpdate = { resource: msg.resource, program: typeof item.program === "number" ? item.program : null };
            if (Array.isArray(item.options)) update.options = item.options;
            this.emit("program", update);
          }
        }
        if (updates.length > 0) {
          this.emit("state", updates, msg.action);
        }
      }
    }

    if (msg.resource === "/ci/services" && msg.action === "RESPONSE") {
      this.emit("log", `Device services: ${JSON.stringify(msg.data)}`);
    }

    if (msg.code !== undefined) {
      this.emit("log", `Device error ${msg.code}: ${msg.resource} - ${msg.info || ""}`);
    }
  }

  private handleInitialValues(msg: HCMessage): void {
    this.sessionId = msg.sID;
    this.txMsgId = msg.data?.[0]?.edMsgID ?? 1;

    this.emit("log", `Session established: sID=${this.sessionId}, txMsgId=${this.txMsgId}`);

    this.sendRaw({
      sID: this.sessionId,
      msgID: msg.msgID,
      resource: "/ei/initialValues",
      version: 1,
      action: "RESPONSE",
      data: [{
        deviceType: "Application",
        deviceName: "homeconnect2mqtt",
        deviceID: "0badcafe",
      }],
    });

    this.send("/ci/services");
    this.send("/ei/deviceReady", 2, "NOTIFY");
    this.send("/ro/allMandatoryValues");

    this.isConnected = true;
    this.emit("connected");
    this.startPolling();
  }

  private send(resource: string, version = 1, action = "GET", data?: any[]): void {
    const msg: HCMessage = {
      sID: this.sessionId,
      msgID: this.txMsgId++,
      resource,
      version,
      action,
    };
    if (data) msg.data = data;
    this.sendRaw(msg);
  }

  private sendRaw(msg: HCMessage): void {
    if (!this.proc?.stdin?.writable) {
      this.emit("log", "Cannot send — bridge not ready");
      return;
    }
    this.proc.stdin.write(JSON.stringify(msg) + "\n");
  }

  private dropSession(): void {
    this.isConnected = false;
    this.stopPolling();
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.resolve(null);
    }
    this.pending.clear();
  }

  private startPolling(): void {
    this.stopPolling();
    this.pollTimer = setInterval(() => {
      if (this.isConnected) this.requestAllValues();
    }, this.pollIntervalMs);
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.emit("log", "Reconnecting in 10s...");
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch((err) => {
        this.emit("log", `Reconnect failed: ${err.message}`);
        this.scheduleReconnect();
      });
    }, 10_000);
  }
}
