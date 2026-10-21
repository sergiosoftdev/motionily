import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/** A secret encrypted at rest (AES-256-GCM), as stored in Mongo. */
export type Sealed = { iv: string; tag: string; data: string };

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;

/** 32-byte key from SECRETS_KEY (falls back to JWT_SECRET so development works without setup). */
function key() {
  return createHash("sha256")
    .update(process.env.SECRETS_KEY ?? process.env.JWT_SECRET ?? "dev-only-secret")
    .digest();
}

export function seal(plain: string): Sealed {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key(), iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return { iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") };
}

export function unseal(s: Sealed): string {
  const decipher = createDecipheriv(ALGORITHM, key(), Buffer.from(s.iv, "base64"));
  decipher.setAuthTag(Buffer.from(s.tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(s.data, "base64")), decipher.final()]).toString("utf8");
}
