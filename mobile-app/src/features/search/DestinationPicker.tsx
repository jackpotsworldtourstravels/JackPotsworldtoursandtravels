import { useMemo, useState } from 'react';
import { FlatList, Pressable, StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { BottomSheet } from '@/components/BottomSheet';
import { ErrorState, LoadingState } from '@/components/states';
import { Text } from '@/components/Text';
import { TextField } from '@/components/TextField';
import { FieldButton } from '@/components/pickers';
import { useDestinations } from '@/features/discovery/hooks';
import { colors, spacing } from '@/theme';
import type { Destination } from '@/types/discovery';

import { filterDestinations } from './destinations';

/**
 * Pick a destination from the backend's list, with search. `anyLabel` adds a
 * first row that clears the choice ("Anywhere"); leave it out when a destination
 * is required.
 */
export function DestinationPicker({
  label = 'Destination',
  value,
  onChange,
  anyLabel,
  placeholder = 'Choose a destination',
}: {
  label?: string;
  value: Destination | null;
  onChange: (destination: Destination | null) => void;
  anyLabel?: string;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const destinations = useDestinations();

  const visible = useMemo(
    () => filterDestinations(destinations.data ?? [], query),
    [destinations.data, query],
  );

  const close = () => {
    setOpen(false);
    setQuery('');
  };
  const choose = (destination: Destination | null) => {
    onChange(destination);
    close();
  };

  return (
    <>
      <FieldButton
        label={label}
        value={value?.name ?? anyLabel}
        placeholder={placeholder}
        icon="location-outline"
        onPress={() => setOpen(true)}
      />
      <BottomSheet visible={open} title={label} onClose={close}>
        <TextField
          label="Search"
          value={query}
          onChangeText={setQuery}
          placeholder="City, region or country"
          autoCorrect={false}
          returnKeyType="search"
        />
        {destinations.isPending ? (
          <LoadingState message="Loading destinations…" />
        ) : destinations.isError ? (
          <ErrorState error={destinations.error} onRetry={() => void destinations.refetch()} />
        ) : (
          <FlatList
            data={visible}
            keyExtractor={(d) => d.id}
            keyboardShouldPersistTaps="handled"
            style={styles.list}
            ListHeaderComponent={
              anyLabel && query.trim() === '' ? (
                <Row label={anyLabel} selected={value === null} onPress={() => choose(null)} />
              ) : undefined
            }
            ListEmptyComponent={
              <Text variant="body" color="muted" align="center" style={styles.empty}>
                No destination matches “{query.trim()}”.
              </Text>
            }
            renderItem={({ item }) => (
              <Row
                label={item.name}
                sublabel={item.country ?? undefined}
                selected={value?.id === item.id}
                onPress={() => choose(item)}
              />
            )}
          />
        )}
      </BottomSheet>
    </>
  );
}

function Row({
  label,
  sublabel,
  selected,
  onPress,
}: {
  label: string;
  sublabel?: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={sublabel ? `${label}, ${sublabel}` : label}
      accessibilityState={{ selected }}
      style={styles.row}
    >
      <View style={styles.rowText}>
        <Text variant="bodyStrong">{label}</Text>
        {sublabel ? (
          <Text variant="small" color="muted">
            {sublabel}
          </Text>
        ) : null}
      </View>
      {selected ? <Ionicons name="checkmark-circle" size={22} color={colors.goldInk} /> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  list: { flexGrow: 0 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 56,
    paddingVertical: spacing.s2,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
    gap: spacing.s3,
  },
  rowText: { flex: 1 },
  empty: { paddingVertical: spacing.s6 },
});
