// Operations on one appliance, given its local session, its profile and
// what it has reported so far: start a program by name or key with checked
// options, stop/pause/resume, change a setting, list programs, and keep the
// reported state (favourite slots included) up to date. The tools and the
// /set topic in StateBridge share these; a bridge to another system can too.
import type { HCMessage, ProgramUpdate, StateUpdate } from "./protocol.ts";
import {
  findFeature, featureByName, featureByTail, decodeValue, encodeValue, buildProgramOptions, describeProgram,
  programCategory, snake, type Profile, type StartInput,
} from "./profile.ts";

/** What an operation needs from the local session (HomeConnectDevice has it; a test can fake it). */
export interface DeviceSession {
  readonly connected: boolean;
  setValue(uid: number, value: any): Promise<HCMessage | null>;
  startProgram(programUid: number, options?: { uid: number; value: any }[]): Promise<HCMessage | null>;
}

export interface ApplianceLike {
  config: { name: string; profile: Profile };
  device: DeviceSession;
  /** Decoded state by feature key, as last reported. */
  state: Record<string, unknown>;
  /** Favourite slots saved on the appliance: slot → {name, program, functionality} */
  favorites: Map<string, Record<string, unknown>>;
}

export const FAVORITE_RE = /\.Setting\.Favorite\.(\d+)\.(Name|Program|Functionality)$/;
export const SNAPSHOT_KEY = /operation_state|active_program|selected_program|power_state|remote_control_start_allowed|door_state|remaining_program_time|current_temperature|setpoint_temperature|program_progress|^duration$/;
export const PROGRAM_CATEGORIES = ["all", "heating_modes", "steam", "dishes", "favorites", "cleaning", "other"];

/** How long an appliance is given to report after a request, before the result is read back (ms). */
export const settle = { powerOn: 1500, start: 2000, command: 1500, setting: 1000 };

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));


export function replyText(res: HCMessage | null): string {
  if (!res) return "no reply within 5 s";
  if (res.code !== undefined) return `refused with code ${res.code}${res.info ? ` (${res.info})` : ""}`;
  return "accepted";
}

export function snapshot(app: ApplianceLike): Record<string, unknown> {
  const out: Record<string, unknown> = { connected: app.device.connected };
  for (const [k, v] of Object.entries(app.state)) if (SNAPSHOT_KEY.test(k)) out[k] = v;
  return out;
}

export function programKey(profile: Profile, uid: number | null): string | null {
  if (uid === null || uid === 0) return null;
  const f = profile.features[String(uid)];
  return f?.kind === "program" ? f.key : String(uid);
}

/** Favourite names as saved on the appliance → the uid of that favourite's program slot. */
export function favoriteAliases(app: ApplianceLike): Map<string, number> {
  const aliases = new Map<string, number>();
  for (const [slot, fav] of app.favorites) {
    const name = typeof fav.name === "string" ? fav.name.trim() : "";
    if (!name) continue;
    const program = featureByName(app.config.profile, `BSH.Common.Program.Favorite.${slot}`);
    if (program) aliases.set(name.toLowerCase(), program.uid);
  }
  return aliases;
}

// --- Operations (the tools and the /set topic share these) ---

export async function startProgram(app: ApplianceLike, programQuery: string, input: StartInput): Promise<Record<string, unknown>> {
  const profile = app.config.profile;
  const r = findFeature(profile, programQuery, ["program"], favoriteAliases(app));
  if (!r.feature || r.uid === undefined) {
    return {
      error: r.error, candidates: r.candidates,
      hint: "homeconnect__list_programs with a search finds the exact name; favourites saved on the appliance are listed by the name they were given there",
    };
  }
  const built = buildProgramOptions(profile, r.feature, input);
  if ("error" in built) return { ...built, program: r.feature.key };
  if (!app.device.connected) return { error: `the ${app.config.name} is not connected`, program: r.feature.key };
  if (app.state.remote_control_start_allowed === false) {
    return {
      error: `remote start is switched off on the ${app.config.name}: someone has to allow it on the appliance itself (its remote start button), then try again`,
      program: r.feature.key, state: snapshot(app),
    };
  }

  const steps: string[] = [];
  const power = app.state.power_state;
  if (typeof power === "string" && /^(standby|off)$/i.test(power)) {
    const ps = featureByName(profile, "BSH.Common.Setting.PowerState");
    const on = ps ? encodeValue(ps.feature, "On") : null;
    if (ps && on && !("error" in on)) {
      const res = await app.device.setValue(ps.uid, on.value);
      steps.push(`switch on: ${replyText(res)}`);
      await sleep(settle.powerOn);
    }
  }

  const res = await app.device.startProgram(r.uid, built.options);
  steps.push(`start ${r.feature.key}: ${replyText(res)}`);
  if (res?.code !== undefined) {
    return { error: `the ${app.config.name} refused to start ${r.feature.key}: code ${res.code}${res.info ? ` (${res.info})` : ""}`, options: built.readable, steps, state: snapshot(app) };
  }
  await sleep(settle.start);
  return { ok: true, confirmed: res !== null, program: r.feature.key, options: built.readable, steps, state: snapshot(app) };
}

