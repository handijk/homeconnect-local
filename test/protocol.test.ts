// A session against the fake appliance over each transport: the handshake an
// appliance expects, reported values, a request's reply by message id, a
// refusal with the appliance's code, and a reconnect when the appliance drops
// the connection.
import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { HomeConnectDevice, type ProgramUpdate, type StateUpdate } from "../src/protocol.ts";
import { startFakeAppliance } from "./fake-appliance.ts";

const KEY = randomBytes(32).toString("base64url");
const IV = randomBytes(16).toString("base64url");

async function until(check: () => boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out after ${ms} ms waiting for: ${what}`);
}

const withTimeout = <T>(p: Promise<T>, ms: number, what: string) =>
  Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms} ms waiting for: ${what}`)), ms))]);

for (const kind of ["psk", "psk-bridge", "aes"] as const) {
  test(`a session over ${kind}: handshake, values, requests, a refusal, a reconnect`, async () => {
    const fake = await startFakeAppliance({ transport: kind === "aes" ? "aes" : "psk", key: KEY, iv: IV });
    const device = new HomeConnectDevice(
      { host: "127.0.0.1", ip: "127.0.0.1", key: KEY, keyType: kind === "aes" ? "aes" : "tls", iv: IV, transport: kind, port: fake.port },
      60_000,
      200,
    );
    const logs: string[] = [];
    const states: StateUpdate[][] = [];
    const programs: ProgramUpdate[] = [];
    device.on("log", (m: string) => logs.push(m));
    device.on("state", (u: StateUpdate[]) => states.push(u));
    device.on("program", (p: ProgramUpdate) => programs.push(p));
    try {
      const connected = once(device, "connected");
      await device.connect();
      await withTimeout(connected, 5000, `connected over ${kind} (${logs.join(" | ")})`);
      assert.equal(device.connected, true);

      // The session answered /ei/initialValues the way an appliance expects and asked for the values.
      await until(() => states.some((u) => u.some((x) => x.uid === 552 && x.value === 2)), 3000, "mandatory values");
      const handshake = fake.received.find((m) => m.resource === "/ei/initialValues" && m.action === "RESPONSE");
      assert.equal(handshake?.data?.[0]?.deviceType, "Application");
      assert.ok(fake.received.some((m) => m.resource === "/ei/deviceReady" && m.action === "NOTIFY"));

      // A request's reply, matched by message id
      const res = await device.setValue(539, 2);
      assert.equal(res?.action, "RESPONSE");
      assert.equal(res?.code, undefined);
      await until(() => states.some((u) => u.some((x) => x.uid === 539 && x.value === 2)), 3000, "the value reported back");

      // A refusal carries the appliance's code; an accepted program is reported as active
      const refused = await device.startProgram(1, []);
      assert.equal(refused?.code, 400);
      assert.equal(refused?.info, "unknown program");
      const started = await device.startProgram(8208, [{ uid: 5120, value: 180 }]);
      assert.equal(started?.code, undefined);
      await until(() => programs.some((p) => p.resource === "/ro/activeProgram" && p.program === 8208), 3000, "program reported");

      // The appliance drops the connection: the session is gone, then back
      const reconnected = once(device, "connected");
      fake.dropClients();
      await until(() => !device.connected, 3000, "dropped");
      await withTimeout(reconnected, 5000, `reconnected over ${kind} (${logs.slice(-5).join(" | ")})`);
      assert.equal(device.connected, true);
    } finally {
      device.disconnect();
      await fake.close();
    }
  });
}

test("the aes transport refuses to start without the appliance's iv", async () => {
  const device = new HomeConnectDevice({ host: "127.0.0.1", ip: "127.0.0.1", key: KEY, keyType: "aes", transport: "aes", port: 1 });
  await assert.rejects(() => device.connect(), /iv/);
});
