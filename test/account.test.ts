// After the login, the appliances come from the account API: the paired
// appliances of the account named in the access token, each appliance's key
// from its encryption information, and its profile as a zip of the two XML
// files. The old prod.reu/prod.rna …/account/details answers 404, so a
// fetch that still goes there finds no appliance.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fetchAppliances, beginLogin, exchangeCode, parseAuthCode } from "../src/account.ts";
import { PROFILE_VERSION } from "../src/profile.ts";
import { test } from "node:test";

const fail = (what: string, extra?: unknown): never => { throw new Error(`${what}: ${JSON.stringify(extra, null, 1)}`); };
const finish = (_result: unknown): void => {};

test("the account: paired appliances, keys, profile zips, errors, and the login", async () => {
  const fixtures = join(import.meta.dirname, "fixtures");
  const dd = readFileSync(join(fixtures, "DeviceDescription.xml"));
  const fm = readFileSync(join(fixtures, "FeatureMapping.xml"));
  const HA_ID = "SIEMENS-HB000000000-68A40E000000";
  const SUB = "acc-1234";

  // The profile zips are what Python's zipfile writes (test/fixtures/homeconnect/profile-*.zip,
  // made on 2026-10-09): stored entries, and the streamed shape the Home Connect API sends, with
  // flag bit 3, sizes 0 in the local headers and the real ones only in the data descriptors and the
  // central directory.
  const storedZip = readFileSync(join(fixtures, "profile-stored.zip"));
  const streamedZip = readFileSync(join(fixtures, "profile-streamed.zip"));

  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const token = `${b64({ alg: "RS256" })}.${b64({ sub: SUB })}.sig`;

  let profileBody: () => Response = () => new Response(new Uint8Array(storedZip));
  const calls: string[] = [];
  const fakeFetch = (async (input: any, init?: any) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    calls.push(`${url.host}${url.pathname}`);
    if (url.host === "api.home-connect.com" && url.pathname === "/security/oauth/token") {
      const form = new URLSearchParams(String(init?.body ?? ""));
      const ok = form.get("grant_type") === "authorization_code" && form.get("code") === "good-code" && !!form.get("code_verifier") && form.get("redirect_uri") === "hcauth://auth/prod";
      return ok ? Response.json({ access_token: token, token_type: "Bearer" }) : new Response("invalid_grant", { status: 400 });
    }
    if (init?.headers?.Authorization !== `Bearer ${token}`) return new Response("no token", { status: 401 });
    // The account is in the EU region only
    if (url.host !== "eu.services.home-connect.com") return new Response("", { status: 404 });
    switch (url.pathname) {
      case `/api/account/v2/accounts/${SUB}/paired-appliances`:
        return Response.json({ appliances: [{ haId: HA_ID, brand: "SIEMENS", haType: "Oven", vib: "HB000000000" }] });
      case `/api/appliance/v2/appliances/${HA_ID}/encryption-information`:
        return Response.json({ tls: { key: "psk-key" } });
      case `/api/iddf/v1/iddf/${HA_ID}`:
        return profileBody();
    }
    return new Response("", { status: 404 });
  }) as typeof fetch;
  globalThis.fetch = fakeFetch;

  const log: string[] = [];
  const { configs, xml } = await fetchAppliances((m) => log.push(m), token);

  if (configs.length !== 1) fail("one appliance", { configs, log, calls });
  const c = configs[0];
  const want = { version: PROFILE_VERSION, name: "oven", brand: "SIEMENS", type: "Oven", identifier: HA_ID, host: `SIEMENS-Oven-${HA_ID}`, key: "psk-key", keyType: "tls" };
  for (const [k, v] of Object.entries(want)) {
    if ((c as any)[k] !== v) fail(`config.${k}`, { got: (c as any)[k], want: v });
  }
  if (Object.keys(c.profile.features).length !== 31) fail("profile parsed", { features: Object.keys(c.profile.features).length });
  if (xml[HA_ID]?.deviceDescription !== dd.toString("utf-8") || xml[HA_ID]?.featureMapping !== fm.toString("utf-8")) fail("raw XML kept", { keys: Object.keys(xml) });
  if (calls.some((u) => u.includes("homeconnectegw") || u.includes("/account/details"))) fail("old endpoint used", { calls });

  // The real profile is a streamed zip (data descriptors, sizes only in the
  // central directory); reading the local headers alone found no entry at all.
  profileBody = () => new Response(new Uint8Array(streamedZip), { headers: { "content-type": "application/zip" } });
  const streamed = await fetchAppliances(() => {}, token);
  if (streamed.configs.length !== 1 || Object.keys(streamed.configs[0].profile.features).length !== 31) fail("streamed zip", { configs: streamed.configs.length });
  if (streamed.xml[HA_ID]?.deviceDescription !== dd.toString("utf-8")) fail("streamed zip raw XML", { keys: Object.keys(streamed.xml) });

  // A body that is not a zip (an error JSON) is logged with status, type and content
  profileBody = () => Response.json({ error: { key: "SDK.Error.NoIddf", description: "no iddf" } });
  const errLog: string[] = [];
  let errorCaught = false;
  try {
    const r = await fetchAppliances((m) => errLog.push(m), token);
    if (r.configs.length) fail("error JSON accepted as profile", { configs: r.configs.length });
  } catch { errorCaught = true; }
  const skipped = errLog.find((m) => m.includes("no profile"));
  if (errorCaught || !skipped?.includes("not a zip") || !skipped.includes("application/json") || !skipped.includes("SDK.Error.NoIddf")) fail("error JSON diagnosed", { errLog });

  // An account with no appliance in any region says so
  globalThis.fetch = (async () => new Response("", { status: 404 })) as unknown as typeof fetch;
  let error = "";
  try { await fetchAppliances(() => {}, token); } catch (err) { error = String(err); }
  if (!error.includes("No appliances found on account")) fail("empty account", { error });

  // A token that is not a JWT says what is wrong instead of asking for a nameless account
  error = "";
  try { await fetchAppliances(() => {}, "opaque"); } catch (err) { error = String(err); }
  if (!error.includes("not a JWT")) fail("opaque token", { error });

  // The login: an authorize URL with PKCE for a person to open, the code as they paste it, the exchange.
  globalThis.fetch = fakeFetch;
  const login = beginLogin();
  const u = new URL(login.url);
  if (u.origin + u.pathname !== "https://api.home-connect.com/security/oauth/authorize") fail("authorize url", { url: login.url });
  if (u.searchParams.get("code_challenge_method") !== "S256" || !u.searchParams.get("code_challenge") || u.searchParams.get("state") !== login.state || u.searchParams.get("redirect_uri") !== "hcauth://auth/prod") fail("authorize parameters", { url: login.url });
  for (const [pasted, want] of [["good-code", "good-code"], [" good-code\n", "good-code"], ['{"code":"good-code","state":"x"}', "good-code"], ["hcauth://auth/prod?code=good%2Dcode&state=x", "good-code"]] as const) {
    if (parseAuthCode(pasted) !== want) fail("parseAuthCode", { pasted, got: parseAuthCode(pasted) });
  }
  if (await exchangeCode(login.verifier, "good-code") !== token) fail("code exchange");
  error = "";
  try { await exchangeCode(login.verifier, "bad-code"); } catch (err) { error = String(err); }
  if (!error.includes("Token exchange failed")) fail("refused exchange", { error });

  finish({ appliances: configs.length, calls });
});
