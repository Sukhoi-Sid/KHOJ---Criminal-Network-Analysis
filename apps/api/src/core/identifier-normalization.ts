// Formatting normalization only. These functions never establish identity.
export function normalizeText(raw: string) { return raw.normalize('NFC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-IN'); }
export function normalizePhone(raw: string): string | null {
  if (!/^[+\d\s().-]+$/.test(raw.trim())) return null;
  let digits = raw.replace(/\D/g, '');
  if (/^0091[6-9]\d{9}$/.test(digits)) digits = digits.slice(4);
  else if (/^91[6-9]\d{9}$/.test(digits)) digits = digits.slice(2);
  else if (/^0[6-9]\d{9}$/.test(digits)) digits = digits.slice(1);
  if (/^[6-9]\d{9}$/.test(digits)) return digits;
  // Explicit international code only; no guessing of country for other national numbers.
  if (raw.trim().startsWith('+') && /^[1-9]\d{7,14}$/.test(digits)) return '+' + digits;
  return null;
}
export function normalizeVehicle(raw: string): string | null {
  const value = raw.trim().toUpperCase().replace(/[\s-]/g, '');
  return /^[A-Z]{2}\d{1,2}[A-Z]{1,3}\d{4}$/.test(value) ? value : null;
}
export function normalizeFinancialIdentifier(raw: string): string | null {
  const value = raw.trim();
  // Preserve leading zeros; punctuation/case of nonnumeric identifiers may carry meaning.
  if (/^[\d ]{9,30}$/.test(value) && /^\d{9,18}$/.test(value.replace(/ /g, ''))) return value.replace(/ /g, '');
  if (/^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+$/.test(value)) return value;
  return null;
}
