import type { ColumnSemantic } from '../../types/api.js';
import { isValidDate } from './dates.js';

/**
 * PII detection (ARCHITECTURE section 5). A column is PII if its name matches a personal-data pattern
 * or its values look like emails, South African mobile numbers or 13-digit SA ID numbers. Errs on the side of flagging.
 */

export type PiiSemantic = Extract<ColumnSemantic, 'email' | 'phone' | 'sa_id_number' | 'person_name' | 'address'>;
export const PII_SEMANTICS: ReadonlySet<ColumnSemantic> = new Set(['email', 'phone', 'sa_id_number', 'person_name', 'address']);

const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[A-Za-z]{2,}$/;
const SA_MOBILE_RE = /^(\+27|0)[6-8][0-9]{8}$/;

export const isEmail = (v: string) => EMAIL_RE.test(v.trim());

/** South African mobile, ignoring spaces, dashes, dots and brackets: 082 555 1234, +27 82 555 1234. */
export const isSaMobile = (v: string) => SA_MOBILE_RE.test(v.replace(/[\s\-.()]/g, ''));

export function luhnValid(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

/** 13 digits, a valid YYMMDD birth date (19YY or 20YY) at the start, and a passing Luhn check digit. */
export function isSaIdNumber(v: string): boolean {
  const s = v.replace(/\s/g, '');
  if (!/^\d{13}$/.test(s)) return false;
  const yy = Number(s.slice(0, 2));
  const mm = Number(s.slice(2, 4));
  const dd = Number(s.slice(4, 6));
  if (!isValidDate(1900 + yy, mm, dd) && !isValidDate(2000 + yy, mm, dd)) return false;
  return luhnValid(s);
}

/** Business things that are called "name" but are not people. */
const NOT_A_PERSON = /\b(product|item|store|shop|branch|company|business|file|category|brand|account|bank|merchant|terminal|sheet|service|plan|project|supplier|vendor|stock)\b/i;

/** The personal-data meaning a column header implies, or null. */
export function semanticFromName(header: string): PiiSemantic | null {
  const h = header.toLowerCase().replace(/[_\-.]+/g, ' ');
  if (/\be ?mail\b/.test(h)) return 'email';
  if (/\b(phone|mobile|cell|cellphone|tel|telephone|contact number|whatsapp)\b/.test(h)) return 'phone';
  if (/\b(id ?(number|no|nr)|identity|sa ?id|id ?num)\b/.test(h)) return 'sa_id_number';
  if (/\b(address|street|suburb|postal|postcode|zip)\b/.test(h)) return 'address';
  if (/\b(name|surname|first ?name|last ?name|full ?name|cardholder)\b/.test(h)) {
    return NOT_A_PERSON.test(h) && !/\b(surname|first ?name|last ?name|full ?name)\b/.test(h) ? null : 'person_name';
  }
  // A column called just "Customer" or "Employee" usually holds people's names.
  if (/^\s*(customer|client|employee|recipient|beneficiary|payee)\s*$/.test(h)) return 'person_name';
  return null;
}

/** The fixed placeholder put in a prompt instead of a PII value. */
export function placeholderFor(semantic: ColumnSemantic, header: string): string {
  switch (semantic) {
    case 'email':
      return '[email]';
    case 'phone':
      return '[phone]';
    case 'sa_id_number':
      return '[id]';
    case 'address':
      return '[address]';
    case 'person_name':
      return '[name]';
    default: {
      // A column the user flagged as PII without a personal meaning: pick by its header, else [name].
      const fromName = semanticFromName(header);
      return fromName ? placeholderFor(fromName, header) : '[name]';
    }
  }
}

/** Masks a value for any column flagged is_pii; leaves others unchanged. */
export function maskValue(value: string | null, column: { is_pii: boolean; semantic: ColumnSemantic; name: string }): string | null {
  if (value === null || value === '') return value;
  return column.is_pii ? placeholderFor(column.semantic, column.name) : value;
}
