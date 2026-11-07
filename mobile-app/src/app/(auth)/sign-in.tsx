import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { Pressable } from 'react-native';

import { isApiError } from '@/api/errors';
import { Banner, Button, Text, TextField } from '@/components';
import { AuthFrame, AuthLede, AuthTitle } from '@/features/auth/AuthFrame';
import { challengeStore } from '@/features/auth/challengeStore';
import { identifierSchema, type IdentifierForm } from '@/features/auth/schemas';
import { useAuth } from '@/providers/AuthProvider';

export default function SignInScreen() {
  const router = useRouter();
  const { requestOtp, startGuest, sessionExpired, status } = useAuth();
  // Someone who is already a guest is here to sign in or sign up and keep what they did. Starting a new
  // guest session would replace theirs and leave their bookings and saved items behind.
  const isGuest = status === 'guest';
  const [error, setError] = useState<string | null>(null);
  const [guestBusy, setGuestBusy] = useState(false);

  const {
    control,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<IdentifierForm>({
    resolver: zodResolver(identifierSchema),
    defaultValues: { identifier: '' },
  });

  const onSubmit = handleSubmit(async ({ identifier }) => {
    setError(null);
    try {
      const challenge = await requestOtp(identifier);
      challengeStore.set(challenge, identifier);
      router.push('/verify');
    } catch (e) {
      setError(isApiError(e) ? e.message : 'Something went wrong. Please try again.');
    }
  });

  const continueAsGuest = async () => {
    setError(null);
    setGuestBusy(true);
    try {
      await startGuest();
      // A guest is not signed in to an account, so these screens stay reachable for them (to sign in
      // later and keep what they do) and are NOT removed when the session starts, as they are for an
      // account. Leave them here: back to wherever the visitor came from, with its form as they left it.
      if (router.canGoBack()) router.back();
      else router.replace('/');
    } catch (e) {
      setError(isApiError(e) ? e.message : 'Something went wrong. Please try again.');
      setGuestBusy(false);
    }
  };

  return (
    <AuthFrame>
      <AuthTitle>Welcome back</AuthTitle>
      <AuthLede>Sign in with your email or mobile number. We’ll send you a one-time code.</AuthLede>

      {sessionExpired ? <Banner tone="warning" message="Your session ended. Please sign in again." /> : null}
      {error ? <Banner tone="error" message={error} /> : null}

      <Controller
        control={control}
        name="identifier"
        render={({ field: { value, onChange, onBlur } }) => (
          <TextField
            label="Email or mobile number"
            value={value}
            onChangeText={onChange}
            onBlur={onBlur}
            error={errors.identifier?.message}
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="email"
            keyboardType="email-address"
            textContentType="username"
            returnKeyType="go"
            onSubmitEditing={() => void onSubmit()}
            placeholder="you@example.com or +91…"
          />
        )}
      />

      <Button title="Send code" onPress={onSubmit} loading={isSubmitting} />
      {isGuest ? (
        <Banner tone="info" message="You’re browsing as a guest. Sign in and your bookings, wishlist and saved travellers come with you." />
      ) : (
        <Button title="Continue as guest" variant="outline" onPress={continueAsGuest} loading={guestBusy} disabled={isSubmitting} />
      )}

      <Pressable
        onPress={() => router.replace('/sign-up')}
        accessibilityRole="link"
        accessibilityLabel="Create an account"
        style={{ minHeight: 48, justifyContent: 'center' }}
      >
        <Text variant="bodyStrong" color="goldInk" align="center">
          New here? Create an account
        </Text>
      </Pressable>
    </AuthFrame>
  );
}
