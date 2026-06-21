export function normalizeMembershipCategoryKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");
}

export function isNoFeeMembershipCategory(value) {
  const key = normalizeMembershipCategoryKey(value);
  if (!key) return false;

  if (key === "honorary" || /\bhonorary\b/.test(key)) {
    return true;
  }

  return (
    key.includes("undergraduate") &&
    key.includes("student") &&
    !key.includes("postgraduate")
  );
}
