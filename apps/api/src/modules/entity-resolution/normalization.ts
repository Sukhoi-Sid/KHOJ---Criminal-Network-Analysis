import { MentionType, type EntityType, type EntityIdentifiers, type IdentifierKind } from '@sih/shared';
import { normalizeText, normalizePhone, normalizeVehicle, normalizeFinancialIdentifier } from '../../core/identifier-normalization';

export interface NormalizedValue { value: string; validIdentifier: boolean }
type Normalizer = (raw: string) => NormalizedValue;
const text: Normalizer = raw => ({ value: normalizeText(raw), validIdentifier: false });
const identifier = (fn: (raw: string) => string | null): Normalizer => raw => {
  const normalized = fn(raw);
  return { value: normalized ?? raw.trim(), validIdentifier: normalized !== null };
};
export const valueNormalizers: Record<EntityType, Normalizer> = {
  [MentionType.PERSON]: text,
  [MentionType.PHONE]: identifier(normalizePhone),
  [MentionType.VEHICLE]: identifier(normalizeVehicle),
  [MentionType.MONEY]: identifier(normalizeFinancialIdentifier),
  [MentionType.LOCATION]: text,
  [MentionType.ORGANIZATION]: text,
  [MentionType.CASE_IDENTIFIER]: raw => ({ value: raw.trim().replace(/\s+/g, ' ').toUpperCase(), validIdentifier: true }),
};

export function normalizeIdentifiers(input: Record<string, unknown>): EntityIdentifiers {
  const normalizers: Record<IdentifierKind, (raw: string) => string | null> = {
    phone: normalizePhone, vehicle: normalizeVehicle, account: normalizeFinancialIdentifier,
    address: normalizeText, organization: normalizeText, bank: normalizeText,
    governmentId: raw => raw.trim(), // namespace/punctuation/case are retained
    dob: raw => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
      const date = new Date(raw + 'T00:00:00Z');
      return Number.isFinite(date.getTime()) && date.toISOString().slice(0,10) === raw ? raw : null;
    },
  };
  const result: EntityIdentifiers = {};
  for (const key of Object.keys(normalizers) as IdentifierKind[]) {
    const supplied = input[key];
    const values = Array.isArray(supplied) ? supplied : [supplied];
    const normalized = values.filter((v): v is string => typeof v === 'string' && v.length <= 1000)
      .map(normalizers[key]).filter((v): v is string => !!v);
    if (normalized.length) result[key] = [...new Set(normalized)].sort();
  }
  return result;
}
