import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { AesChannel, keyBytes } from "../src/aes.ts";

const key = randomBytes(32).toString("base64url");
const iv = randomBytes(16).toString("base64url");

test("frames round-trip between the client and the appliance roles, chained in both directions", () => {
  const client = new AesChannel(keyBytes(key), keyBytes(iv), "client");
  const appliance = new AesChannel(keyBytes(key), keyBytes(iv), "appliance");
  const texts = [
    JSON.stringify({ sID: 7, msgID: 1, resource: "/ei/initialValues", version: 2, action: "POST" }),
    "x".repeat(15), // one byte short of a block: the padding takes a whole extra block
    "x".repeat(16),
    "",
    JSON.stringify({ data: [{ uid: 5120, value: 180 }], resource: "/ro/values", action: "POST", msgID: 101, sID: 7, version: 1 }),
  ];
  for (const text of texts) {
    const frame = client.encrypt(text);
    assert.equal(frame.length % 16, 0);
    assert.ok(frame.length >= 32);
    assert.equal(appliance.decrypt(frame), text);
    const back = appliance.encrypt(`echo ${text}`);
    assert.equal(client.decrypt(back), `echo ${text}`);
  }
});

test("a tampered or out-of-order frame fails its hmac and yields null", () => {
  const client = new AesChannel(keyBytes(key), keyBytes(iv), "client");
  const appliance = new AesChannel(keyBytes(key), keyBytes(iv), "appliance");
  const first = client.encrypt("one");
  const second = client.encrypt("two");
  const tampered = Buffer.from(second);
  tampered[3] ^= 0xff;
  assert.equal(appliance.decrypt(tampered), null);
  // the second frame before the first: the chain does not match
  assert.equal(appliance.decrypt(second), null);
  assert.equal(appliance.decrypt(first), "one");
});

test("a different iv or key is a different channel", () => {
  const client = new AesChannel(keyBytes(key), keyBytes(iv), "client");
  const other = new AesChannel(keyBytes(key), keyBytes(randomBytes(16).toString("base64url")), "appliance");
  assert.equal(other.decrypt(client.encrypt("hello")), null);
  assert.equal(new AesChannel(keyBytes(randomBytes(32).toString("base64url")), keyBytes(iv), "appliance").decrypt(client.encrypt("hello")), null);
});
