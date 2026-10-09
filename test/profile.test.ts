// The appliance profile Home Connect hands out, read into what the oven
// tools work with: short keys that stay unique, enum names, which options a
// program takes with their ranges, a favourite found by the name it was saved
// under, and the option list a start message carries.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseProfile, findFeature, decodeValue, encodeValue, buildProgramOptions, describeProgram, programCategory, PROFILE_VERSION,
} from "../src/profile.ts";
import { test } from "node:test";

const fail = (what: string, extra?: unknown): never => { throw new Error(`${what}: ${JSON.stringify(extra, null, 1)}`); };
const finish = (_result: unknown): void => {};

test("the appliance profile: keys, kinds, enums, options, resolution, encoding, listing", async () => {
  const fixtures = join(import.meta.dirname, "fixtures");
  const profile = parseProfile(
    readFileSync(join(fixtures, "DeviceDescription.xml"), "utf-8"),
    readFileSync(join(fixtures, "FeatureMapping.xml"), "utf-8"),
  );
  const f = (uid: number) => profile.features[String(uid)] ?? fail(`no feature ${uid}`, { keys: Object.keys(profile.features) });
  const same = (what: string, got: unknown, want: unknown) => {
    if (JSON.stringify(got) !== JSON.stringify(want)) fail(what, { got, want });
  };

  // The profile itself
  same("version", profile.version, PROFILE_VERSION);
  same("info", profile.info.brand, "SIEMENS");
  same("fullOptionSet", profile.fullOptionSet, false);
  same("features", Object.keys(profile.features).length, 31);

  // Keys: short where unique, the numbered tail where there is one, deduplicated otherwise
  same("hot_air", f(8208).key, "hot_air");
  same("keep warm (heating mode)", f(8229).key, "heating_mode_keep_warm");
  same("keep warm (subsequent mode)", f(10244).key, "subsequent_mode_keep_warm");
  same("favourite program", f(32828).key, "favorite_001");
  same("favourite name", f(32825).key, "favorite_001_name");
  same("dish", f(12893).key, "beetroot_whole_steam");
  same("operation_state", f(552).key, "operation_state");
  same("cavity operation_state", f(6083).key, "cavity_001_operation_state");
  same("cavity temperature", f(6084).key, "cavity_001_current_temperature");
  same("power_state", f(539).key, "power_state");
  same("duration", f(548).key, "duration");
  same("cavity duration (mapping only)", f(2050).key, "cavity_001_duration");
  same("mapping-only kind", f(2050).kind, "other");
  same("remote start", f(517).key, "remote_control_start_allowed");
  same("fast preheat", f(5123).key, "fast_pre_heat");

  // Kinds, access, ranges, enums (a subset enum takes its names from its parent)
  same("kinds", [f(552).kind, f(539).kind, f(5120).kind, f(512).kind, f(21).kind, f(8208).kind], ["status", "setting", "option", "command", "event", "program"]);
  same("access", [f(552).access, f(539).access, f(15).access, f(512).access], ["read", "readWrite", "read", "writeOnly"]);
  same("range", [f(5120).min, f(5120).max, f(5120).step, f(5120).default], [30, 300, 5, "160"]);
  same("power_state enum (subset)", f(539).values, { "2": "On", "3": "Standby" });
  same("operation_state enum", f(552).values?.["3"], "Run");
  same("event enum", f(21).values?.["1"], "Present");
  same("steam level enum", f(5125).values?.["3"], "High");
  same("execution", f(8208).execution, "selectAndStart");
  same("enum type, also for a subset", [f(552).enumType, f(539).enumType, f(21).enumType], ["BSH.Common.EnumType.OperationState", "BSH.Common.EnumType.PowerState", "BSH.Common.EnumType.EventPresentState"]);

  // A program's options, nested in the description
  same("hot_air options", f(8208).options, [
    { uid: 5120, access: "readWrite", default: "160" },
    { uid: 548, access: "readWrite" },
    { uid: 5123, access: "readWrite", default: "false" },
    { uid: 544, access: "read" },
  ]);
  same("favourite without options", f(32828).options, []);

  // Live values as the state shows them
  same("decode enum", decodeValue(profile, f(552), 3), "Run");
  same("decode active program (root)", decodeValue(profile, f(256), 8208), "hot_air");
  same("decode active program (cavity)", decodeValue(profile, f(6080), 12893), "beetroot_whole_steam");
  same("decode favourite program", decodeValue(profile, f(32826), 8208), "hot_air");
  same("decode boolean", decodeValue(profile, f(517), true), true);
  same("decode unknown enum value", decodeValue(profile, f(552), 42), 42);
  same("decode number", decodeValue(profile, f(6084), 182.5), 182.5);

  // Finding a program by whatever was typed
  const uidOf = (q: string, aliases?: Map<string, number>) => findFeature(profile, q, ["program"], aliases);
  same("by key", uidOf("hot_air").uid, 8208);
  same("by words", uidOf("hot air").uid, 8208);
  same("by last segment", uidOf("HotAir").uid, 8208);
  same("by full name", uidOf("Cooking.Oven.Program.HeatingMode.HotAir").uid, 8208);
  same("by uid", uidOf("8208").uid, 8208);
  same("by part of the key", uidOf("beetroot").uid, 12893);
  const ambiguous = uidOf("keep warm");
  if (ambiguous.uid !== undefined || !ambiguous.candidates?.includes("heating_mode_keep_warm") || !ambiguous.candidates?.includes("subsequent_mode_keep_warm")) fail("keep warm should be ambiguous", { ambiguous });
  const unknown = uidOf("rode bietjes");
  if (unknown.uid !== undefined || !unknown.error) fail("a Dutch favourite name is unknown without the favourites", { unknown });
  same("favourite by its saved name", uidOf("Rode bietjes", new Map([["rode bietjes", 32828]])).uid, 32828);
  same("a setting is not a program", uidOf("power_state").uid, undefined);
  same("a setting by key", findFeature(profile, "power_state", ["setting"]).uid, 539);

  // What a start message carries
  const hotAir = f(8208), beetroot = f(12893);
  same("named options", buildProgramOptions(profile, hotAir, { temperature: 180, duration_minutes: 40, fast_preheat: true }), {
    options: [{ uid: 5120, value: 180 }, { uid: 548, value: 2400 }, { uid: 5123, value: true }],
    readable: { setpoint_temperature: 180, duration: 2400, fast_pre_heat: true },
  });
  same("no options", buildProgramOptions(profile, hotAir, {}), { options: [], readable: {} });
  const low = buildProgramOptions(profile, hotAir, { temperature: 25 });
  if (!("error" in low) || !/below the minimum 30/.test(low.error)) fail("25 °C should be refused", { low });
  const odd = buildProgramOptions(profile, hotAir, { temperature: 183 });
  if (!("error" in odd) || !/multiple of 5/.test(odd.error)) fail("183 °C should be refused", { odd });
  const notForThis = buildProgramOptions(profile, hotAir, { options: { steam_assist_level: "High" } });
  if (!("error" in notForThis) || !/does not take steam_assist_level/.test(notForThis.error)) fail("steam on hot air should be refused", { notForThis });
  same("enum option by name", buildProgramOptions(profile, beetroot, { options: { steam_assist_level: "high" }, start_in_minutes: 10 }), {
    options: [{ uid: 558, value: 600 }, { uid: 5125, value: 3 }],
    readable: { start_in_relative: 600, steam_assist_level: "High" },
  });
  const badEnum = buildProgramOptions(profile, beetroot, { options: { steam_assist_level: "Extreme" } });
  if (!("error" in badEnum) || !/expected one of Off, Low, Medium, High/.test(badEnum.error)) fail("an unknown enum name should be refused", { badEnum });
  const noSuch = buildProgramOptions(profile, hotAir, { options: { frobnicate: 1 } });
  if (!("error" in noSuch)) fail("an unknown option should be refused", { noSuch });
  same("a favourite lists no options: what was asked goes through, the appliance decides", buildProgramOptions(profile, f(32828), { temperature: 180 }), {
    options: [{ uid: 5120, value: 180 }],
    readable: { setpoint_temperature: 180 },
  });

  // Values for settings
  same("enum by name", encodeValue(f(539), "on"), { value: 2 });
  same("enum by key", encodeValue(f(539), "standby"), { value: 3 });
  same("enum by number", encodeValue(f(539), 3), { value: 3 });
  const badPower = encodeValue(f(539), "Sleep");
  if (!("error" in badPower)) fail("Sleep is not a power state", { badPower });
  same("boolean from text", encodeValue(f(524), "true"), { value: true });
  same("number from text", encodeValue(f(548), "1800"), { value: 1800 });
  const tooLong = encodeValue(f(548), 90000);
  if (!("error" in tooLong)) fail("90000 s is above the maximum", { tooLong });

  // Listing
  same("category", [programCategory(hotAir.name), programCategory(beetroot.name), programCategory(f(32828).name), programCategory(f(10244).name)], ["heating_modes", "dishes", "favorites", "other"]);
  same("described", describeProgram(profile, hotAir, true), {
    program: "hot_air", category: "heating_modes",
    options: [
      { option: "setpoint_temperature", min: 30, max: 300, step: 5, default: 160 },
      { option: "duration", min: 0, max: 86340, step: 60 },
      { option: "fast_pre_heat", default: false },
    ],
  });
  same("described without options", describeProgram(profile, hotAir, false), { program: "hot_air", category: "heating_modes" });

  finish({ features: Object.keys(profile.features).length, programs: Object.values(profile.features).filter((x) => x.kind === "program").length });
});
