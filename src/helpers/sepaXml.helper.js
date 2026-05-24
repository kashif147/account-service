/** SEPA character set sanitizer (AIB SDD spec). */
const ALLOWED = /^[a-zA-Z0-9/\-?:().,'+ ]*$/;

export function sanitizeSepaText(value, maxLen = 70) {
  if (value == null) return "";
  let s = String(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\x20-\x7E]/g, "")
    .trim();
  s = s.replace(/[^a-zA-Z0-9/\-?:().,'+ ]/g, "");
  if (s.length && !ALLOWED.test(s)) {
    s = s.replace(/[^a-zA-Z0-9/\-?:().,'+ ]/g, "");
  }
  s = s.trim();
  if (s.length > maxLen) s = s.slice(0, maxLen);
  if (s.length && /^[/\-?:().,'+ ]/.test(s)) s = s.slice(1);
  if (s.length && /[/\-?:().,'+ ]$/.test(s)) s = s.slice(0, -1);
  return s;
}

export function sanitizeMsgId(value) {
  return sanitizeSepaText(String(value || "").replace(/\s+/g, "-"), 35);
}

export function normalizeIban(iban) {
  return String(iban || "")
    .replace(/\s+/g, "")
    .toUpperCase();
}

export function escapeXml(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function formatAmount2dp(amount) {
  return Number(amount).toFixed(2);
}

export function sumAmounts2dp(amounts) {
  const cents = amounts.reduce(
    (acc, a) => acc + Math.round(Number(a) * 100),
    0,
  );
  return (cents / 100).toFixed(2);
}
