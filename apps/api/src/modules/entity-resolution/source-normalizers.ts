import { MentionType, type EntityType, type EntityIdentifiers } from '@sih/shared';
import { normalizeIdentifiers } from './normalization';

export interface SourceEntityInput {
  entityType: EntityType; rawValue: string; field: string;
  attributes: Record<string, unknown>; identifiers: EntityIdentifiers;
}
export interface IReturnedDataNormalizer { normalize(record: Record<string, unknown>): SourceEntityInput[] }
function value(type: EntityType, row: Record<string, unknown>, field: string, ids: Record<string, unknown> = {}): SourceEntityInput[] {
  const raw = row[field];
  if (typeof raw !== 'string' || !raw.trim()) return [];
  return [{ entityType: type, rawValue: raw, field, attributes: row, identifiers: normalizeIdentifiers(ids) }];
}
const identityAttributes = (row: Record<string, unknown>) => ({ phone: row.phone, dob: row.dob, address: row.address,
  governmentId: row.governmentId, account: row.account, vehicle: row.vehicle, organization: row.organization });

// Category keys come from the Phase 3 source registry; no source adapter is recreated.
export const returnedDataNormalizers = new Map<string, IReturnedDataNormalizer>([
  ['financial', { normalize: row => [
    ...value(MentionType.MONEY,row,'account',{ bank: row.bank }), ...value(MentionType.MONEY,row,'counterparty',{ bank: row.counterpartyBank }),
    ...value(MentionType.PERSON,row,'accountHolder',{ ...identityAttributes(row), account: row.account }),
    ...value(MentionType.ORGANIZATION,row,'organization'),
  ] }],
  ['telecom', { normalize: row => [
    ...value(MentionType.PHONE,row,'phone'), ...value(MentionType.PHONE,row,'counterpart'),
    ...value(MentionType.PERSON,row,'subscriber',identityAttributes(row)),
  ] }],
  ['criminal-history', { normalize: row => [
    ...value(MentionType.PERSON,row,'reportedName',identityAttributes(row)), ...value(MentionType.PHONE,row,'phone'),
    ...value(MentionType.CASE_IDENTIFIER,row,'reference'),
  ] }],
  ['vehicle', { normalize: row => [
    ...value(MentionType.VEHICLE,row,'registration'),
    ...value(MentionType.PERSON,row,'registeredOwner',{ ...identityAttributes(row), vehicle: row.registration }),
  ] }],
  ['location', { normalize: row => [...value(MentionType.LOCATION,row,'location')] }],
  ['cyber', { normalize: row => [...value(MentionType.PHONE,row,'contact'), ...value(MentionType.CASE_IDENTIFIER,row,'complaintRef')] }],
]);
