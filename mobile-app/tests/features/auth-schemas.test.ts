import { cleanMobile, identifierSchema, otpSchema, signUpSchema } from '@/features/auth/schemas';

const valid = {
  full_name: 'Asha  Rao',
  email: 'asha@example.com',
  mobile: '+91 98765-43210',
  password: 'correct horse',
  confirm_password: 'correct horse',
};

function firstError(result: { success: boolean; error?: { issues: { message: string; path: PropertyKey[] }[] } }) {
  return result.error?.issues[0];
}

describe('identifierSchema', () => {
  it('accepts an email or a mobile and trims it', () => {
    expect(identifierSchema.parse({ identifier: '  a@b.co ' }).identifier).toBe('a@b.co');
    expect(identifierSchema.parse({ identifier: '+919876543210' }).identifier).toBe('+919876543210');
  });

  it('rejects empty and too-short input', () => {
    expect(identifierSchema.safeParse({ identifier: '' }).success).toBe(false);
    expect(identifierSchema.safeParse({ identifier: 'ab' }).success).toBe(false);
  });
});

describe('otpSchema', () => {
  it('takes 4 to 10 digits, as the server does', () => {
    expect(otpSchema.safeParse({ code: ' 123456 ' }).success).toBe(true);
    expect(otpSchema.safeParse({ code: '123' }).success).toBe(false);
    expect(otpSchema.safeParse({ code: '12345678901' }).success).toBe(false);
    expect(otpSchema.safeParse({ code: '12a456' }).success).toBe(false);
  });
});

describe('signUpSchema', () => {
  it('normalises the name and mobile the way the server will', () => {
    const out = signUpSchema.parse(valid);
    expect(out.full_name).toBe('Asha Rao');
    expect(out.mobile).toBe('+919876543210');
  });

  it('cleanMobile drops spaces and dashes only', () => {
    expect(cleanMobile(' +91 98765-43210 ')).toBe('+919876543210');
  });

  it.each(['12345', '+1234567890123456', 'abcdefghij', '98765 4321x'])('rejects mobile %s', (mobile) => {
    const result = signUpSchema.safeParse({ ...valid, mobile });
    expect(result.success).toBe(false);
    expect(firstError(result)?.path).toEqual(['mobile']);
  });

  it('rejects an invalid email', () => {
    const result = signUpSchema.safeParse({ ...valid, email: 'asha@' });
    expect(firstError(result)?.path).toEqual(['email']);
  });

  it('enforces the 8-72 character password bounds', () => {
    expect(signUpSchema.safeParse({ ...valid, password: 'short', confirm_password: 'short' }).success).toBe(false);
    const long = 'x'.repeat(73);
    expect(signUpSchema.safeParse({ ...valid, password: long, confirm_password: long }).success).toBe(false);
    const edge = 'x'.repeat(72);
    expect(signUpSchema.safeParse({ ...valid, password: edge, confirm_password: edge }).success).toBe(true);
  });

  it('requires the two passwords to match, reported on the confirm field', () => {
    const result = signUpSchema.safeParse({ ...valid, confirm_password: 'different one' });
    expect(firstError(result)).toMatchObject({ path: ['confirm_password'], message: 'Passwords do not match.' });
  });

  it('requires a real name', () => {
    expect(signUpSchema.safeParse({ ...valid, full_name: ' a ' }).success).toBe(false);
  });
});
