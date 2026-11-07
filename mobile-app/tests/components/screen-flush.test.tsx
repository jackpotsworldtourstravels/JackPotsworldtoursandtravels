import { render } from '@testing-library/react-native';
import { Text as RNText } from 'react-native';

import { CONTENT_MAX_WIDTH, Screen } from '@/components';

/** `flush` is for Home's full-width bands. Every other screen keeps its gutters and reading column. */
async function tree(props: { flush?: boolean }) {
  const view = await render(
    <Screen scroll {...props}>
      <RNText>hello</RNText>
    </Screen>,
  );
  return JSON.stringify(view.toJSON());
}

describe('Screen', () => {
  it('by default pads the sides and holds content to the reading column', async () => {
    const json = await tree({});
    expect(json).toContain(`"maxWidth":${CONTENT_MAX_WIDTH}`);
    expect(json).toContain('"paddingLeft":16');
    expect(json).toContain('"paddingRight":16');
  });

  it('flush removes the gutters and the column cap, and nothing else changes for other screens', async () => {
    const json = await tree({ flush: true });
    // The later style in the list wins: the column's 640 cap is overridden, not just dropped.
    expect(json).toContain('"maxWidth":"100%"');
    expect(json).toContain('"paddingLeft":0');
    expect(json).toContain('"paddingRight":0');
  });
});
