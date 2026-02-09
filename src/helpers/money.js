/**
 * Money conversion utilities
 * All storage is in integer cents (minor units)
 * Conversion to euros only happens for display/API responses
 */

/**
 * Convert cents to euros for display
 * @param {number} cents - Amount in cents (integer)
 * @returns {number} Amount in euros (decimal, 2 decimal places)
 * @throws {Error} If cents is not an integer
 */
export function centsToEuros(cents) {
  if (!Number.isInteger(cents)) {
    throw new Error(`cents must be an integer, got: ${typeof cents} ${cents}`);
  }
  return Number((cents / 100).toFixed(2));
}

/**
 * Convert euros to cents for storage
 * @param {number} euros - Amount in euros (decimal)
 * @returns {number} Amount in cents (integer)
 */
export function eurosToCents(euros) {
  return Math.round(euros * 100);
}

/**
 * Validate that an amount is in cents (integer)
 * @param {any} amount - Amount to validate
 * @param {string} fieldName - Field name for error message
 * @throws {Error} If amount is not a positive integer
 */
export function validateCents(amount, fieldName = "amount") {
  if (!Number.isInteger(amount)) {
    throw new Error(`${fieldName} must be an integer (minor units, e.g., 32600 for €326.00)`);
  }
  if (amount <= 0) {
    throw new Error(`${fieldName} must be a positive integer`);
  }
  return true;
}
