import { Ionicons } from '@expo/vector-icons';
import { forwardRef, useRef, useState, type ElementRef } from 'react';
import {
  Pressable,
  StyleSheet,
  TextInput,
  View,
  type TextInputProps,
} from 'react-native';

import { colors, fontFamily, minTouchTarget, spacing } from '@/theme';

import { Text } from './Text';

/** What a ref to a TextField gives you: the underlying input, so `.focus()` works. */
export type TextFieldHandle = ElementRef<typeof TextInput>;

export interface TextFieldProps extends Omit<TextInputProps, 'style'> {
  label: string;
  error?: string;
  helper?: string;
}

/**
 * A labelled input. Shaped to drop straight into react-hook-form's
 * `Controller` (`value`, `onChangeText`, `onBlur`), with the error shown under
 * the field and announced to screen readers.
 */
export const TextField = forwardRef<TextFieldHandle, TextFieldProps>(function TextField(
  { label, error, helper, secureTextEntry, onFocus, onBlur, ...rest },
  ref,
) {
  const [focused, setFocused] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const isPassword = Boolean(secureTextEntry);
  const required = /\*$/.test(label.trim());
  // The whole box is the touch target, not just the text inside it: a tap on its padding focuses the input.
  const inner = useRef<TextFieldHandle | null>(null);
  const setRefs = (node: TextFieldHandle | null) => {
    inner.current = node;
    if (typeof ref === 'function') ref(node);
    else if (ref) ref.current = node;
  };

  return (
    <View style={styles.wrap}>
      {/* The website's field label (`.ge-field label`): 10.5px bold capitals, tracked, in navy; a required mark is coral. */}
      <Text variant="caption" color="navy800" style={styles.label}>
        {required ? label.replace(/\s*\*$/, '') : label}
        {required ? <Text style={styles.star}>*</Text> : null}
      </Text>
      <Pressable
        accessible={false}
        onPress={() => {
          if (rest.editable !== false) inner.current?.focus();
        }}
        disabled={rest.editable === false}
        style={[
          styles.box,
          focused && styles.boxFocused,
          error ? styles.boxError : null,
          rest.editable === false && styles.boxDisabled,
        ]}
      >
        <TextInput
          ref={setRefs}
          accessibilityLabel={label}
          placeholderTextColor={colors.muted}
          selectionColor={colors.goldInk}
          allowFontScaling
          maxFontSizeMultiplier={2}
          {...rest}
          secureTextEntry={isPassword && !revealed}
          onFocus={(e) => {
            setFocused(true);
            onFocus?.(e);
          }}
          onBlur={(e) => {
            setFocused(false);
            onBlur?.(e);
          }}
          style={styles.input}
        />
        {isPassword ? (
          <Pressable
            onPress={() => setRevealed((v) => !v)}
            accessibilityRole="button"
            accessibilityLabel={revealed ? 'Hide password' : 'Show password'}
            hitSlop={8}
            style={styles.reveal}
          >
            <Ionicons name={revealed ? 'eye-off-outline' : 'eye-outline'} size={22} color={colors.muted} />
          </Pressable>
        ) : null}
      </Pressable>
      {error ? (
        <Text
          variant="small"
          color="danger"
          style={styles.message}
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
        >
          {error}
        </Text>
      ) : helper ? (
        <Text variant="small" color="muted" style={styles.message}>
          {helper}
        </Text>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  wrap: { gap: 7 },
  label: { fontFamily: fontFamily.sansBold, fontSize: 10.5, lineHeight: 16, letterSpacing: 1.26, textTransform: 'uppercase' },
  star: { color: colors.coral },
  // `.ge-field input`: white, a 1px warm edge, 12px corners, 13px by 15px of padding.
  box: {
    minHeight: minTouchTarget + 4,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.white,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.line,
    paddingHorizontal: 15,
  },
  boxFocused: { borderColor: colors.goldInk },
  boxError: { borderColor: colors.danger },
  boxDisabled: { backgroundColor: colors.surface2 },
  input: {
    flex: 1,
    // 16px keeps iOS from zooming the field on focus and matches the site's inputs.
    fontFamily: fontFamily.sans,
    fontSize: 16,
    color: colors.navy800,
    paddingVertical: 13,
  },
  reveal: { marginLeft: spacing.s2, minWidth: 32, minHeight: 32, alignItems: 'center', justifyContent: 'center' },
  message: {},
});
