import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { Pressable } from 'react-native';

import { isApiError } from '@/api/errors';
import { Banner, Button, Text, TextField, type TextFieldHandle } from '@/components';
import { AuthFrame, AuthLede, AuthTitle } from '@/features/auth/AuthFrame';
import { challengeStore } from '@/features/auth/challengeStore';
import { signUpSchema, type SignUpForm, type SignUpValues } from '@/features/auth/schemas';
import { useAuth } from '@/providers/AuthProvider';

export default function SignUpScreen() {
  const router = useRouter();
  const { signUp } = useAuth();
  const [error, setError] = useState<string | null>(null);

  const emailRef = useRef<TextFieldHandle>(null);
  const mobileRef = useRef<TextFieldHandle>(null);
  const passwordRef = useRef<TextFieldHandle>(null);
  const confirmRef = useRef<TextFieldHandle>(null);

  const {
    control,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<SignUpForm, unknown, SignUpValues>({
    resolver: zodResolver(signUpSchema),
    defaultValues: { full_name: '', email: '', mobile: '', password: '', confirm_password: '' },
  });

  const onSubmit = handleSubmit(async (values) => {
    setError(null);
    try {
      // `values` is the schema's OUTPUT: name tidied, mobile stripped of spaces.
      const challenge = await signUp(values);
      challengeStore.set(challenge, values.email);
      router.push('/verify');
    } catch (e) {
      setError(isApiError(e) ? e.message : 'Something went wrong. Please try again.');
    }
  });

  return (
    <AuthFrame>
      <AuthTitle>Create your account</AuthTitle>
      <AuthLede>We’ll email you a code to confirm it’s you.</AuthLede>

      {error ? <Banner tone="error" message={error} /> : null}

      <Controller
        control={control}
        name="full_name"
        render={({ field: { value, onChange, onBlur } }) => (
          <TextField
            label="Full name"
            value={value}
            onChangeText={onChange}
            onBlur={onBlur}
            error={errors.full_name?.message}
            autoComplete="name"
            textContentType="name"
            autoCapitalize="words"
            returnKeyType="next"
            onSubmitEditing={() => emailRef.current?.focus()}
          />
        )}
      />
      <Controller
        control={control}
        name="email"
        render={({ field: { value, onChange, onBlur } }) => (
          <TextField
            ref={emailRef}
            label="Email"
            value={value}
            onChangeText={onChange}
            onBlur={onBlur}
            error={errors.email?.message}
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="email"
            keyboardType="email-address"
            textContentType="emailAddress"
            returnKeyType="next"
            onSubmitEditing={() => mobileRef.current?.focus()}
          />
        )}
      />
      <Controller
        control={control}
        name="mobile"
        render={({ field: { value, onChange, onBlur } }) => (
          <TextField
            ref={mobileRef}
            label="Mobile number"
            value={value}
            onChangeText={onChange}
            onBlur={onBlur}
            error={errors.mobile?.message}
            helper="Include your country code, for example +91."
            autoComplete="tel"
            keyboardType="phone-pad"
            textContentType="telephoneNumber"
            returnKeyType="next"
            onSubmitEditing={() => passwordRef.current?.focus()}
          />
        )}
      />
      <Controller
        control={control}
        name="password"
        render={({ field: { value, onChange, onBlur } }) => (
          <TextField
            ref={passwordRef}
            label="Password"
            value={value}
            onChangeText={onChange}
            onBlur={onBlur}
            error={errors.password?.message}
            helper="8 to 72 characters."
            secureTextEntry
            autoCapitalize="none"
            autoComplete="new-password"
            textContentType="newPassword"
            returnKeyType="next"
            onSubmitEditing={() => confirmRef.current?.focus()}
          />
        )}
      />
      <Controller
        control={control}
        name="confirm_password"
        render={({ field: { value, onChange, onBlur } }) => (
          <TextField
            ref={confirmRef}
            label="Confirm password"
            value={value}
            onChangeText={onChange}
            onBlur={onBlur}
            error={errors.confirm_password?.message}
            secureTextEntry
            autoCapitalize="none"
            autoComplete="new-password"
            textContentType="newPassword"
            returnKeyType="go"
            onSubmitEditing={() => void onSubmit()}
          />
        )}
      />

      <Button title="Create account" onPress={onSubmit} loading={isSubmitting} />

      <Pressable
        onPress={() => router.replace('/sign-in')}
        accessibilityRole="link"
        accessibilityLabel="Sign in instead"
        style={{ minHeight: 48, justifyContent: 'center' }}
      >
        <Text variant="bodyStrong" color="goldInk" align="center">
          Already have an account? Sign in
        </Text>
      </Pressable>
    </AuthFrame>
  );
}