export async function runCommand(app: ApplianceLike, action: "stop" | "pause" | "resume"): Promise<Record<string, unknown>> {
  const tailName = { stop: "AbortProgram", pause: "PauseProgram", resume: "ResumeProgram" }[action];
  const hit = featureByTail(app.config.profile, tailName, "command");
  if (!hit) return { error: `the ${app.config.name} has no ${action} command` };
  if (!app.device.connected) return { error: `the ${app.config.name} is not connected` };
  const res = await app.device.setValue(hit.uid, true);
  if (res?.code !== undefined) return { error: `the ${app.config.name} refused ${action}: code ${res.code}${res.info ? ` (${res.info})` : ""}`, state: snapshot(app) };
  await sleep(settle.command);
  return { ok: true, confirmed: res !== null, action, state: snapshot(app) };
}

export async function setSetting(app: ApplianceLike, query: string, value: unknown): Promise<Record<string, unknown>> {
  const profile = app.config.profile;
  const r = findFeature(profile, query, ["setting"]);
  if (!r.feature || r.uid === undefined) return { error: r.error, candidates: r.candidates };
  if (r.feature.access !== "readWrite" && r.feature.access !== "writeOnly") return { error: `${r.feature.key} is read-only` };
  const enc = encodeValue(r.feature, value);
  if ("error" in enc) return enc;
  if (!app.device.connected) return { error: `the ${app.config.name} is not connected` };
  const res = await app.device.setValue(r.uid, enc.value);
  if (res?.code !== undefined) return { error: `the ${app.config.name} refused ${r.feature.key}=${String(value)}: code ${res.code}${res.info ? ` (${res.info})` : ""}` };
  await sleep(settle.setting);
  return { ok: true, confirmed: res !== null, setting: r.feature.key, sent: decodeValue(profile, r.feature, enc.value), now: app.state[r.feature.key] };
}

export function listPrograms(app: ApplianceLike, category: string | undefined, search: string | undefined): Record<string, unknown> {
  const profile = app.config.profile;
  const cat = category && PROGRAM_CATEGORIES.includes(category) ? category : "all";
  const q = search?.trim().toLowerCase() ?? "";
  const sq = q ? snake(q) : "";
  let picked = Object.values(profile.features).filter((f) => f.kind === "program");
  if (cat !== "all") picked = picked.filter((f) => programCategory(f.name) === cat);
  if (q) picked = picked.filter((f) => f.key.includes(sq) || f.name.toLowerCase().includes(q));
  const withOptions = picked.length <= 40;
  const favorites = (app.state.favorites as unknown[]) ?? [];
  return {
    appliance: app.config.name,
    category: cat,
    count: picked.length,
    programs: picked.map((f) => describeProgram(profile, f, withOptions)),
    favorites,
    note: withOptions
      ? "Durations are in seconds here; start_program takes minutes. Temperatures are °C."
      : "Names only: narrow with category or search to see what each program takes.",
  };
}

/**
 * Apply reported values to the state: decoded by the profile, favourite
 * slots collected into `favorites` and mirrored as `state.favorites`.
 * Returns the keys whose value changed.
 */
export function applyStateUpdates(app: ApplianceLike, updates: StateUpdate[]): { changed: string[]; favoritesChanged: boolean } {
  const profile = app.config.profile;
  const changed: string[] = [];
  let favoritesChanged = false;
  for (const { uid, value } of updates) {
    const f = profile.features[String(uid)];
    if (!f) continue;
    const fav = FAVORITE_RE.exec(f.name);
    if (fav) {
      const slot = app.favorites.get(fav[1]) ?? {};
      slot[fav[2].toLowerCase()] = decodeValue(profile, f, value);
      app.favorites.set(fav[1], slot);
      favoritesChanged = true;
      continue;
    }
    const decoded = decodeValue(profile, f, value);
    if (app.state[f.key] !== decoded) changed.push(f.key);
    app.state[f.key] = decoded;
  }
  if (favoritesChanged) {
    app.state.favorites = [...app.favorites.entries()]
      .filter(([, s]) => typeof s.name === "string" && s.name.trim() !== "")
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([slot, s]) => ({ slot, ...s }));
  }
  return { changed, favoritesChanged };
}

/** The active or selected program as reported, as its program key in the state. */
export function applyProgramUpdate(app: ApplianceLike, p: ProgramUpdate): { key: string; changed: boolean } {
  const key = p.resource === "/ro/activeProgram" ? "active_program" : "selected_program";
  const value = programKey(app.config.profile, p.program);
  const changed = app.state[key] !== value;
  app.state[key] = value;
  return { key, changed };
}
