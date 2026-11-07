import { fireEvent, render, screen, within } from '@testing-library/react-native';
import { useState } from 'react';

import { Calendar } from '@/components/Calendar';
import { GuestsField } from '@/components/pickers';
import { DestinationCard, HotelCard, OfferCard, PackageCard } from '@/features/discovery/cards';
import { fromListItem, photoForListItem } from '@/features/discovery/hotels';
import { DEFAULT_PARTY, type Party } from '@/features/search/party';

import { coupons, destinations, hotelList, packages } from '../fixtures/discovery';

describe('Calendar', () => {
  const props = { value: '2026-11-05', min: '2026-10-22', max: '2027-10-21', today: '2026-10-21' };

  it('picks a date and reports it as an ISO string', async () => {
    const onSelect = jest.fn();
    await render(<Calendar {...props} onSelect={onSelect} />);
    await fireEvent.press(screen.getByRole('button', { name: /^Saturday 14 November 2026/ }));
    expect(onSelect).toHaveBeenCalledWith('2026-11-14');
  });

  it('marks the chosen day as selected for screen readers', async () => {
    await render(<Calendar {...props} onSelect={jest.fn()} />);
    expect(screen.getByRole('button', { name: /^Thursday 5 November 2026/ })).toBeSelected();
  });

  it('will not let a day before the minimum be chosen', async () => {
    const onSelect = jest.fn();
    await render(<Calendar {...props} value="2026-10-25" onSelect={onSelect} />);
    const past = screen.getByRole('button', { name: /^Wednesday 21 October 2026, today/ });
    expect(past).toBeDisabled();
    await fireEvent.press(past);
    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /^Thursday 22 October 2026/ })).toBeEnabled();
  });

  it('stops the arrows at the first and last month in range', async () => {
    await render(<Calendar {...props} value="2026-10-25" onSelect={jest.fn()} />);
    expect(screen.getByRole('button', { name: 'Previous month' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Next month' })).toBeEnabled();
    await fireEvent.press(screen.getByRole('button', { name: 'Next month' }));
    expect(screen.getByText('November 2026')).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Previous month' })).toBeEnabled();
  });

  it('disables the next arrow in the last month', async () => {
    await render(<Calendar {...props} value="2027-10-10" onSelect={jest.fn()} />);
    expect(screen.getByText('October 2027')).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Next month' })).toBeDisabled();
  });
});

describe('GuestsField', () => {
  function Harness({ initial = DEFAULT_PARTY }: { initial?: Party }) {
    const [party, setParty] = useState(initial);
    return <GuestsField value={party} onChange={setParty} />;
  }

  async function openSheet() {
    await render(<Harness />);
    await fireEvent.press(screen.getByRole('button', { name: /Guests and rooms:/ }));
  }

  it('summarises the party on the field', async () => {
    await render(<Harness />);
    expect(screen.getByRole('button', { name: 'Guests and rooms: 1 room · 2 adults' })).toBeOnTheScreen();
  });

  it('adds a child and updates the summary', async () => {
    await openSheet();
    await fireEvent.press(screen.getByRole('button', { name: 'More children' }));
    expect(screen.getByRole('button', { name: 'Guests and rooms: 1 room · 2 adults · 1 child' })).toBeOnTheScreen();
  });

  it('cannot drop below one adult per room: adding rooms raises adults', async () => {
    await render(<Harness initial={{ rooms: 1, adults: 1, children: 0 }} />);
    await fireEvent.press(screen.getByRole('button', { name: /Guests and rooms:/ }));
    await fireEvent.press(screen.getByRole('button', { name: 'More rooms' }));
    await fireEvent.press(screen.getByRole('button', { name: 'More rooms' }));
    expect(screen.getByRole('button', { name: /3 rooms · 3 adults/ })).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Fewer adults' })).toBeDisabled();
  });

  it('stops at the backend’s limits', async () => {
    await render(<Harness initial={{ rooms: 4, adults: 32, children: 16 }} />);
    await fireEvent.press(screen.getByRole('button', { name: /Guests and rooms:/ }));
    expect(screen.getByRole('button', { name: 'More rooms' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'More adults' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'More children' })).toBeDisabled();
  });
});

describe('cards', () => {
  const taj = hotelList[0];

  it('HotelCard shows the indicative price, and says a city photo is not this hotel', async () => {
    await render(<HotelCard hotel={fromListItem(taj)} photo={photoForListItem(taj)} />);
    expect(screen.getByText('Taj Palace')).toBeOnTheScreen();
    expect(screen.getByText(/₹12,500/)).toBeOnTheScreen();
    expect(screen.getByText('Destination photo, not this hotel')).toBeOnTheScreen();
    expect(screen.getByText('Free cancellation')).toBeOnTheScreen();
    expect(screen.getByLabelText(/Taj Palace, 5 star.*from ₹12,500 per night/)).toBeOnTheScreen();
  });

  it('HotelCard shows no caption for a verified property photo', async () => {
    const novotel = hotelList.find((h) => h.name === 'Novotel Bengaluru')!;
    await render(<HotelCard hotel={fromListItem(novotel)} photo={photoForListItem(novotel)} />);
    expect(screen.queryByText(/not this hotel/i)).toBeNull();
  });

  it('PackageCard leads with the next departure’s price and date', async () => {
    await render(<PackageCard pkg={packages[0]} />);
    expect(screen.getByText('NEXT DEPARTURE FROM')).toBeOnTheScreen();
    expect(screen.getByText(/₹30,900/)).toBeOnTheScreen();
    expect(screen.getByText('Next Sat, 24 Oct')).toBeOnTheScreen();
    expect(screen.queryByText(/₹21,900/)).toBeNull(); // the stale "from" price is not shown
  });

  it('PackageCard says plainly when no departure is listed', async () => {
    await render(<PackageCard pkg={packages[1]} />);
    expect(screen.getByText('FROM')).toBeOnTheScreen();
    expect(screen.getByText('Dates on request')).toBeOnTheScreen();
    expect(screen.getByLabelText(/no departure dates listed/)).toBeOnTheScreen();
  });

  it('OfferCard shows the discount, title and code', async () => {
    await render(<OfferCard coupon={coupons.hotel[0]} width={260} />);
    expect(screen.getByText('40% off')).toBeOnTheScreen();
    expect(screen.getByText('STAYMORE')).toBeOnTheScreen();
  });

  it('DestinationCard opens its destination', async () => {
    const onPress = jest.fn();
    await render(<DestinationCard destination={destinations[3]} onPress={onPress} width={150} />);
    await fireEvent.press(screen.getByRole('button', { name: 'Explore Bali, Indonesia' }));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('keeps the card readable for screen readers as one summary', async () => {
    await render(<PackageCard pkg={packages[3]} />);
    const card = screen.getByLabelText(/^Dubai, Dubai, United Arab Emirates, 4 nights \/ 5 days/);
    expect(within(card).getByText('INTERNATIONAL')).toBeOnTheScreen();
  });
});
