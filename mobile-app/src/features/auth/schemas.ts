import { z } from 'zod';

/**
 * Client-side form validation for sign-in and sign-up.
 *
 * These mirror the backend's rules (backend/app/schemas/customer.py) so people
 * get an instant, specific message. They are a convenience, not a guard: the
 * server re-checks everything, and its answer wins.
 */

/** Spaces and dashes are typed freely; the server strips them too. */
export function cleanMobile(value: string): string {
  return value.trim().replace(/[\s-]/g, '');
}

const MOBILE_RE = /^\+?\d{8,15}$/;

/** What the sign-in form takes: an email address or a mobile number. */
export const identifierSchema = z.object({
  identifier: z
    .string()
    .trim()
    .min(3, 'Enter your email or mobile number.')
    .max(255, 'That is too long.'),
});
export type IdentifierForm = z.infer<typeof identifierSchema>;

/** The emailed verification code. Length is the server's 4-10 bound. */
export const otpSchema = z.object({
  code: z
    .string()
    .trim()
    .regex(/^\d{4,10}$/, 'Enter the code from your email (digits only).'),
});
export type OtpForm = z.infer<typeof otpSchema>;

export const signUpSchema = z
  .object({
    full_name: z
      .string()
      .transform((v) => v.split(/\s+/).filter(Boolean).join(' '))
      .pipe(
        z
          .string()
          .min(2, 'Enter your full name.')
          .max(150, 'That name is too long.'),
      ),
    email: z.string().trim().pipe(z.email('Enter a valid email address.')),
    mobile: z
      .string()
      .transform(cleanMobile)
      .pipe(
        z
          .string()
          .regex(
            MOBILE_RE,
            'Enter a valid mobile number: 8 to 15 digits, optionally starting with +.',
          ),
      ),
    // 72 is bcrypt's silent truncation point on the server, so it is a hard cap.
    password: z
      .string()
      .min(8, 'Use at least 8 characters.')
      .max(72, 'Use 72 characters or fewer.'),
    confirm_password: z.string(),
  })
  .refine((v) => v.password === v.confirm_password, {
    path: ['confirm_password'],
    message: 'Passwords do not match.',
  });
export type SignUpForm = z.input<typeof signUpSchema>;
export type SignUpValues = z.output<typeof signUpSchema>;
