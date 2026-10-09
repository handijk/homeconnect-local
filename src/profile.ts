import { XMLParser } from "fast-xml-parser";
/**
 * The appliance profile Home Connect hands out at login, as two XML files:
 *
 * - DeviceDescription.xml: what the appliance has. Statuses, settings,
 *   options, commands and events with their access, ranges (min, max,
 *   stepSize) and enumeration type; programs with the options each one
 *   takes; which enumeration types are subsets of others.
 * - FeatureMapping.xml: the names behind the uids
 *   ("BSH.Common.Setting.PowerState") and the names behind the enum values
 *   ("On", "Standby").
 *
 * Parsed once into a Profile the automation keeps in Redis. Every feature
 * gets a short key for the MQTT state document and the tools ("power_state",
 * "hot_air"); keys that would collide get the longer tail of their name.
 */

export const PROFILE_VERSION = 2;

export type Access = "read" | "readWrite" | "writeOnly" | "none";
export type Kind = "status" | "setting" | "option" | "command" | "event" | "program" | "activeProgram" | "selectedProgram" | "other";

export interface ProgramOption {
  uid: number;
  access: Access;
  default?: string;
}

export interface Feature {
  /** Full Home Connect name, e.g. Cooking.Oven.Program.HeatingMode.HotAir */
  name: string;
  /** Short unique key, e.g. hot_air */
  key: string;
  kind: Kind;
  access: Access;
  available?: boolean;
  min?: number;
  max?: number;
  step?: number;
  default?: string;
  /** Enum value → name, e.g. {"2": "On", "3": "Standby"} */
  values?: Record<string, string>;
  /** Programs: selectOnly / selectAndStart / startOnly */
  execution?: string;
  /** Programs: the options this program takes */
  options?: ProgramOption[];
}

export interface Profile {
  version: number;
  info: Record<string, string>;
  /** The appliance wants every option of a program in the start message */
  fullOptionSet: boolean;
  /** uid (decimal, as a string) → feature */
  features: Record<string, Feature>;
}

// --- XML ---

interface Tag {
  name: string;
  attrs: Record<string, string>;
  text: string;
}

// fast-xml-parser, in document order with attributes and text kept as
// strings: the uids are hex ("0300"), never numbers.
const xmlParser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: "",
  trimValues: true,
  parseTagValue: false,
  parseAttributeValue: false,
  processEntities: true,
  ignoreDeclaration: true,
  ignorePiTags: true,
});

/** Walk the elements of a small XML document; `path` is the chain of open parents. */
function walk(input: string, visit: (tag: Tag, path: string[]) => void): void {
  const path: string[] = [];
  const descend = (nodes: Array<Record<string, unknown>>) => {
    for (const node of nodes) {
      const name = Object.keys(node).find((k) => k !== ":@");
      if (!name || name === "#text") continue;
      const children = (node[name] ?? []) as Array<Record<string, unknown>>;
      const text = children
        .filter((c) => typeof c["#text"] === "string" || typeof c["#text"] === "number")
        .map((c) => String(c["#text"]))
        .join("")
        .trim();
      visit({ name, attrs: (node[":@"] ?? {}) as Record<string, string>, text }, path);
      path.push(name);
      descend(children);
      path.pop();
    }
  };
  descend(xmlParser.parse(input) as Array<Record<string, unknown>>);
}

// --- Parsing ---

function asAccess(v: string | undefined): Access {
  return v === "read" || v === "readWrite" || v === "writeOnly" ? v : "none";
}

