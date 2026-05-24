import crypto from "crypto";

const ALGO = "aes-256-gcm";
const IV_LEN = 12;

function getKey() {
  const raw = process.env.PAYMENT_FORM_ENCRYPTION_KEY || "";
  if (!raw) return null;
  return crypto.createHash("sha256").update(raw).digest();
}

export function decryptField(stored) {
  if (stored == null || stored === "") return null;
  if (typeof stored === "object" && stored.encrypted === false) {
    return stored.value;
  }
  const payload =
    typeof stored === "object" && stored.value != null ? stored.value : stored;
  const key = getKey();
  if (!key) return typeof payload === "string" ? payload : null;
  try {
    const buf = Buffer.from(String(payload), "base64");
    const iv = buf.subarray(0, IV_LEN);
    const tag = buf.subarray(IV_LEN, IV_LEN + 16);
    const data = buf.subarray(IV_LEN + 16);
    const decipher = crypto.createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString(
      "utf8",
    );
  } catch {
    return null;
  }
}
