// The framing of the AES transport (newer appliances, ws://<ip>:80), as hcpy's
// HCSocket and ioBroker.cloudless-homeconnect's Socket do it:
//
// - keys from the appliance's PSK: enc = HMAC-SHA256(psk, "ENC"), mac = HMAC-SHA256(psk, "MAC")
// - AES-256-CBC with the appliance's iv, one chained cipher stream per direction
//   for the life of the connection (no re-keying per message)
// - padding: 0x00, random bytes, then the pad length as the last byte; one extra
//   block when the text already ends one byte short of a block
// - after the ciphertext, 16 bytes of HMAC-SHA256(mac, iv + direction + previous hmac + ciphertext),
//   chained: each message's hmac feeds the next; direction "E" for what the client
//   sends, "C" for what the appliance sends
//
// A role of "appliance" swaps the directions, so the same class is the other end
// (a fake appliance in a test).
import { createCipheriv, createDecipheriv, createHmac, randomBytes, type Cipheriv, type Decipheriv } from "node:crypto";

export type AesRole = "client" | "appliance";

const hmac = (key: Buffer, data: Buffer) => createHmac("sha256", key).update(data).digest();

export class AesChannel {
  private readonly cipher: Cipheriv;
  private readonly decipher: Decipheriv;
  private readonly macKey: Buffer;
  private readonly txDirection: Buffer;
  private readonly rxDirection: Buffer;
  private readonly iv: Buffer;
  private lastTx: Buffer = Buffer.alloc(16);
  private lastRx: Buffer = Buffer.alloc(16);

  constructor(psk: Buffer, iv: Buffer, role: AesRole = "client") {
    this.iv = iv;
    const encKey = hmac(psk, Buffer.from("ENC"));
    this.macKey = hmac(psk, Buffer.from("MAC"));
    this.cipher = createCipheriv("aes-256-cbc", encKey, iv);
    this.cipher.setAutoPadding(false);
    this.decipher = createDecipheriv("aes-256-cbc", encKey, iv);
    this.decipher.setAutoPadding(false);
    this.txDirection = Buffer.from(role === "client" ? "E" : "C");
    this.rxDirection = Buffer.from(role === "client" ? "C" : "E");
  }

  private mac(direction: Buffer, previous: Buffer, ciphertext: Buffer): Buffer {
    return hmac(this.macKey, Buffer.concat([this.iv, direction, previous, ciphertext])).subarray(0, 16);
  }

  /** One text message as the frame to send. */
  encrypt(text: string): Buffer {
    const plain = Buffer.from(text, "utf8");
    let padLength = 16 - (plain.length % 16);
    if (padLength === 1) padLength += 16;
    const padded = Buffer.concat([plain, Buffer.from([0]), randomBytes(padLength - 2), Buffer.from([padLength])]);
    const ciphertext = this.cipher.update(padded);
    this.lastTx = this.mac(this.txDirection, this.lastTx, ciphertext);
    return Buffer.concat([ciphertext, this.lastTx]);
  }

  /**
   * The text of a received frame, or null when its hmac does not match: the
   * channel is then out of step with the other side, and only a new
   * connection brings it back.
   */
  decrypt(frame: Buffer): string | null {
    if (frame.length < 32 || frame.length % 16 !== 0) return null;
    const ciphertext = frame.subarray(0, -16);
    const theirs = frame.subarray(-16);
    const ours = this.mac(this.rxDirection, this.lastRx, ciphertext);
    if (!theirs.equals(ours)) return null;
    this.lastRx = Buffer.from(theirs);
    const padded = this.decipher.update(ciphertext);
    const padLength = padded[padded.length - 1];
    if (padLength < 2 || padLength > padded.length) return null;
    return padded.subarray(0, padded.length - padLength).toString("utf8");
  }
}

/** The bytes of a key or iv as the account API hands them out (base64url, unpadded). */
export function keyBytes(encoded: string): Buffer {
  return Buffer.from(encoded + "==", "base64url");
}
