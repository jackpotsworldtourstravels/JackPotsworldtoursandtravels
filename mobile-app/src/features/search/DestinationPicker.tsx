import { useMemo, useState } from 'react';

import { SearchListScreen } from '@/components/SearchListScreen';
import { ErrorState, LoadingState } from '@/components/states';
import { Text } from '@/components/Text';
import { FieldButton } from '@/components/pickers';
import { FieldCard } from '@/components/ui';
import { useDestinations } from '@/features/discovery/hooks';
import type { Destination } from '@/types/discovery';

import { filterDestinations } from './destinations';

/**
 * Pick a destination from the backend's list on a full-screen search page. `anyLabel` adds a first row that
 * clears the choice ("All destinations"); leave it out when a destination is required. `card` is the search
 * form's big field card; `tile` the compact field inside a page.
 */
export function DestinationPicker({
  label = 'Destination',
  value,
  onChange,
  anyLabel,
  placeholder = 'Choose a destination',
  appearance = 'tile',
}: {
  label?: string;
  value: Destination | null;
  onChange: (destination: Destination | null) => void;
  anyLabel?: string;
  placeholder?: string;
  appearance?: 'tile' | 'card';
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const destinations = useDestinations();

  const visible = useMemo(() => filterDestinations(destinations.data ?? [], query), [destinations.data, query]);

  const close = () => {
    setOpen(false);
    setQuery('');
  };
  const choose = (destination: Destination | null) => {
    onChange(destination);
    close();
  };

  const shown = value?.name ?? anyLabel;
  return (
    <>
      {appearance === 'card' ? (
        <FieldCard
          label={label}
          value={shown}
          sub={value ? (value.country ?? undefined) : anyLabel ? 'Tap to choose a city' : undefined}
          placeholder={placeholder}
          accessibilityLabel={`${label}: ${shown ?? placeholder}`}
          onPress={() => setOpen(true)}
        />
      ) : (
        <FieldButton label={label} value={shown} placeholder={placeholder} icon="location-outline" onPress={() => setOpen(true)} />
      )}
      <SearchListScreen
        visible={open}
        title={label}
        query={query}
        onQueryChange={setQuery}
        placeholder="City, region or country"
        onClose={close}
        header={
          destinations.isPending ? (
            <LoadingState message="Loading destinations…" />
          ) : destinations.isError ? (
            <ErrorState error={destinations.error} onRetry={() => void destinations.refetch()} />
          ) : undefined
        }
        empty={
          <Text variant="body" color="textSecondary" align="center">
            No destination matches “{query.trim()}”.
          </Text>
        }
        sections={[
          ...(anyLabel && query.trim() === ''
            ? [{ title: 'Anywhere', data: [{ key: '__any', title: anyLabel, icon: 'globe-outline' as const, selected: value === null, onPress: () => choose(null) }] }]
            : []),
          {
            title: query.trim() === '' ? 'Destinations' : 'Matches',
            data: visible.map((d) => ({
              key: d.id,
              title: d.name,
              subtitle: d.country ?? undefined,
              icon: 'location-outline' as const,
              selected: value?.id === d.id,
              onPress: () => choose(d),
            })),
          },
        ]}
      />
    </>
  );
}
