// An appliance on a port of its own, speaking the local protocol over either
// transport: TLS-PSK (an https server with a PSK callback and no certificate)
// or AES on a plain websocket, with AesChannel in the appliance role. It opens
// the session the way an appliance does (/ei/initialValues first), answers the
// requests a session makes, accepts one program (uid 8208) and refuses others.
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type RawData } from "ws";
import { AesChannel, keyBytes } from "../src/aes.ts";

export interface FakeAppliance {
  port: number;
  /** Every message the appliance received, parsed. */
  received: any[];
  /** Close the connections as an appliance that went away would. */
  dropClients(): void;
  close(): Promise<void>;
}

export async function startFakeAppliance(opts: { transport: "psk" | "aes"; key: string; iv?: string }): Promise<FakeAppliance> {
  const psk = keyBytes(opts.key);
  const server = opts.transport === "psk"
    ? createHttpsServer({
        ciphers: "ECDHE-PSK-CHACHA20-POLY1305",
        minVersion: "TLSv1.2",
        maxVersion: "TLSv1.2",
        pskIdentityHint: "appliance",
        pskCallback: (_socket: unknown, identity: string) => (identity === "Client_identity" ? psk : null),
      } as any)
    : createHttpServer();
  const wss = new WebSocketServer({ server, path: "/homeconnect" });
  const received: any[] = [];

  wss.on("connection", (ws) => {
    const channel = opts.transport === "aes" ? new AesChannel(psk, keyBytes(opts.iv!), "appliance") : null;
    const send = (msg: Record<string, unknown>) => {
      const text = JSON.stringify(msg);
      ws.send(channel ? channel.encrypt(text) : text);
    };
    const sID = 7;
    let msgID = 1;
    send({ sID, msgID: msgID++, resource: "/ei/initialValues", version: 2, action: "POST", data: [{ edMsgID: 100 }] });

    ws.on("message", (data: RawData) => {
      const raw = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(new Uint8Array(data));
      const text = channel ? channel.decrypt(raw) : raw.toString("utf8");
      if (text === null) { ws.close(4000, "hmac mismatch"); return; }
      const msg = JSON.parse(text);
      received.push(msg);
      const reply = (extra: Record<string, unknown> = {}) =>
        send({ sID, msgID: msg.msgID, resource: msg.resource, version: msg.version, action: "RESPONSE", ...extra });
      if (msg.action === "RESPONSE" || msg.action === "NOTIFY") return;
      if (msg.resource === "/ci/services" && msg.action === "GET") reply({ data: [{ service: "ro", version: 1 }] });
      else if (msg.resource === "/ro/allMandatoryValues" && msg.action === "GET") reply({ data: [{ uid: 552, value: 2 }, { uid: 517, value: true }] });
      else if (msg.resource === "/ro/values" && msg.action === "POST") {
        reply();
        send({ sID, msgID: msgID++, resource: "/ro/values", version: 1, action: "NOTIFY", data: msg.data });
      } else if (msg.resource === "/ro/activeProgram" && msg.action === "POST") {
        const program = msg.data?.[0]?.program;
        if (program === 8208) {
          reply();
          send({ sID, msgID: msgID++, resource: "/ro/activeProgram", version: 1, action: "NOTIFY", data: [{ program, options: msg.data[0].options ?? [] }] });
        } else reply({ code: 400, info: "unknown program" });
      } else if (msg.action === "GET") reply({ data: [] });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as AddressInfo).port,
    received,
    dropClients: () => { for (const client of wss.clients) client.close(1001, "going away"); },
    close: () => new Promise<void>((resolve) => { for (const client of wss.clients) client.terminate(); wss.close(() => server.close(() => resolve())); }),
  };
}
