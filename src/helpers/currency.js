/**
 * Format amount as currency with € sign and 2 decimal places
 * @param {number} amount - Amount to format
 * @returns {string} Formatted currency string (e.g., "€326.00")
 */
export function formatCurrency(amount) {
  if (amount === null || amount === undefined || isNaN(amount)) {
    return "€0.00";
  }
  return `€${Number(amount).toFixed(2)}`;
}

/**
 * Format amount as currency value (number with 2 decimal places)
 * Used when you want to keep it as a number but ensure 2 decimals
 * @param {number} amount - Amount to format
 * @returns {number} Number with 2 decimal places
 */
export function formatCurrencyValue(amount) {
  if (amount === null || amount === undefined || isNaN(amount)) {
    return 0.0;
  }
  return Number(Number(amount).toFixed(2));
}

/**
 * Recursively format all amount fields in an object/array
 * @param {any} data - Data object or array to format
 * @param {string[]} fieldNames - Field names to format (default: ['amount', 'net', 'total', 'debit', 'credit', 'balance'])
 * @returns {any} Formatted data with currency strings
 */
export function formatAmountsInResponse(data, fieldNames = ['amount', 'net', 'total', 'debit', 'credit', 'balance', 'feeNoVat', 'feeVat', 'feeTotal']) {
  if (data === null || data === undefined) {
    return data;
  }

  if (Array.isArray(data)) {
    return data.map(item => formatAmountsInResponse(item, fieldNames));
  }

  if (typeof data === 'object' && data.constructor === Object) {
    const formatted = {};
    for (const [key, value] of Object.entries(data)) {
      if (fieldNames.includes(key) && typeof value === 'number') {
        formatted[key] = formatCurrency(value);
      } else if (key === 'entries' && Array.isArray(value)) {
        // Format amounts in entries array (recursively process each entry)
        formatted[key] = value.map(entry => formatAmountsInResponse(entry, fieldNames));
      } else if (typeof value === 'object') {
        formatted[key] = formatAmountsInResponse(value, fieldNames);
      } else {
        formatted[key] = value;
      }
    }
    return formatted;
  }

  return data;
}
