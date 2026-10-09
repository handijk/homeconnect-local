// homeconnect-local: Home Connect appliances over their local protocol.
//
//   account   the login (OAuth code flow with PKCE), the paired appliances of
//             an account, each one's local key and profile
//   profile   the appliance's profile: statuses, settings, programs and the
//             options each program takes, with name and key resolution
//   protocol  the local session to one appliance (TLS-PSK websocket)
//   appliance operations on an appliance: start a program by name with
//             checked options, stop/pause/resume, settings, program listing,
//             and keeping the reported state up to date
export * from "./account.ts";
export * from "./profile.ts";
export * from "./protocol.ts";
export * from "./appliance.ts";
