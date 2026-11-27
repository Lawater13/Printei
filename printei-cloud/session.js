import { DurableObject } from "cloudflare:workers";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const maxAge = 24 * 60 * 60 * 1000;

export function tokenClaims(token) {
  try {
    const payload = token.split(".")[1].replaceAll("-", "+").replaceAll("_", "/");
    return JSON.parse(atob(payload));
  } catch {
    return {};
  }
}

async function encryptionKey(secret) {
  if (!/^[0-9a-f]{64}$/i.test(secret ?? "")) throw new Error("Invalid session key");
  const bytes = Uint8Array.from(secret.match(/../g), hex => parseInt(hex, 16));
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export class BambuSession extends DurableObject {
  async save(session) {
    const now = Date.now();
    const exp = tokenClaims(session.token)?.exp;
    const expiresAt = Number.isFinite(exp) ? Math.min(now + maxAge, exp * 1000) : now + maxAge;
    if (expiresAt <= now) throw new Error("Expired session");
    const key = await encryptionKey(this.env.PRINTEI_SESSION_KEY);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key,
      encoder.encode(JSON.stringify({ ...session, expiresAt })));
    await this.ctx.storage.transaction(async storage => {
      await storage.put("session", { expiresAt, iv, ciphertext });
      await storage.setAlarm(expiresAt);
    });
  }

  async load() {
    const record = await this.ctx.storage.get("session");
    if (!record || record.expiresAt <= Date.now()) return null;
    const key = await encryptionKey(this.env.PRINTEI_SESSION_KEY);
    const bytes = await crypto.subtle.decrypt({ name: "AES-GCM", iv: record.iv }, key, record.ciphertext);
    const session = JSON.parse(decoder.decode(bytes));
    return session.expiresAt > Date.now() ? session : null;
  }

  async clear() {
    await this.ctx.storage.transaction(async storage => {
      await storage.delete("session");
      await storage.deleteAlarm();
    });
  }

  async alarm() {
    await this.ctx.storage.transaction(async storage => {
      const record = await storage.get("session");
      if (record && record.expiresAt <= Date.now()) await storage.delete("session");
    });
  }
}
