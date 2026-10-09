// The operations on an appliance against the fixture profile and a fake local
// session: programs are found by name, key or favourite name, options are
// checked and sent as uids, the preconditions (connected, remote start) are
// enforced, a refusal is reported with the appliance's code, and reported
// values land in the state decoded, favourite slots included.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { HCMessage } from "../src/protocol.ts";
import type { ApplianceLike } from "../src/appliance.ts";
import { test } from "node:test";
import { parseProfile, featureByName } from "../src/profile.ts";
import * as ops from "../src/appliance.ts";

const fail = (what: string, extra?: unknown): never => { throw new Error(`${what}: ${JSON.stringify(extra, null, 1)}`); };
const finish = (_result: unknown): void => {};

test("operations on an appliance against the fixture profile and a fake session", async () => {
  Object.assign(ops.settle, { powerOn: 0, start: 0, command: 0, setting: 0 });

  const fixtures = join(import.meta.dirname, "fixtures");
  const profile = parseProfile(readFileSync(join(fixtures, "DeviceDescription.xml"), "utf8"), readFileSync(join(fixtures, "FeatureMapping.xml"), "utf8"));
  const uid = (name: string) => { const f = featureByName(profile, name); if (!f) fail(`fixture has no ${name}`); return f!.uid; };
  const key = (name: string) => featureByName(profile, name)!.feature.key;
  const HOT_AIR = "Cooking.Oven.Program.HeatingMode.HotAir";

  const calls: Array<{ op: string; uid: number; value?: unknown; options?: unknown }> = [];
  let refuse: { code: number; info?: string } | null = null;
  const reply = (): HCMessage => ({ sID: 1, msgID: 1, resource: "/ro/values", version: 1, action: "RESPONSE", ...(refuse ?? {}) });
  const device = {
    connected: true,
    async setValue(uid: number, value: unknown) { calls.push({ op: "set", uid, value }); return reply(); },
    async startProgram(uid: number, options?: unknown) { calls.push({ op: "start", uid, options }); return reply(); },
  };
  const app: ApplianceLike = { config: { name: "oven", profile }, device, state: {}, favorites: new Map() };

  // Listing: all, a category, a search
  const all = ops.listPrograms(app, undefined, undefined);
  if (!all.count || !(all.programs as any[]).some((p) => p.program === key(HOT_AIR))) fail("list all", { all });
  const heating = ops.listPrograms(app, "heating_modes", undefined);
  if (!heating.count || (heating.count as number) > (all.count as number)) fail("category", { heating });
  const found = ops.listPrograms(app, undefined, "keep warm");
  if (!(found.programs as any[]).some((p) => p.program === key("Cooking.Oven.Program.HeatingMode.KeepWarm"))) fail("search", { found });

  // Start: remote start off, then on with options, then refused, unknown, disconnected
  app.state.remote_control_start_allowed = false;
  let r = await ops.startProgram(app, "hot air", { temperature: 180, duration_minutes: 30 });
  if (!String(r.error).includes("remote start")) fail("remote start off", { r });
  app.state.remote_control_start_allowed = true;
  app.state.power_state = "On";
  r = await ops.startProgram(app, "hot air", { temperature: 180, duration_minutes: 30 });
  if (r.ok !== true || r.program !== key(HOT_AIR)) fail("start", { r, calls });
  const start = calls.find((c) => c.op === "start");
  if (!start || start.uid !== uid(HOT_AIR)) fail("start uid", { calls });
  const opts = start.options as Array<{ uid: number; value: unknown }>;
  if (!opts.some((o) => o.uid === uid("Cooking.Oven.Option.SetpointTemperature") && o.value === 180)) fail("temperature option", { opts });
  if (!opts.some((o) => o.uid === uid("BSH.Common.Option.Duration") && o.value === 1800)) fail("duration option", { opts });
  refuse = { code: 400, info: "busy" };
  r = await ops.startProgram(app, "hot air", {});
  if (!String(r.error).includes("refused") || !String(r.error).includes("busy")) fail("refusal", { r });
  refuse = null;
  r = await ops.startProgram(app, "no such program", {});
  if (!r.error || !r.candidates) fail("unknown program", { r });
  device.connected = false;
  r = await ops.startProgram(app, "hot air", {});
  if (!String(r.error).includes("not connected")) fail("disconnected", { r });
  device.connected = true;

  // Commands: each one is the matching command feature, set to true
  calls.length = 0;
  r = await ops.runCommand(app, "stop");
  if (r.ok !== true || !calls.some((c) => c.op === "set" && c.uid === uid("BSH.Common.Command.AbortProgram") && c.value === true)) fail("stop", { r, calls });
  r = await ops.runCommand(app, "pause");
  if (r.ok !== true || !calls.some((c) => c.op === "set" && c.uid === uid("BSH.Common.Command.PauseProgram") && c.value === true)) fail("pause", { r, calls });
  r = await ops.runCommand(app, "resume");
  if (r.ok !== true || !calls.some((c) => c.op === "set" && c.uid === uid("BSH.Common.Command.ResumeProgram") && c.value === true)) fail("resume", { r, calls });

  // Settings: read-only refused, a status is not a setting
  r = await ops.setSetting(app, "remote control level", 2);
  if (!String(r.error).includes("read-only")) fail("read-only setting", { r });
  r = await ops.setSetting(app, "operation state", "Run");
  if (!r.error) fail("a status is not a setting", { r });

  // Reported values: a status decoded by its enum, a favourite slot collected
  const res = ops.applyStateUpdates(app, [
    { uid: uid("BSH.Common.Status.OperationState"), value: 2 },
    { uid: uid("BSH.Common.Setting.Favorite.001.Name"), value: "Pizza" },
    { uid: uid("BSH.Common.Setting.Favorite.001.Program"), value: uid(HOT_AIR) },
  ]);
  const opKey = key("BSH.Common.Status.OperationState");
  if (!res.changed.includes(opKey) || !res.favoritesChanged) fail("state updates", { res, state: app.state });
  if (typeof app.state[opKey] !== "string") fail("enum decoded", { value: app.state[opKey] });
  const favs = app.state.favorites as any[];
  if (!Array.isArray(favs) || favs[0]?.name !== "Pizza" || favs[0]?.slot !== "001") fail("favourites", { favs });
  if (ops.applyStateUpdates(app, [{ uid: uid("BSH.Common.Status.OperationState"), value: 2 }]).changed.length) fail("same value is not a change");

  // A favourite starts by the name it was given on the appliance
  calls.length = 0;
  r = await ops.startProgram(app, "Pizza", {});
  if (r.ok !== true || !calls.some((c) => c.op === "start" && c.uid === uid("BSH.Common.Program.Favorite.001"))) fail("favourite by name", { r, calls });

  // The active program as reported
  const pu = ops.applyProgramUpdate(app, { resource: "/ro/activeProgram", program: uid(HOT_AIR) });
  if (pu.key !== "active_program" || !pu.changed || app.state.active_program !== key(HOT_AIR)) fail("program update", { pu, state: app.state });
  if (ops.applyProgramUpdate(app, { resource: "/ro/activeProgram", program: uid(HOT_AIR) }).changed) fail("unchanged program reported as a change");

  finish({ programs: all.count, operationState: app.state[opKey], favourites: favs.length });
});
