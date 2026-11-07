import { Card } from './Card';
import { Text } from './Text';

/**
 * A placeholder for a section whose screens are built in a later phase.
 *
 * It states plainly that the section is not ready rather than drawing controls
 * that do nothing. Remove each use as the real screen lands.
 */
export function ComingSoon({ title, message }: { title: string; message: string }) {
  return (
    <Card>
      <Text variant="eyebrow" color="goldInk">
        Coming soon
      </Text>
      <Text variant="h2" color="navy800" accessibilityRole="header">
        {title}
      </Text>
      <Text variant="body" color="muted">
        {message}
      </Text>
    </Card>
  );
}
