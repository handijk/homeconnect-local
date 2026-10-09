# homeconnect-local

Home Connect appliances (Bosch, Siemens, Neff, Gaggenau, …) over their **local**
protocol, in TypeScript for Node.js. No developer account, no request quota, no
cloud in the loop once the appliance is known: the appliance talks to you on
the LAN, in real time, the way it talks to the Home Connect app.

What it does:

- **account** – the login a person does once (OAuth code flow with PKCE against
  the app's client id, as [hcpy](https://github.com/hcpy2-0/hcpy) does it), the
  paired appliances of that account, each appliance's local key, and its
  *profile*: the two XML files that say which statuses, settings, programs and
  options this exact appliance has.
- **profile** – that profile parsed into something to work with: short stable
  keys (`hot_air`, `power_state`), enum names, the options a program takes with
  their ranges, and resolution of whatever a person typed to the right program.
- **protocol** – the local session to one appliance: a TLS-PSK websocket with
  the appliance's key, request/reply by message id, value and program events.
- **appliance** – operations on an appliance: start a program by name, key or
  favourite with checked options, stop/pause/resume, change a setting, list
  programs, and keep the reported state up to date (favourite slots included).

Nothing here publishes to MQTT or knows any particular home automation system;
that is what a bridge or an integration on top of this package does.

## Status

0.1: what runs a Siemens oven in one household since mid 2026, extracted into
a package. Honest limits:

- **TLS-PSK only.** Older appliances use TLS-PSK on port 443; newer ones use
  AES-CBC with HMAC-SHA256 on port 80. The `aes` key type is declared and not
  implemented yet; a tester with such an appliance is wanted.
- **The TLS-PSK socket runs in a small Node subprocess** (`bridge/psk-bridge.mjs`),
  because the package also runs under Bun, where TLS-PSK is not available.
  Opening it in-process on Node is planned.
- Tested against one oven's profile; other appliance types may expose shapes
  the profile parser has not seen.

## Install

```
npm install homeconnect-local
```

Node 20 or newer. Runs under Bun as well.

## Use

Log in once and keep what comes back:

```ts
import { beginLogin, parseAuthCode, exchangeCode, fetchAppliances } from "homeconnect-local";

const login = beginLogin();
console.log("open this and log in:", login.url);
// The browser ends on a page that does not load, with a URL like
// hcauth://auth/prod?code=…&state=… — paste that URL (or just the code) back:
const code = parseAuthCode(await ask("paste the URL or code"));
const token = await exchangeCode(login.verifier, code);

// Every paired appliance with its local key and parsed profile, plus the raw XML
// (keep both: a parser update re-reads the XML without a new login).
const { configs, xml } = await fetchAppliances(console.log, token);
```

Talk to an appliance:

```ts
import { HomeConnectDevice, startProgram, applyStateUpdates, applyProgramUpdate, listPrograms } from "homeconnect-local";

const config = configs[0];
const device = new HomeConnectDevice({ host: config.host, ip: "192.168.1.50", key: config.key, keyType: config.keyType });
const app = { config: { name: config.name, profile: config.profile }, device, state: {}, favorites: new Map() };

device.on("state", (updates) => { const { changed } = applyStateUpdates(app, updates); console.log(changed, app.state); });
device.on("program", (p) => applyProgramUpdate(app, p));
device.on("log", console.log);
await device.connect();

console.log(listPrograms(app, "heating_modes", undefined));
console.log(await startProgram(app, "hot air", { temperature: 180, duration_minutes: 30 }));
```

`startProgram` checks the options against the profile (range, step, enum
names), refuses when the appliance is not connected or remote start is off,
switches the appliance on when it is in standby, and reports the appliance's
own answer when it refuses.

The appliance's IP is yours to find (mDNS, your router, or a fixed address);
the package does not do discovery.

## Releases

A version is a tag `v<version>` on `main`; GitHub Actions runs the tests and
publishes it to npm through npm's trusted publishing, with a provenance
statement. `npm audit signatures` in a project that depends on this package
verifies that what was installed is what that workflow built.

## Credits

The protocol, the profile format and the login were worked out by the authors
of [hcpy](https://github.com/hcpy2-0/hcpy) (Python),
[ioBroker.cloudless-homeconnect](https://github.com/eifel-tech/ioBroker.cloudless-homeconnect)
(JavaScript, both transports) and bruestel's
[Home Connect Profile Downloader](https://github.com/bruestel/homeconnect-profile-downloader).
This package is a TypeScript client built on their findings.

## License

MIT
