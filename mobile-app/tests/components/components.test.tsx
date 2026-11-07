import { fireEvent, render, screen } from '@testing-library/react-native';
import { createRef, useState } from 'react';

import { ApiError } from '@/api/errors';
import { Banner, Button, EmptyState, ErrorState, LoadingState, TextField, type TextFieldHandle } from '@/components';

describe('Button', () => {
  it('presses through when idle', async () => {
    const onPress = jest.fn();
    await render(<Button title="Search hotels" onPress={onPress} />);
    await fireEvent.press(screen.getByRole('button', { name: 'Search hotels' }));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('ignores presses while loading, so a slow request can’t be fired twice', async () => {
    const onPress = jest.fn();
    await render(<Button title="Pay now" onPress={onPress} loading />);
    const button = screen.getByRole('button', { name: 'Pay now' });
    await fireEvent.press(button);
    await fireEvent.press(button);
    expect(onPress).not.toHaveBeenCalled();
    expect(button).toBeBusy();
  });

  it('ignores presses when disabled and says so to assistive tech', async () => {
    const onPress = jest.fn();
    await render(<Button title="Continue" onPress={onPress} disabled />);
    const button = screen.getByRole('button', { name: 'Continue' });
    await fireEvent.press(button);
    expect(onPress).not.toHaveBeenCalled();
    expect(button).toBeDisabled();
  });

  it('meets the minimum touch-target height', async () => {
    await render(<Button title="Go" onPress={() => undefined} />);
    const style = screen.getByRole('button', { name: 'Go' }).props.style;
    const flat = Array.isArray(style) ? Object.assign({}, ...style.flat(Infinity).filter(Boolean)) : style;
    expect(flat.minHeight).toBeGreaterThanOrEqual(48);
  });
});

describe('TextField touch target', () => {
  afterEach(() => jest.restoreAllMocks());

  it('focuses the input when the field’s padding is tapped, and hands the same input to a parent ref', async () => {
    const ref = createRef<TextFieldHandle>();
    await render(<TextField ref={ref} label="Name" value="" onChangeText={() => undefined} />);
    const input = screen.getByLabelText('Name');
    const focus = jest.spyOn(ref.current as TextFieldHandle, 'focus');
    focus.mockClear(); // the underlying mock is shared between tests
    // the box around the input is the thing a thumb lands on
    await fireEvent.press(input.parent!);
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it('does not take taps when it is read-only', async () => {
    const ref = createRef<TextFieldHandle>();
    await render(<TextField ref={ref} label="Email" value="a@b.co" editable={false} onChangeText={() => undefined} />);
    const focus = jest.spyOn(ref.current as TextFieldHandle, 'focus');
    focus.mockClear(); // the underlying mock is shared between tests
    await fireEvent.press(screen.getByLabelText('Email').parent!);
    expect(focus).not.toHaveBeenCalled();
  });
});

describe('TextField', () => {
  function Harness({ error }: { error?: string }) {
    const [value, setValue] = useState('');
    return <TextField label="Email" value={value} onChangeText={setValue} error={error} />;
  }

  it('is labelled for screen readers and accepts typing', async () => {
    await render(<Harness />);
    const input = screen.getByLabelText('Email');
    await fireEvent.changeText(input, 'asha@example.com');
    expect(screen.getByLabelText('Email').props.value).toBe('asha@example.com');
  });

  it('shows its error as an alert', async () => {
    await render(<Harness error="Enter a valid email address." />);
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a valid email address.');
  });

  it('hides a password until asked, and can reveal it', async () => {
    function Password() {
      const [value, setValue] = useState('secret');
      return <TextField label="Password" value={value} onChangeText={setValue} secureTextEntry />;
    }
    await render(<Password />);
    expect(screen.getByLabelText('Password').props.secureTextEntry).toBe(true);
    await fireEvent.press(screen.getByRole('button', { name: 'Show password' }));
    expect(screen.getByLabelText('Password').props.secureTextEntry).toBe(false);
    expect(screen.getByRole('button', { name: 'Hide password' })).toBeOnTheScreen();
  });
});

describe('state components', () => {
  it('ErrorState says "offline" for a network error and offers a retry', async () => {
    const onRetry = jest.fn();
    await render(<ErrorState error={new ApiError('network')} onRetry={onRetry} />);
    expect(screen.getByText("You're offline")).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('ErrorState shows a safe message for an unknown failure', async () => {
    await render(<ErrorState error={new Error('TypeError: x is undefined at line 4')} />);
    expect(screen.getByText('Something went wrong')).toBeOnTheScreen();
    expect(screen.queryByText(/TypeError/)).toBeNull();
  });

  it('EmptyState runs its action', async () => {
    const onAction = jest.fn();
    await render(<EmptyState title="No bookings yet" actionLabel="Explore hotels" onAction={onAction} />);
    await fireEvent.press(screen.getByRole('button', { name: 'Explore hotels' }));
    expect(onAction).toHaveBeenCalled();
  });

  it('LoadingState announces what is loading', async () => {
    await render(<LoadingState message="Loading hotels…" />);
    expect(screen.getByText('Loading hotels…')).toBeOnTheScreen();
  });

  it('Banner renders its message', async () => {
    await render(<Banner tone="error" message="Payment failed." />);
    expect(screen.getByText('Payment failed.')).toBeOnTheScreen();
  });
});
