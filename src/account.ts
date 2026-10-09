// The Home Connect account: the login (OAuth code flow with PKCE against
// the app's client id, the way hcpy does it), the paired appliances of the
// account, each one's local key, and its profile as a zip of two XML files.
// Nothing here knows about MQTT or StateBridge; the caller shows the URL to a
// person and hands the code back.
import { createHash, randomBytes } from "node:crypto";
import { unzipSync } from "fflate";
import { PROFILE_VERSION, parseProfile, type Profile } from "./profile.ts";

export interface ApplianceConfig {
  version: number;
  name: string;
  brand: string;
  type: string;
  identifier: string;
  host: string;
  key: string;
  keyType: "tls" | "aes";
  /** The appliance's iv; AES appliances only. */
  iv?: string;
  profile: Profile;
}

export interface ProfileXml {
  deviceDescription: string;
  featureMapping: string;
}

const CLIENT_ID = "9B75AC9EC512F36C84256AC47D813E2C1DD0D6520DF774B020E1E6E2EB29B1F3";
const REDIRECT_URI = "hcauth://auth/prod";
const AUTH_BASE = "https://api.home-connect.com/security/oauth";
// The account API per region, as the Home Connect app and hcpy use it now;
// the old prod.{reu,rna}.rest.homeconnectegw.com/account/details answers
// 404. The first region that knows the account is used.
const API_ENDPOINTS = [
  "https://eu.services.home-connect.com",
  "https://na.services.home-connect.com",
];

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

/** The authorize URL for a person to open, and what the code exchange needs afterwards. */
export interface Login {
  url: string;
  verifier: string;
  state: string;
}

export function beginLogin(): Login {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  const nonce = base64url(randomBytes(16));
  const state = base64url(randomBytes(16));
  const url = `${AUTH_BASE}/authorize?` +
    `response_type=code&prompt=login` +
    `&code_challenge=${challenge}&code_challenge_method=S256` +
    `&client_id=${CLIENT_ID}` +
    `&scope=ReadOrigApi` +
    `&nonce=${nonce}&state=${state}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`;
  return { url, verifier, state };
}

/** The code as a person pastes it: bare, as JSON with a code field, or the whole hcauth://auth/prod?code=… URL. */
export function parseAuthCode(input: string): string {
  let raw = input.trim();
  try { const p = JSON.parse(raw); if (p && typeof p === "object" && p.code) raw = String(p.code); } catch { /* not JSON */ }
  // Full hcauth://auth/prod?code=…&state=… URL also accepted.
  const m = /[?&]code=([^&\s]+)/.exec(raw);
  if (m) raw = m[1];
  return decodeURIComponent(raw);
}

