import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';

import { isApiError } from '@/api/errors';
import { Banner, Button, TextField } from '@/components';
import { AuthFrame, AuthLede, AuthTitle } from '@/features/auth/AuthFrame';
import { challengeStore } from '@/features/auth/challengeStore';
import { otpSchema, type OtpForm } from '@/features/auth/schemas';
import { useAuth } from '@/providers/AuthProvider';

/** The backend allows 5 codes a minute per address; this keeps taps well under it. */
const RESEND_COOLDOWN_SECONDS = 30;

export default function VerifyScreen() {
  const router = useRouter();
  const { verifyOtp, resendOtp } = useAuth();
  const pending = challengeStore.get();

  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(RESEND_COOLDOWN_SECONDS);
  const [resending, setResending] = useState(false);

  const {
    control,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<OtpForm>({ resolver: zodResolver(otpSchema), defaultValues: { code: '' } });

  // Reaching this screen with no challenge (app restarted mid-sign-in, deep
  // link) means there is nothing to verify: start over.
  useEffect(() => {
    if (!pending) router.replace('/sign-in');
  }, [pending, router]);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setTimeout(() => setCooldown((s) => s - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  if (!pending) return null;

  const onSubmit = handleSubmit(async ({ code }) => {
    setError(null);
    try {
      await verifyOtp(pending.challenge.challenge_token, code);
      challengeStore.clear();
      // Signed in: this group leaves the navigator and the tabs take over.
    } catch (e) {
      setError(isApiError(e) ? e.message : 'Something went wrong. Please try again.');
    }
  });

  const resend = async () => {
    setError(null);
    setInfo(null);
    setResending(true);
    try {
      const next = await resendOtp(pending.challenge.challenge_token);
      challengeStore.update(next);
      setInfo(next.message);
      setCooldown(RESEND_COOLDOWN_SECONDS);
    } catch (e) {
      setError(isApiError(e) ? e.message : 'Something went wrong. Please try again.');
    } finally {
      setResending(false);
    }
  };

  // Shown only in a development build against a development backend, which is
  // the one place the server returns the code at all. A deployed server never does.
  const devCode = __DEV__ ? pending.challenge.dev_otp : null;

  return (
    <AuthFrame>
      <AuthTitle>Check your email</AuthTitle>
      <AuthLede>{pending.challenge.message}</AuthLede>

      {devCode ? <Banner tone="info" message={`Development server code: ${devCode}`} /> : null}
      {info ? <Banner tone="success" message={info} /> : null}
      {error ? <Banner tone="error" message={error} /> : null}

      <Controller
        control={control}
        name="code"
        render={({ field: { value, onChange, onBlur } }) => (
          <TextField
            label="Verification code"
            value={value}
            onChangeText={onChange}
            onBlur={onBlur}
            error={errors.code?.message}
            keyboardType="number-pad"
            autoComplete="one-time-code"
            textContentType="oneTimeCode"
            maxLength={10}
            returnKeyType="go"
            onSubmitEditing={() => void onSubmit()}
            autoFocus
          />
        )}
      />

      <Button title="Verify and sign in" onPress={onSubmit} loading={isSubmitting} />
      <Button
        title={cooldown > 0 ? `Resend code in ${cooldown}s` : 'Resend code'}
        variant="ghost"
        onPress={resend}
        loading={resending}
        disabled={cooldown > 0 || isSubmitting}
      />
    </AuthFrame>
  );
}
