import { MentionType } from '@sih/shared';
import { normalizePhone, normalizeVehicle } from '../../core/identifier-normalization';

export interface ExtractedMentionCandidate {
  mentionType: MentionType;
  text: string;
  normalizedText?: string;
  confidence: number;
  pageNumber: number;
  startOffset: number;
  endOffset: number;
}

/**
 * Deterministic, rule-based extraction (Phase 2 scope: "use deterministic
 * extraction where reliable... never make the pipeline dependent on an
 * LLM"). Patterns are tuned for Indian-FIR-style text and are intentionally
 * simple heuristics, not full NLP/NER — MVP extracts *mentions*, never
 * resolves identities (SYSTEM-ARCHITECTURE.md §12).
 *
 * Every matcher operates on one page's text at a time so offsets stay
 * page-relative and pageNumber can be attached per match, preserving
 * provenance back to an exact source location.
 */

interface Matcher {
  mentionType: MentionType;
  confidence: number;
  regex: RegExp;
  /** Which capture group holds the mention text; 0 = whole match. */
  group?: number;
  normalize?: (raw: string) => string | undefined;
}

const PHONE: Matcher = {
  mentionType: MentionType.PHONE,
  confidence: 0.9,
  regex: /(?<!\w)(?:(?:\+91|0091)[ -]?)?0?[6-9]\d{4}[ -]?\d{5}\b/g,
  normalize: (raw) => normalizePhone(raw) ?? undefined,
};

const VEHICLE: Matcher = {
  mentionType: MentionType.VEHICLE,
  confidence: 0.85,
  // Indian registration format: MP 09 AB 1234 (separators optional)
  regex: /\b[A-Z]{2}[-\s]?\d{1,2}[-\s]?[A-Z]{1,3}[-\s]?\d{4}\b/g,
  normalize: (raw) => normalizeVehicle(raw) ?? undefined,
};

const DATE_NUMERIC: Matcher = {
  mentionType: MentionType.DATE,
  confidence: 0.75,
  regex: /\b\d{1,2}[/\-.]\d{1,2}[/\-.]\d{2,4}\b/g,
};

const DATE_ISO: Matcher = {
  mentionType: MentionType.DATE,
  confidence: 0.85,
  regex: /\b\d{4}-\d{2}-\d{2}\b/g,
};

const MONTHS =
  'January|February|March|April|May|June|July|August|September|October|November|December';
const MONTH_INDEX: Record<string, string> = {
  january: '01', february: '02', march: '03', april: '04', may: '05', june: '06',
  july: '07', august: '08', september: '09', october: '10', november: '11', december: '12',
};
const DATE_TEXTUAL: Matcher = {
  mentionType: MentionType.DATE,
  confidence: 0.85,
  regex: new RegExp(`\\b\\d{1,2}\\s+(?:${MONTHS})\\s+\\d{4}\\b`, 'gi'),
  normalize: (raw) => {
    const m = raw.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/);
    if (!m) return undefined;
    const month = MONTH_INDEX[m[2].toLowerCase()];
    if (!month) return undefined;
    return `${m[3]}-${month}-${m[1].padStart(2, '0')}`;
  },
};

const MONEY: Matcher = {
  mentionType: MentionType.MONEY,
  confidence: 0.75,
  regex: /\b(?:Rs\.?|INR|₹)\s?[\d,]+(?:\.\d+)?\b/gi,
  // Strip everything up to the first digit (currency symbol/prefix like
  // "Rs." would otherwise leave a stray leading "." from "Rs." itself if we
  // just blanket-stripped non-digit/non-dot characters), then de-comma.
  normalize: (raw) => {
    const numeric = raw.match(/[\d,]+(?:\.\d+)?$/)?.[0];
    return numeric ? numeric.replace(/,/g, '') : undefined;
  },
};

const FINANCIAL_IDENTIFIER: Matcher = {
  mentionType: MentionType.MONEY,
  confidence: 0.6,
  // label-anchored (a/c no., account number) to avoid colliding with phone numbers
  regex: /\b(?:a\/?c\.?\s*(?:no\.?)?|account\s*(?:no\.?)?)\s*[:\-]?\s*(\d{9,18})\b/gi,
  group: 1,
};

const CASE_IDENTIFIER: Matcher = {
  mentionType: MentionType.CASE_IDENTIFIER,
  confidence: 0.85,
  regex: /\b(?:FIR\s*No\.?|Case\s*No\.?|Crime\s*No\.?)\s*[:\-]?\s*[A-Z0-9/\-]+/gi,
  normalize: (raw) => raw.trim().toUpperCase(),
};

