import { describe, expect, it } from 'vitest';
import {
  isEmail,
  isSaIdNumber,
  isSaMobile,
  luhnValid,
  maskValue,
  placeholderFor,
  semanticFromName,
} from '../../src/services/parsing/pii.js';

/** Builds a syntactically valid synthetic SA ID: YYMMDD + 6 digits + Luhn check digit. */
function makeId(birth: string, middle = '500008'): string {
  const body = birth + middle;
  for (let d = 0; d <= 9; d++) if (luhnValid(body + d)) return body + d;
  throw new Error('unreachable');
}

describe('SA ID numbers', () => {
  it('accepts a valid date with a valid Luhn digit', () => {
    expect(isSaIdNumber(makeId('900101'))).toBe(true);
    expect(isSaIdNumber(makeId('050228'))).toBe(true);
    expect(isSaIdNumber(makeId('000229'))).toBe(true); // 2000 was a leap year
    expect(isSaIdNumber(makeId('900101').replace(/(\d{6})(\d{7})/, '$1 $2'))).toBe(true);
  });

  it('rejects a wrong Luhn digit', () => {
    const id = makeId('900101');
    const wrong = id.slice(0, 12) + String((Number(id[12]) + 1) % 10);
    expect(isSaIdNumber(wrong)).toBe(false);
  });

  it('rejects an impossible birth date even with a valid Luhn digit', () => {
    expect(isSaIdNumber(makeId('901301'))).toBe(false); // month 13
    expect(isSaIdNumber(makeId('900230'))).toBe(false); // 30 February
    expect(isSaIdNumber(makeId('010229'))).toBe(false); // 2001 and 1901 were not leap years
  });

  it('rejects the wrong length or non-digits', () => {
    expect(isSaIdNumber('900101500008')).toBe(false);
    expect(isSaIdNumber('90010150000812')).toBe(false);
    expect(isSaIdNumber('9001015A00081')).toBe(false);
  });

  it('implements Luhn', () => {
    expect(luhnValid('79927398713')).toBe(true);
    expect(luhnValid('79927398710')).toBe(false);
  });
});

describe('emails and SA mobiles', () => {
  it('matches emails', () => {
    expect(isEmail('naledi.proef18@example.com')).toBe(true);
    expect(isEmail('not an email')).toBe(false);
    expect(isEmail('a@b')).toBe(false);
  });

  it('matches SA mobiles in common layouts', () => {
    for (const v of ['0825551234', '082 555 1234', '082-555-1234', '+27825551234', '+27 82 555 1234', '(082) 555 1234']) {
      expect(isSaMobile(v), v).toBe(true);
    }
    for (const v of ['0215551234', '082555123', '+2782555123', '1234567890']) expect(isSaMobile(v), v).toBe(false);
  });
});

describe('semanticFromName', () => {
  it.each([
    ['Customer email', 'email'],
    ['E-mail', 'email'],
    ['Phone', 'phone'],
    ['Cell', 'phone'],
    ['Mobile number', 'phone'],
    ['ID Number', 'sa_id_number'],
    ['Identity no', 'sa_id_number'],
    ['Address', 'address'],
    ['Customer name', 'person_name'],
    ['Surname', 'person_name'],
    ['Customer', 'person_name'],
  ])('%s is %s', (header, semantic) => {
    expect(semanticFromName(header)).toBe(semantic);
  });

  it('ignores business names and ordinary columns', () => {
    for (const h of ['Product name', 'Store name', 'Store', 'Order ID', 'Customer type', 'Amount', 'Terminal', 'Description']) {
      expect(semanticFromName(h), h).toBeNull();
    }
  });
});

describe('masking', () => {
  it('uses fixed placeholders per meaning', () => {
    expect(placeholderFor('email', 'x')).toBe('[email]');
    expect(placeholderFor('phone', 'x')).toBe('[phone]');
    expect(placeholderFor('sa_id_number', 'x')).toBe('[id]');
    expect(placeholderFor('person_name', 'x')).toBe('[name]');
    expect(placeholderFor('address', 'x')).toBe('[address]');
    expect(placeholderFor('none', 'Home address')).toBe('[address]');
    expect(placeholderFor('free_text', 'Notes')).toBe('[name]');
  });

  it('masks only PII columns and keeps empties empty', () => {
    expect(maskValue('naledi@example.com', { is_pii: true, semantic: 'email', name: 'Email' })).toBe('[email]');
    expect(maskValue('Biltong', { is_pii: false, semantic: 'category', name: 'Product' })).toBe('Biltong');
    expect(maskValue('', { is_pii: true, semantic: 'email', name: 'Email' })).toBe('');
    expect(maskValue(null, { is_pii: true, semantic: 'email', name: 'Email' })).toBeNull();
  });
});
