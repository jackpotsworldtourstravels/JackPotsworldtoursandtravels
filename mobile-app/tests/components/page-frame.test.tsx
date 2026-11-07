import { fireEvent, render, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import { Button, DetailHero, EditorialHero, FormCard, FormSection, PageShell, TextField } from '@/components';

import { resetNavigation, router } from '../helpers/mocks';

jest.mock('expo-router', () => require('../helpers/mocks').routerModule);
jest.mock('@/providers/AuthProvider', () => require('../helpers/mocks').authModule);

beforeEach(() => resetNavigation({}, { pathname: '/', segments: ['gaming'] }));

describe('PageShell: the website’s service-page frame', () => {
  it('prints the breadcrumb, the title and the lede, and its card holds the page', async () => {
    await render(
      <PageShell title="Plan your gaming tour" crumb="Gaming Tour Enquiry" lede="Casino trips are arranged one traveller at a time.">
        <FormCard>
          <FormSection first title="Customer Information" sub="So our team can reach you.">
            <TextField label="Full Name *" value="" onChangeText={() => undefined} />
          </FormSection>
        </FormCard>
      </PageShell>,
    );
    expect(screen.getByRole('header', { name: 'Plan your gaming tour' })).toBeOnTheScreen();
    expect(screen.getByText('Gaming Tour Enquiry')).toBeOnTheScreen();
    expect(screen.getByText('Casino trips are arranged one traveller at a time.')).toBeOnTheScreen();
    // The site's section heading is in tracked capitals, and the field it holds is labelled for assistive tech.
    expect(screen.getByText('CUSTOMER INFORMATION')).toBeOnTheScreen();
    expect(screen.getByLabelText('Full Name *')).toBeOnTheScreen();
  });

  it('the breadcrumb’s Home goes home', async () => {
    await render(
      <PageShell title="Help and support" crumb="Contact Us">
        <FormCard>{null}</FormCard>
      </PageShell>,
    );
    await fireEvent.press(screen.getByRole('link', { name: 'Home' }));
    expect(router.replace).toHaveBeenCalledWith('/');
  });

  it('ends with the website’s footer, as every page of the website does', async () => {
    await render(
      <PageShell title="Help and support">
        <FormCard>{null}</FormCard>
      </PageShell>,
    );
    for (const heading of ['COMPANY', 'TRAVEL', 'LEGAL', 'CONTACT']) expect(screen.getByRole('header', { name: heading })).toBeOnTheScreen();
    expect(screen.getByText(/All Rights Reserved\./)).toBeOnTheScreen();
  });
});

describe('the website’s field and button styles', () => {
  it('marks a required field with a coral star and keeps its accessible name', async () => {
    await render(<TextField label="Email Address *" value="" onChangeText={() => undefined} />);
    expect(screen.getByLabelText('Email Address *')).toBeOnTheScreen();
    const star = screen.getByText('*');
    expect(StyleSheet.flatten(star.props.style).color).toBe('#C9482F');
  });

  it('a field that is not required has no star', async () => {
    await render(<TextField label="Subject (optional)" value="" onChangeText={() => undefined} />);
    expect(screen.queryByText('*')).toBeNull();
  });

  it('the coral button is the site’s solid, 14px-cornered submit', async () => {
    const onPress = jest.fn();
    await render(<Button title="Submit Enquiry" variant="coral" onPress={onPress} />);
    const button = screen.getByRole('button', { name: 'Submit Enquiry' });
    const style = StyleSheet.flatten(button.props.style);
    expect(style.backgroundColor).toBe('#C9482F');
    expect(style.borderRadius).toBe(14);
    await fireEvent.press(button);
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});

describe('EditorialHero', () => {
  it('prints the crumb, the ruled kicker, the title with its italic line, the pill and the summary with Edit', async () => {
    const onAction = jest.fn();
    await render(
      <EditorialHero
        crumb="Hotels"
        kicker="Where you’ll stay"
        title="Hotels in Hyderabad"
        pill="Sample rates"
        ribbon={{ checkIn: '24 Oct', checkOut: '25 Oct' }}
        summary={{ title: 'Hyderabad', sub: 'Sat, 24 Oct – Sun, 25 Oct · 1 room · 2 guests', actionLabel: 'Edit', onAction }}
      />,
    );
    expect(screen.getByText('Hotels')).toBeOnTheScreen();
    expect(screen.getByText('WHERE YOU’LL STAY')).toBeOnTheScreen();
    expect(screen.getByRole('header', { name: 'Hotels in Hyderabad' })).toBeOnTheScreen();
    expect(screen.getByText('SAMPLE RATES')).toBeOnTheScreen();
    expect(screen.getByLabelText('Check-in 24 Oct, check-out 25 Oct')).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Edit' }));
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it('reads as one heading when its title has a second, italic line', async () => {
    await render(<EditorialHero crumb="Tour packages" kicker="Tour packages" title="Journeys," accent="already planned." uppercase />);
    expect(screen.getByRole('header', { name: 'Journeys, already planned.' })).toBeOnTheScreen();
  });

  it('has no Edit button when there is nothing to edit', async () => {
    await render(<EditorialHero crumb="Destinations" kicker="15 destinations · 6 countries" title="Where will" accent="you go?" />);
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
  });
});

describe('DetailHero', () => {
  it('shows the place, the name, how long, the price and the one next step', async () => {
    const onPress = jest.fn();
    await render(
      <DetailHero
        photoAlt="Goa, a photograph of the destination"
        kicker="Goa"
        place="Goa, India"
        title="Goa"
        lede="North and South Goa beaches."
        chips={['4 Days / 3 Nights']}
        price={{ label: 'Starting from', amount: '₹21,900', per: 'per person' }}
        action={{ label: 'Enquire about dates', onPress }}
        note="This trip has no scheduled departures at the moment."
      />,
    );
    expect(screen.getByRole('header', { name: 'Goa' })).toBeOnTheScreen();
    expect(screen.getByText('Goa, India')).toBeOnTheScreen();
    expect(screen.getByText('4 Days / 3 Nights')).toBeOnTheScreen();
    expect(screen.getByText('STARTING FROM')).toBeOnTheScreen();
    expect(screen.getByText('₹21,900')).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Enquire about dates' }));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('takes chips with their own icons, for a hotel’s stars, score and distance', async () => {
    await render(
      <DetailHero
        photoAlt="Hotel"
        title="Taj Palace"
        chips={[
          { label: '5-star hotel', icon: 'star-outline' },
          { label: '4.6 Excellent', icon: 'ribbon-outline' },
        ]}
      />,
    );
    expect(screen.getByText('5-star hotel')).toBeOnTheScreen();
    expect(screen.getByText('4.6 Excellent')).toBeOnTheScreen();
  });
});