// Space/tab only (not newline) in both the connecting separator and within
// the name itself — a real bug surfaced this: without it, "Complainant:
// Rahul Sharma\nAccused: Vikram" matched the label-to-label span across the
// line break as one "name" ("Rahul Sharma\nAccused"). FIR-style "Label:
// Name" pairs are single-line, so this is a safe, deliberate restriction.
const NAME_PART = '[A-Z][a-zA-Z.]+(?:[ \\t]+[A-Z][a-zA-Z.]+){0,3}';
const LABEL_SEP = '[ \\t]*[:\\-]?[ \\t]*';

const PERSON_LABELED: Matcher = {
  mentionType: MentionType.PERSON,
  confidence: 0.75,
  regex: new RegExp(`\\b(?:Complainant|Accused|Witness|Victim|Informant)${LABEL_SEP}(${NAME_PART})`, 'g'),
  group: 1,
};

const PERSON_HONORIFIC: Matcher = {
  mentionType: MentionType.PERSON,
  confidence: 0.7,
  regex: new RegExp(`\\b(?:Mr\\.|Mrs\\.|Ms\\.|Shri|Smt\\.|Dr\\.)${LABEL_SEP}(${NAME_PART})`, 'g'),
  group: 1,
};

// Same [ \t]-only fix as NAME_PART above — \s would let these cross line
// breaks and glue unrelated capitalized words from adjacent lines together.
const ORGANIZATION: Matcher = {
  mentionType: MentionType.ORGANIZATION,
  confidence: 0.7,
  regex:
    /\b([A-Z][a-zA-Z]+(?:[ \t]+[A-Z][a-zA-Z]+){0,4}[ \t]+(?:Police Station|Bank|Hospital|Ltd\.?|Pvt\.?[ \t]*Ltd\.?|Company|Corporation))\b/g,
  group: 1,
};

const LOCATION: Matcher = {
  mentionType: MentionType.LOCATION,
  confidence: 0.65,
  regex: /\b([A-Z][a-zA-Z]+(?:[ \t]+[A-Z][a-zA-Z]+){0,3}[ \t]+(?:Nagar|Colony|Road|Chowk|District|Village|Marg|Vihar))\b/g,
  group: 1,
};

const MATCHERS: Matcher[] = [
  PHONE,
  VEHICLE,
  DATE_TEXTUAL,
  DATE_ISO,
  DATE_NUMERIC,
  MONEY,
  FINANCIAL_IDENTIFIER,
  CASE_IDENTIFIER,
  PERSON_LABELED,
  PERSON_HONORIFIC,
  ORGANIZATION,
  LOCATION,
];

function runMatcher(matcher: Matcher, pageText: string, pageNumber: number): ExtractedMentionCandidate[] {
  const results: ExtractedMentionCandidate[] = [];
  const regex = new RegExp(
    matcher.regex.source,
    matcher.regex.flags.includes('g') ? matcher.regex.flags : `${matcher.regex.flags}g`,
  );
  let match: RegExpExecArray | null;

  while ((match = regex.exec(pageText)) !== null) {
    const groupIndex = matcher.group ?? 0;
    const text = match[groupIndex];
    if (!text) continue;

    // Offsets for a capture group: locate it within the full match rather
    // than assuming group 0 == match start (label-anchored patterns like
    // "Complainant: Rahul Sharma" only want "Rahul Sharma" spanned).
    const startOffset = groupIndex === 0 ? match.index : pageText.indexOf(text, match.index);
    const endOffset = startOffset + text.length;

    results.push({
      mentionType: matcher.mentionType,
      text,
      normalizedText: matcher.normalize?.(text),
      confidence: matcher.confidence,
      pageNumber,
      startOffset,
      endOffset,
    });

    if (regex.lastIndex === match.index) {
      regex.lastIndex += 1; // guard against zero-width match infinite loop
    }
  }

  return results;
}

/** De-dupes exact (type, normalizedText||text, page) repeats — same mention referenced twice on a page collapses to one record. */
function dedupe(candidates: ExtractedMentionCandidate[]): ExtractedMentionCandidate[] {
  const seen = new Set<string>();
  const out: ExtractedMentionCandidate[] = [];
  for (const c of candidates) {
    const key = `${c.mentionType}::${(c.normalizedText ?? c.text).toLowerCase()}::${c.pageNumber}::${c.startOffset}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

export function extractMentionsFromPage(pageText: string, pageNumber: number): ExtractedMentionCandidate[] {
  const all = MATCHERS.flatMap((matcher) => runMatcher(matcher, pageText, pageNumber));
  return dedupe(all);
}

export function extractMentions(pages: { pageNumber: number; text: string }[]): ExtractedMentionCandidate[] {
  return pages.flatMap((page) => extractMentionsFromPage(page.text, page.pageNumber));
}