/** The access token for a code the person brought back. */
export async function exchangeCode(verifier: string, code: string): Promise<string> {
  const res = await fetch(`${AUTH_BASE}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code_verifier: verifier,
      code,
      redirect_uri: REDIRECT_URI,
    }),
  });
  if (!res.ok) throw new Error(`Token exchange failed: ${await res.text()}`);
  const { access_token: token } = await res.json() as { access_token: string };
  return token;
}

/**
 * The entries of a zip, by its central directory (as Python's ZipFile and so
 * hcpy read it: the local headers of a streamed zip carry no sizes). A
 * document that is not a zip throws; directories are skipped.
 */
export function parseZip(buf: Buffer): Record<string, Buffer> {
  const entries = unzipSync(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength), { filter: (f) => !f.name.endsWith("/") });
  const files: Record<string, Buffer> = {};
  for (const [name, data] of Object.entries(entries)) files[name] = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return files;
}

/** The account's subject (`sub`) from the access token, a JWT. */
export function tokenSubject(token: string): string {
  const payload = token.split(".")[1];
  if (!payload) throw new Error("Access token is not a JWT; no account id in it");
  const sub = (JSON.parse(Buffer.from(payload, "base64url").toString("utf-8")) as { sub?: string }).sub;
  if (!sub) throw new Error("Access token has no sub (account id)");
  return sub;
}

/**
 * The paired appliances of the account behind `token`, each with its local
 * key and its profile (downloaded as a zip with the two XML files).
 */
export async function fetchAppliances(
  log: (msg: string) => void,
  token: string,
): Promise<{ configs: ApplianceConfig[]; xml: Record<string, ProfileXml> }> {
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/json" };
  const subject = tokenSubject(token);

  let endpoint = "";
  let found: Array<{ haId: string; brand?: string; haType?: string }> = [];
  for (const candidate of API_ENDPOINTS) {
    log(`Fetching appliances from ${candidate}`);
    const res = await fetch(`${candidate}/api/account/v2/accounts/${encodeURIComponent(subject)}/paired-appliances`, { headers });
    log(`Response: ${res.status} ${res.statusText}`);
    if (!res.ok) continue;
    try {
      const data = await res.json() as { appliances?: typeof found };
      found = (data.appliances ?? []).filter((a) => a?.haId);
      log(`Found ${found.length} appliance(s)`);
      if (found.length > 0) { endpoint = candidate; break; }
    } catch (err) {
      log(`Failed to parse response: ${err}`);
    }
  }
  if (!found.length) throw new Error("No appliances found on account");

  const configs: ApplianceConfig[] = [];
  const xml: Record<string, ProfileXml> = {};
  for (const appliance of found) {
    const id = appliance.haId;
    const brand = appliance.brand ?? "Unknown";
    const type = appliance.haType ?? "Unknown";
    const label = `${brand} ${type}`;

    const encRes = await fetch(`${endpoint}/api/appliance/v2/appliances/${encodeURIComponent(id)}/encryption-information`, { headers });
    if (!encRes.ok) { log(`${label}: no encryption information (${encRes.status} ${encRes.statusText}); skipped`); continue; }
    const enc = await encRes.json() as { tls?: { key?: string }; aes?: { key?: string; iv?: string } };
    const key = enc.tls?.key || enc.aes?.key || "";
    if (!key) { log(`${label}: encryption information without a key; skipped`); continue; }

    let profileXml: ProfileXml | null = null;
    let lastError = "";
    try {
      const zipRes = await fetch(`${endpoint}/api/iddf/v1/iddf/${encodeURIComponent(id)}`, { headers: { Authorization: headers.Authorization } });
      const body = Buffer.from(await zipRes.arrayBuffer());
      const what = `${zipRes.status} ${zipRes.statusText}, ${zipRes.headers.get("content-type") ?? "no content-type"}, ${body.length} bytes`;
      log(`${label}: profile download ${what}`);
      if (!zipRes.ok) {
        lastError = `${what}: ${body.toString("utf-8", 0, 300)}`;
      } else if (body.length < 4 || body.readUInt32LE(0) !== 0x04034b50) {
        lastError = `not a zip (${what}): ${body.toString("utf-8", 0, 300)}`;
      } else {
        const files = parseZip(body);
        const names = Object.keys(files);
        // hcpy reads <haId>_DeviceDescription.xml and <haId>_FeatureMapping.xml;
        // matched case-insensitively and with or without a directory in front.
        const pick = (part: string) => {
          const lower = names.map((f) => f.toLowerCase());
          const exact = lower.findIndex((f) => f.endsWith(`${id}_${part}.xml`.toLowerCase()));
          const loose = lower.findIndex((f) => f.includes(part.toLowerCase()) && f.endsWith(".xml"));
          const i = exact >= 0 ? exact : loose;
          return i >= 0 ? names[i] : undefined;
        };
        const dd = pick("DeviceDescription");
        const fm = pick("FeatureMapping");
        if (!dd || !fm) lastError = `profile zip without ${!dd ? "DeviceDescription" : "FeatureMapping"} (entries: ${names.join(", ") || "none readable"}; ${what})`;
        else profileXml = { deviceDescription: files[dd].toString("utf-8"), featureMapping: files[fm].toString("utf-8") };
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    if (!profileXml) { log(`${label}: no profile (${lastError}); skipped`); continue; }

    const profile = parseProfile(profileXml.deviceDescription, profileXml.featureMapping);
    const programs = Object.values(profile.features).filter((f) => f.kind === "program").length;
    log(`${label}: profile with ${Object.keys(profile.features).length} features, ${programs} programs`);
    xml[id] = profileXml;
    configs.push({
      version: PROFILE_VERSION,
      name: type.toLowerCase(),
      brand,
      type,
      identifier: id,
      host: `${brand}-${type}-${id}`,
      key,
      keyType: enc.tls?.key ? "tls" : "aes",
      ...(enc.tls?.key ? {} : { iv: enc.aes?.iv }),
      profile,
    });
  }
  return { configs, xml };
}
