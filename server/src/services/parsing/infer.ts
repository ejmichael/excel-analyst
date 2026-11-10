import type { ColumnDataType, ColumnSemantic } from '../../types/api.js';
import { type DateOrder, numericDateParts, parseDate } from './dates.js';
import { type DecimalSeparator, parseNumber } from './numbers.js';
import { isEmail, isSaIdNumber, isSaMobile, type PiiSemantic, semanticFromName } from './pii.js';

const BOOLEAN_WORDS = new Set(['true', 'false', 'yes', 'no', 'y', 'n']);
export const TRUE_WORDS = new Set(['true', 'yes', 'y']);

/** Counts gathered over every non-empty value of a column, enough to decide its type without keeping the values. */
export class ColumnEvidence {
  nonEmpty = 0;
  num: Record<DecimalSeparator, number> = { '.': 0, ',': 0 };
  frac: Record<DecimalSeparator, number> = { '.': 0, ',': 0 };
  dotOnly = 0;
  commaOnly = 0;
  percent = 0;
  currency = 0;
  bool = 0;
  date: Record<DateOrder, number> = { dmy: 0, mdy: 0, ymd: 0 };
  datetime = 0;
  numericDates = 0;
  maxFirst = 0;
  maxSecond = 0;
  email = 0;
  phone = 0;
  saId = 0;
  totalLength = 0;

  add(raw: string): void {
    const v = raw.trim();
    if (v === '') return;
    this.nonEmpty++;
    this.totalLength += v.length;
    const asDot = parseNumber(v, '.');
    const asComma = parseNumber(v, ',');
    // Votes for the file's decimal separator: values that read as a number one way only.
    if (asDot && !asComma) this.dotOnly++;
    if (asComma && !asDot) this.commaOnly++;
    for (const dec of ['.', ','] as const) {
      const n = dec === '.' ? asDot : asComma;
      // Leading zeros (phone numbers, codes) and very long digit runs (account numbers) are not numbers.
      if (!n || n.leadingZero || n.tooLong) continue;
      this.num[dec]++;
      if (!n.isInteger) this.frac[dec]++;
      if (dec === '.') {
        if (n.percent) this.percent++;
        if (n.currency) this.currency++;
      }
    }
    if (BOOLEAN_WORDS.has(v.toLowerCase())) this.bool++;
    for (const order of ['dmy', 'mdy', 'ymd'] as const) {
      const d = parseDate(v, order);
      if (d) {
        this.date[order]++;
        if (order === 'dmy' && d.kind === 'datetime') this.datetime++;
      }
    }
    const parts = numericDateParts(v);
    if (parts) {
      this.numericDates++;
      this.maxFirst = Math.max(this.maxFirst, parts[0]);
      this.maxSecond = Math.max(this.maxSecond, parts[1]);
    }
    if (isEmail(v)) this.email++;
    if (isSaMobile(v)) this.phone++;
    if (isSaIdNumber(v)) this.saId++;
  }

  /** True when every value is a date read day-first or month-first (so the column takes part in the date-order vote). */
  get isNumericDateColumn(): boolean {
    return this.numericDates > 0 && (this.date.dmy === this.nonEmpty || this.date.mdy === this.nonEmpty);
  }

  dataType(dec: DecimalSeparator, order: DateOrder): ColumnDataType {
    const n = this.nonEmpty;
    if (n === 0) return 'text';
    if (this.bool === n) return 'boolean';
    if (this.num[dec] === n) return this.frac[dec] === 0 && this.percent === 0 ? 'integer' : 'decimal';
    // 'ymd' only accepts year-first dates; day/month dates under it stay text.
    const dates = order === 'mdy' ? this.date.mdy : order === 'ymd' ? this.date.ymd : this.date.dmy;
    if (dates === n) {
      // A datetime column may also hold date-only values.
      return this.datetime > 0 ? 'datetime' : 'date';
    }
    return 'text';
  }

  /** The personal-data meaning from the values, if any value matched (errs on the side of flagging). */
  piiFromValues(): PiiSemantic | null {
    if (this.email > 0) return 'email';
    if (this.saId > 0) return 'sa_id_number';
    if (this.phone > 0) return 'phone';
    return null;
  }
}

const MONEY_NAME = /(amount|amt|price|total|fee|fees|net|gross|balance|revenue|sales|cost|discount|vat|tax|paid|payment|value|debit|credit|income|expense|profit|charge|rand|zar|turnover|tip|refund|spend|salary|wage)/i;
// Word boundaries matter: "Discount" contains "count".
const NOT_MONEY_NAME = /\b(qty|quantity|count|units?|number|no|rate|percent|pct|score|age|years?|days?)\b|%/i;
const ID_NAME = /(\bid\b|reference|\bref\b|code|number|\bno\b|invoice|order|txn|serial|sku)/i;

export interface SemanticInput {
  name: string;
  dataType: ColumnDataType;
  evidence: ColumnEvidence;
  distinct: number;
}

/** Column meaning and PII flag. Conservative: `none` when unsure; PII when the name or any value suggests it. */
export function inferSemantic({ name, dataType, evidence, distinct }: SemanticInput): { semantic: ColumnSemantic; isPii: boolean } {
  const pii = semanticFromName(name) ?? evidence.piiFromValues();
  if (pii) return { semantic: pii, isPii: true };
  const n = evidence.nonEmpty;
  if (n === 0) return { semantic: 'none', isPii: false };
  const numeric = dataType === 'integer' || dataType === 'decimal';
  if (numeric && evidence.percent === n) return { semantic: 'percentage', isPii: false };
  if (numeric && evidence.percent === 0 && (evidence.currency > 0 || (MONEY_NAME.test(name) && !NOT_MONEY_NAME.test(name)))) {
    return { semantic: 'currency_zar', isPii: false };
  }
  if ((dataType === 'text' || dataType === 'integer') && ID_NAME.test(name) && distinct >= n * 0.9) {
    return { semantic: 'identifier', isPii: false };
  }
  if (dataType === 'text') {
    if (distinct <= 50 && distinct <= n * 0.5) return { semantic: 'category', isPii: false };
    if (evidence.totalLength / n > 40) return { semantic: 'free_text', isPii: false };
  }
  return { semantic: 'none', isPii: false };
}

/** Converts one raw value to its normalised form for the column type; '' for empty or unconvertible values. */
export function normaliseValue(raw: string, type: ColumnDataType, dec: DecimalSeparator, order: DateOrder): string {
  const v = raw.trim();
  if (v === '') return '';
  switch (type) {
    case 'integer':
    case 'decimal':
      return parseNumber(v, dec)?.value ?? '';
    case 'boolean':
      return TRUE_WORDS.has(v.toLowerCase()) ? 'true' : 'false';
    case 'date':
      return parseDate(v, order)?.iso ?? '';
    case 'datetime': {
      const d = parseDate(v, order);
      if (!d) return '';
      return d.kind === 'date' ? `${d.iso}T00:00:00` : d.iso;
    }
    default:
      return v;
  }
}
