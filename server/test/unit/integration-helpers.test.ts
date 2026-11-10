import { describe, expect, it } from 'vitest';
import { describeError, redact, TEST_EMAIL_RE } from '../integration/helpers.js';

// The integration helpers print setup errors; they must never print keys or tokens.
describe('integration error reporting', () => {
  it('redacts JWTs, Supabase keys and bearer tokens', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJl';
    const text = redact(`token ${jwt} key sb_secret_AbC123-x pub sb_publishable_Zz9 header Bearer abc.def`);
    expect(text).not.toContain(jwt);
    expect(text).not.toContain('AbC123');
    expect(text).not.toContain('Zz9');
    expect(text).not.toContain('abc.def');
    expect(text).toContain('[jwt]');
  });

  it('describes Supabase-style errors with name, status, code and message', () => {
    const err = Object.assign(new Error('Request rate limit reached'), { name: 'AuthApiError', status: 429, code: 'over_request_rate_limit' });
    expect(describeError(err)).toBe('AuthApiError, status 429, code over_request_rate_limit, Request rate limit reached');
    expect(describeError('plain')).toBe('plain');
  });

  it('only matches generated test emails', () => {
    expect(TEST_EMAIL_RE.test('test+0123456789ab@example.com')).toBe(true);
    for (const e of ['test@example.com', 'test+abc@example.com', 'ethan@example.com', 'test+0123456789ab@example.org']) {
      expect(TEST_EMAIL_RE.test(e), e).toBe(false);
    }
  });
});