function asNumber(v: string | undefined): number | undefined {
  if (v === undefined || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

const KINDS = new Set<string>(["status", "setting", "option", "command", "event", "program", "activeProgram", "selectedProgram"]);

export function parseProfile(deviceDescription: string, featureMapping: string): Profile {
  // FeatureMapping: names and enums
  const names = new Map<number, string>();
  const enums = new Map<number, Record<string, string>>();
  let currentEnum: Record<string, string> | null = null;
  walk(featureMapping, (tag) => {
    if (tag.name === "feature" && tag.attrs.refUID) {
      names.set(parseInt(tag.attrs.refUID, 16), tag.text);
    } else if (tag.name === "enumDescription" && tag.attrs.refENID) {
      currentEnum = {};
      enums.set(parseInt(tag.attrs.refENID, 16), currentEnum);
    } else if (tag.name === "enumMember" && currentEnum && tag.attrs.refValue !== undefined) {
      currentEnum[String(parseInt(tag.attrs.refValue))] = tag.text;
    }
  });

  // DeviceDescription: entries, program options, enum subsets, info
  interface Raw { el: string; uid: number; attrs: Record<string, string>; options: ProgramOption[] }
  const raw: Raw[] = [];
  const subsets = new Map<number, { of?: number; values: number[] }>();
  const info: Record<string, string> = {};
  let fullOptionSet = false;
  let currentProgram: Raw | null = null;
  let currentEnumType: { of?: number; values: number[] } | null = null;
  walk(deviceDescription, (tag, path) => {
    const parent = path[path.length - 1];
    if (parent === "description") { if (tag.text) info[tag.name] = tag.text; return; }
    if (tag.name === "enumerationType" && tag.attrs.enid) {
      currentEnumType = { of: tag.attrs.subsetOf ? parseInt(tag.attrs.subsetOf, 16) : undefined, values: [] };
      subsets.set(parseInt(tag.attrs.enid, 16), currentEnumType);
      return;
    }
    if (tag.name === "enumeration" && currentEnumType && tag.attrs.value !== undefined) {
      currentEnumType.values.push(parseInt(tag.attrs.value));
      return;
    }
    if (tag.name === "option" && parent === "program" && tag.attrs.refUID && currentProgram) {
      const opt: ProgramOption = { uid: parseInt(tag.attrs.refUID, 16), access: asAccess(tag.attrs.access) };
      if (tag.attrs.default !== undefined) opt.default = tag.attrs.default;
      currentProgram.options.push(opt);
      return;
    }
    if (!tag.attrs.uid || !KINDS.has(tag.name)) return;
    const entry: Raw = { el: tag.name, uid: parseInt(tag.attrs.uid, 16), attrs: tag.attrs, options: [] };
    raw.push(entry);
    if (tag.name === "program") currentProgram = entry;
    if ((tag.name === "activeProgram" || tag.name === "selectedProgram") && tag.attrs.fullOptionSet === "true") fullOptionSet = true;
  });

  const resolveEnum = (enid: number, depth = 0): Record<string, string> | undefined => {
    const direct = enums.get(enid);
    if (direct) return direct;
    const sub = subsets.get(enid);
    if (!sub || sub.of === undefined || depth > 4) return undefined;
    const parent = resolveEnum(sub.of, depth + 1);
    if (!parent) return undefined;
    const out: Record<string, string> = {};
    for (const v of sub.values) if (parent[String(v)] !== undefined) out[String(v)] = parent[String(v)];
    return out;
  };

  const features: Record<string, Feature> = {};
  for (const e of raw) {
    const f: Feature = {
      name: names.get(e.uid) ?? `uid:${e.uid}`,
      key: "",
      kind: e.el as Kind,
      access: asAccess(e.attrs.access),
    };
    if (e.attrs.available !== undefined) f.available = e.attrs.available === "true";
    const min = asNumber(e.attrs.min), max = asNumber(e.attrs.max), step = asNumber(e.attrs.stepSize);
    if (min !== undefined) f.min = min;
    if (max !== undefined) f.max = max;
    if (step !== undefined && step > 0) f.step = step;
    if (e.attrs.default !== undefined) f.default = e.attrs.default;
    if (e.attrs.execution) f.execution = e.attrs.execution;
    if (e.attrs.enumerationType) {
      const values = resolveEnum(parseInt(e.attrs.enumerationType, 16));
      if (values && Object.keys(values).length) f.values = values;
    }
    if (e.el === "program") f.options = e.options;
    features[String(e.uid)] = f;
  }
  // Names the description does not list still decode values that show up live.
  for (const [uid, name] of names) {
    if (!features[String(uid)]) features[String(uid)] = { name, key: "", kind: "other", access: "none" };
  }
  assignKeys(features);

  return { version: PROFILE_VERSION, info, fullOptionSet, features };
}

// --- Keys ---

export function snake(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

const KIND_SEGMENT = /\.(Status|Setting|Option|Command|Event|Program|Root)\./;

/** The segments after the kind: "Cooking.Oven.Status.Cavity.001.OperationState" → ["Cavity", "001", "OperationState"] */
function tail(name: string): string[] {
  const m = KIND_SEGMENT.exec(name);
  const rest = m ? name.slice(m.index + m[0].length) : name.split(".").pop() ?? name;
  return rest.split(".");
}

/** "PowerState" → power_state; anything under a numbered segment keeps it: "Cavity.001.CurrentTemperature" → cavity_001_current_temperature */
function shortKey(name: string): string {
  const t = tail(name);
  return t.some((seg) => /^\d+$/.test(seg)) ? snake(t.join("_")) : snake(t[t.length - 1]);
}

function assignKeys(features: Record<string, Feature>): void {
  const groups = new Map<string, string[]>();
  for (const [uid, f] of Object.entries(features)) {
    const k = shortKey(f.name);
    groups.set(k, [...(groups.get(k) ?? []), uid]);
  }
  const taken = new Set<string>();
  for (const [k, uids] of groups) {
    if (uids.length === 1) { features[uids[0]].key = k; taken.add(k); continue; }
    for (const uid of uids) {
      let key = snake(tail(features[uid].name).join("_"));
      if (taken.has(key)) key = `${key}_${uid}`;
      taken.add(key);
      features[uid].key = key;
    }
  }
}

// --- Lookups ---

export function featureByName(profile: Profile, name: string): { uid: number; feature: Feature } | null {
  for (const [uid, f] of Object.entries(profile.features)) if (f.name === name) return { uid: Number(uid), feature: f };
  return null;
}

/** A feature by the tail of its name, e.g. "SetpointTemperature" or "Option.Duration", optionally among given uids first. */
export function featureByTail(profile: Profile, tailName: string, kind?: Kind, preferUids?: number[]): { uid: number; feature: Feature } | null {
  const matches: { uid: number; feature: Feature }[] = [];
  for (const [uid, f] of Object.entries(profile.features)) {
    if (kind && f.kind !== kind) continue;
    if (f.name === tailName || f.name.endsWith(`.${tailName}`)) matches.push({ uid: Number(uid), feature: f });
  }
  if (!matches.length) return null;
  if (preferUids) {
    const preferred = matches.find((m) => preferUids.includes(m.uid));
    if (preferred) return preferred;
  }
  return matches[0];
}

export interface Resolution {
  uid?: number;
  feature?: Feature;
  error?: string;
  candidates?: string[];
}

/**
 * A feature from whatever a person or an agent typed: a uid, the full name,
 * the key, the last segment of the name, or a part of the key when only one
 * feature matches. `aliases` are extra names (favourites) that map to a uid.
 */
export function findFeature(profile: Profile, query: string, kinds: Kind[], aliases?: Map<string, number>): Resolution {
  const q = query.trim();
  if (!q) return { error: "empty name" };
  const lower = q.toLowerCase();
  const alias = aliases?.get(lower);
  if (alias !== undefined && profile.features[String(alias)]) return { uid: alias, feature: profile.features[String(alias)] };

  const pool = Object.entries(profile.features).filter(([, f]) => kinds.includes(f.kind));
  if (/^\d+$/.test(q)) {
    const hit = pool.find(([uid]) => uid === String(Number(q)));
    if (hit) return { uid: Number(hit[0]), feature: hit[1] };
  }
  const sk = snake(q);
  const exact = pool.filter(([, f]) => f.name === q || f.key === sk || f.name.toLowerCase() === lower || f.name.split(".").pop()!.toLowerCase() === lower.replace(/[\s_]/g, ""));
  if (exact.length === 1) return { uid: Number(exact[0][0]), feature: exact[0][1] };
  if (exact.length > 1) return { error: `"${q}" matches several: ${exact.map(([, f]) => f.key).join(", ")}`, candidates: exact.map(([, f]) => f.key) };

  const partial = pool.filter(([, f]) => (sk && f.key.includes(sk)) || f.name.toLowerCase().includes(lower));
  if (partial.length === 1) return { uid: Number(partial[0][0]), feature: partial[0][1] };
  if (partial.length > 1 && partial.length <= 12) return { error: `"${q}" matches several: ${partial.map(([, f]) => f.key).join(", ")}`, candidates: partial.map(([, f]) => f.key) };
  if (partial.length > 12) return { error: `"${q}" matches ${partial.length} names; be more specific`, candidates: partial.slice(0, 12).map(([, f]) => f.key) };
  return { error: `no ${kinds.join("/")} named "${q}"`, candidates: [] };
}

// --- Values ---

/** A live value as the state document shows it: enum names, program keys. */
export function decodeValue(profile: Profile, feature: Feature, value: unknown): unknown {
  if (feature.values && (typeof value === "number" || typeof value === "string")) {
    const name = feature.values[String(value)];
    if (name !== undefined) return name;
  }
  if (typeof value === "number" && /Program$/.test(feature.name)) {
    const program = profile.features[String(value)];
    if (program?.kind === "program") return program.key;
  }
  return value;
}

/** What to send for a feature given what a person typed: enum names become numbers, ranges are checked. */
export function encodeValue(feature: Feature, input: unknown): { value: unknown } | { error: string } {
  if (feature.values) {
    if (typeof input === "number" && feature.values[String(input)] !== undefined) return { value: input };
    const s = String(input).trim().toLowerCase();
    const hit = Object.entries(feature.values).find(([k, n]) => n.toLowerCase() === s || snake(n) === snake(s) || k === s);
    if (!hit) return { error: `${feature.key}: expected one of ${Object.values(feature.values).join(", ")}` };
    return { value: parseInt(hit[0]) };
  }
  let v: unknown = input;
  if (typeof v === "string") {
    const t = v.trim();
    if (/^(true|false)$/i.test(t)) v = t.toLowerCase() === "true";
    else if (t !== "" && !isNaN(Number(t))) v = Number(t);
    else return { value: t };
  }
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return { error: `${feature.key}: not a number` };
    if (feature.min !== undefined && v < feature.min) return { error: `${feature.key}: ${v} is below the minimum ${feature.min}` };
    if (feature.max !== undefined && v > feature.max) return { error: `${feature.key}: ${v} is above the maximum ${feature.max}` };
    if (feature.step && feature.step > 0) {
      const base = feature.min ?? 0;
      const r = Math.abs(((v - base) / feature.step) % 1);
      if (r > 1e-9 && r < 1 - 1e-9) return { error: `${feature.key}: ${v} is not a multiple of ${feature.step}${base ? ` from ${base}` : ""}` };
    }
  }
  return { value: v };
}

// --- Programs ---

export function programCategory(name: string): string {
  if (/\.Program\.Favorite\./.test(name)) return "favorites";
  if (/\.Program\.HeatingMode\./.test(name)) return "heating_modes";
  if (/\.Program\.SteamModes\./.test(name)) return "steam";
  if (/\.Program\.Dish\./.test(name)) return "dishes";
  if (/\.Program\.Cleaning/.test(name)) return "cleaning";
  return "other";
}

export interface StartInput {
  temperature?: number;
  duration_minutes?: number;
  fast_preheat?: boolean;
  start_in_minutes?: number;
  options?: Record<string, unknown>;
}

export interface BuiltOptions {
  /** As sent to the appliance */
  options: { uid: number; value: unknown }[];
  /** As shown to people: key → value */
  readable: Record<string, unknown>;
}

const NAMED_OPTIONS: Array<{ param: keyof StartInput; tail: string; convert?: (v: unknown) => unknown }> = [
  { param: "temperature", tail: "SetpointTemperature" },
  { param: "duration_minutes", tail: "Option.Duration", convert: (v) => Math.round(Number(v) * 60) },
  { param: "fast_preheat", tail: "FastPreHeat" },
  { param: "start_in_minutes", tail: "StartInRelative", convert: (v) => Math.round(Number(v) * 60) },
];

/** The option list for starting `program` from the named parameters plus free options (keys or names, enum names allowed). */
export function buildProgramOptions(profile: Profile, program: Feature, input: StartInput): BuiltOptions | { error: string } {
  const allowed = program.options?.map((o) => o.uid) ?? [];
  const out: BuiltOptions = { options: [], readable: {} };
  const wanted: Array<{ uid: number; feature: Feature; raw: unknown }> = [];

  for (const named of NAMED_OPTIONS) {
    const v = input[named.param];
    if (v === undefined || v === null) continue;
    const hit = featureByTail(profile, named.tail, "option", allowed);
    if (!hit) return { error: `${program.key}: this appliance has no ${named.param} option` };
    wanted.push({ uid: hit.uid, feature: hit.feature, raw: named.convert ? named.convert(v) : v });
  }
  for (const [k, v] of Object.entries(input.options ?? {})) {
    const r = findFeature(profile, k, ["option"]);
    if (!r.feature || r.uid === undefined) return { error: r.error ?? `unknown option ${k}` };
    if (wanted.some((w) => w.uid === r.uid)) continue;
    wanted.push({ uid: r.uid, feature: r.feature, raw: v });
  }

  // A program that lists options takes only those; one that lists none (a
  // favourite saved on the appliance) gets what was asked and the appliance decides.
  for (const w of wanted) {
    if (allowed.length && !allowed.includes(w.uid)) {
      const takes = allowed.map((u) => profile.features[String(u)]?.key ?? String(u)).join(", ");
      return { error: `${program.key} does not take ${w.feature.key}; it takes: ${takes}` };
    }
    const enc = encodeValue(w.feature, w.raw);
    if ("error" in enc) return enc;
    out.options.push({ uid: w.uid, value: enc.value });
    out.readable[w.feature.key] = decodeValue(profile, w.feature, enc.value);
  }
  return out;
}

/** A program with what it takes, for listing. */
export function describeProgram(profile: Profile, feature: Feature, withOptions: boolean): Record<string, unknown> {
  const d: Record<string, unknown> = { program: feature.key, category: programCategory(feature.name) };
  if (feature.available === false) d.available = false;
  if (withOptions && feature.options?.length) {
    d.options = feature.options
      .filter((o) => o.access === "readWrite" || o.access === "writeOnly")
      .map((o) => {
        const f = profile.features[String(o.uid)];
        const od: Record<string, unknown> = { option: f?.key ?? String(o.uid) };
        if (f?.min !== undefined) od.min = f.min;
        if (f?.max !== undefined) od.max = f.max;
        if (f?.step !== undefined) od.step = f.step;
        if (f?.values) od.values = Object.values(f.values);
        if (o.default !== undefined) {
          const raw = /^(true|false)$/i.test(o.default) ? o.default.toLowerCase() === "true" : isNaN(Number(o.default)) ? o.default : Number(o.default);
          od.default = f ? decodeValue(profile, f, raw) : raw;
        }
        return od;
      });
  }
  return d;
}
