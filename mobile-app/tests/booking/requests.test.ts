import {
  buildHotelBooking,
  buildHotelQuoteRequest,
  buildStay,
  emptyHotelForm,
  hotelFormSchema,
  normaliseCoupon,
  roomFits,
} from '@/features/booking/hotelRequest';
import {
  MIN_PASSPORT_MONTHS,
  bookableDepartures,
  buildPackageBooking,
  buildTrip,
  emptyPackageForm,
  maxTravellers,
  packageFormSchema,
  passportMonthsRemaining,
} from '@/features/booking/packageRequest';
import { parseBookingRef, parseId } from '@/features/booking/refs';
import type { Party } from '@/features/search/party';
import { addDays, todayISO } from '@/utils/dates';

import { IN_30, LAST_MONTH, packageDetail } from '../fixtures/booking';

const MONEY_KEY = /price|amount|total|tax|currency|fare|cost|fee|discount|subtotal/i;

/** Every key anywhere in a request: none may be a money field, because the backend has none to read. */
function keysOf(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach((v) => keysOf(v, out));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      out.push(k);
      keysOf(v, out);
    }
  }
  return out;
}

const party: Party = { rooms: 1, adults: 2, children: 1 };
const stay = buildStay({ hotelId: 1, roomId: 2, stay: { checkIn: '2026-11-05', checkOut: '2026-11-08' }, party });

describe('hotel booking request', () => {
  const schema = hotelFormSchema(3);
  const good = {
    guests: [
      { first_name: ' Asha ', last_name: 'Rao' },
      { first_name: 'Ravi', last_name: 'Rao' },
      { first_name: 'Mira', last_name: 'Rao' },
    ],
    email: 'asha@example.com',
    mobile: '+91 98765-43210',
    notes: '',
  };

  it('maps the stay without a single money field', () => {
    expect(stay).toEqual({
      hotel_id: 1, room_id: 2, check_in: '2026-11-05', check_out: '2026-11-08', rooms_count: 1, adults: 2, children: 1,
    });
  });

  it('makes the first adult the one booking contact, adults before children', () => {
    const values = schema.parse(good);
    const body = buildHotelBooking({ stay, values });
    expect(body.guests.map((g) => [g.first_name, g.guest_type, g.is_contact])).toEqual([
      ['Asha', 'adult', true],
      ['Ravi', 'adult', false],
      ['Mira', 'child', false],
    ]);
    expect(body.guests.filter((g) => g.is_contact)).toHaveLength(1);
    expect(body.guests[0]).toMatchObject({ email: 'asha@example.com', mobile: '+919876543210' });
    expect(body.guests[1]).not.toHaveProperty('email');
  });

  it('sends nothing the server could mistake for a price', () => {
    const body = { ...buildHotelBooking({ stay, values: schema.parse(good), coupon: ' staymore ' }), idempotency_key: 'k-12345678' };
    const money = keysOf(body).filter((k) => MONEY_KEY.test(k));
    expect(money).toEqual([]);
    expect(body.coupon_code).toBe('STAYMORE');
    expect(keysOf(buildHotelQuoteRequest(stay, 'x')).filter((k) => MONEY_KEY.test(k))).toEqual([]);
  });

  it('requires a name for everyone, a valid email and a valid mobile', () => {
    expect(schema.safeParse({ ...good, guests: [{ first_name: '', last_name: 'Rao' }, good.guests[1], good.guests[2]] }).success).toBe(false);
    expect(schema.safeParse({ ...good, email: 'asha@' }).success).toBe(false);
    expect(schema.safeParse({ ...good, mobile: '12345' }).success).toBe(false);
    expect(schema.safeParse({ ...good, guests: good.guests.slice(0, 2) }).success).toBe(false); // wrong head-count
    expect(schema.safeParse({ ...good, notes: 'x'.repeat(501) }).success).toBe(false);
  });

  it('tidies names and the mobile number the way the server will', () => {
    const out = schema.parse({ ...good, guests: [{ first_name: '  Asha   Devi ', last_name: 'Rao' }, good.guests[1], good.guests[2]] });
    expect(out.guests[0].first_name).toBe('Asha Devi');
    expect(out.mobile).toBe('+919876543210');
  });

  it('starts with one empty row per person, prefilling only the contact', () => {
    const form = emptyHotelForm(party, { firstName: 'Asha', lastName: 'Rao', email: 'a@b.co', mobile: '+911234567890' });
    expect(form.guests).toHaveLength(3);
    expect(form.guests[0]).toEqual({ first_name: 'Asha', last_name: 'Rao' });
    expect(form.guests[1]).toEqual({ first_name: '', last_name: '' });
  });

  it('normalises coupon codes and a room fit', () => {
    expect(normaliseCoupon('  staymore ')).toBe('STAYMORE');
    expect(normaliseCoupon('   ')).toBeUndefined();
    expect(normaliseCoupon(null)).toBeUndefined();
    expect(normaliseCoupon('x'.repeat(60))).toHaveLength(40);
    expect(roomFits(2, { rooms: 1, adults: 2, children: 0 })).toBe(true);
    expect(roomFits(2, { rooms: 1, adults: 2, children: 1 })).toBe(false);
    expect(roomFits(2, { rooms: 2, adults: 2, children: 2 })).toBe(true);
  });
});

describe('passport rule, mirrored from the server', () => {
  it('counts whole months from departure to expiry, the way the server does', () => {
    expect(passportMonthsRemaining('2027-04-24', '2026-10-24')).toBe(6);
    expect(passportMonthsRemaining('2027-04-23', '2026-10-24')).toBe(5); // a day short of six months
    expect(passportMonthsRemaining('2027-04-30', '2026-10-31')).toBe(5); // expiry day < departure day
    expect(passportMonthsRemaining('2026-10-24', '2026-10-24')).toBe(0);
    expect(passportMonthsRemaining('2028-01-15', '2026-10-24')).toBe(14);
    expect(MIN_PASSPORT_MONTHS).toBe(6);
  });
});

describe('package booking request', () => {
  const departure = '2026-10-24';
  const domestic = packageFormSchema({ international: false, departure, count: 2 });
  const abroad = packageFormSchema({ international: true, departure, count: 2 });
  const traveller = (over = {}) => ({ traveller_type: 'adult' as const, first_name: 'Asha', last_name: 'Rao', passport_number: '', passport_expiry: '', ...over });
  const withPassport = (expiry: string) => traveller({ passport_number: 'N1234567', passport_expiry: expiry });
  const contact = { email: 'asha@example.com', mobile: '+919876543210' };

  it('needs no passport for a domestic trip', () => {
    expect(domestic.safeParse({ travellers: [traveller(), traveller({ first_name: 'Ravi' })], ...contact }).success).toBe(true);
  });

  it('needs a passport number and expiry for an international trip', () => {
    const result = abroad.safeParse({ travellers: [traveller(), withPassport('2027-04-24')], ...contact });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((i) => i.path.join('.'))).toEqual(
      expect.arrayContaining(['travellers.0.passport_number', 'travellers.0.passport_expiry']),
    );
  });

  it('accepts a passport valid for exactly six months and refuses one day short', () => {
    expect(abroad.safeParse({ travellers: [withPassport('2027-04-24'), withPassport('2027-04-24')], ...contact }).success).toBe(true);
    const short = abroad.safeParse({ travellers: [withPassport('2027-04-23'), withPassport('2027-04-24')], ...contact });
    expect(short.success).toBe(false);
    expect(short.error?.issues[0].message).toMatch(/at least 6 months/);
  });

  it('refuses an expiry that is not a real date', () => {
    for (const bad of ['30/05/2032', '2032-02-30', 'soon']) {
      expect(abroad.safeParse({ travellers: [withPassport(bad), withPassport('2027-04-24')], ...contact }).success).toBe(false);
    }
  });

  it('needs at least one adult and the right number of travellers', () => {
    const kids = [traveller({ traveller_type: 'child' }), traveller({ traveller_type: 'infant' })];
    const result = domestic.safeParse({ travellers: kids, ...contact });
    expect(result.success).toBe(false);
    expect(domestic.safeParse({ travellers: [traveller()], ...contact }).success).toBe(false);
  });

  it('builds the booking: one contact, passports only when international, no money anywhere', () => {
    const trip = buildTrip({ packageId: 12, departureId: 80, pax: 2 });
    const values = abroad.parse({ travellers: [withPassport('2027-04-24'), withPassport('2028-01-01')], ...contact });
    const body = { ...buildPackageBooking({ trip, values, international: true, coupon: 'together25' }), idempotency_key: 'k-12345678' };

    expect(trip).toEqual({ package_id: 12, departure_id: 80, pax_count: 2 });
    expect(body.travellers.filter((t) => t.is_contact)).toHaveLength(1);
    expect(body.travellers[0]).toMatchObject({ passport_number: 'N1234567', email: 'asha@example.com' });
    expect(body.travellers[1]).not.toHaveProperty('email');
    expect(body.coupon_code).toBe('TOGETHER25');
    expect(keysOf(body).filter((k) => MONEY_KEY.test(k))).toEqual([]);

    const home = buildPackageBooking({ trip, values: domestic.parse({ travellers: [traveller(), traveller()], ...contact }), international: false });
    expect(home.travellers[0]).not.toHaveProperty('passport_number');
  });

  it('starts with an adult row per traveller', () => {
    const form = emptyPackageForm(3, { firstName: 'Asha', email: 'a@b.co' });
    expect(form.travellers).toHaveLength(3);
    expect(form.travellers.every((t) => t.traveller_type === 'adult')).toBe(true);
    expect(form.travellers[0].first_name).toBe('Asha');
  });
});

describe('departures', () => {
  it('offers only departures that are still ahead and have seats, soonest first', () => {
    const pkg = packageDetail();
    const open = bookableDepartures(pkg.departures);
    expect(open.map((d) => d.id)).toEqual([55]); // 49 has left, 56 is sold out
  });

  it('allows today, drops yesterday and malformed dates', () => {
    const today = todayISO();
    const list = [
      { id: 1, date: addDays(today, -1), price: '1', seats_left: 5 },
      { id: 2, date: today, price: '1', seats_left: 5 },
      { id: 3, date: 'garbage', price: '1', seats_left: 5 },
      { id: 4, date: addDays(today, 3), price: '1', seats_left: 1 },
    ];
    expect(bookableDepartures(list).map((d) => d.id)).toEqual([2, 4]);
  });

  it('caps travellers at the seats left and at twelve', () => {
    expect(maxTravellers({ seats_left: 4 })).toBe(4);
    expect(maxTravellers({ seats_left: 40 })).toBe(12);
    expect(maxTravellers({ seats_left: 0 })).toBe(0);
    expect(IN_30 > LAST_MONTH).toBe(true);
  });
});

describe('route parameters', () => {
  it('parses booking references by shape only', () => {
    expect(parseBookingRef('JPH000123')).toEqual({ ref: 'JPH000123', kind: 'hotel' });
    expect(parseBookingRef(' jpp000045 ')).toEqual({ ref: 'JPP000045', kind: 'package' });
    expect(parseBookingRef('JPB000027')?.kind).toBe('flight');
  });

  it.each(['', 'JPX000123', 'JPH12', '../JPH000123', 'JPH000123/cancel', 'JPH000123?x=1', null, undefined])('refuses %p', (value) => {
    expect(parseBookingRef(value as string)).toBeNull();
  });

  it('parses ids as positive integers only', () => {
    expect(parseId('12')).toBe(12);
    expect(parseId(['7'])).toBe(7);
    for (const bad of ['0', '-1', '1.5', 'abc', '', '12; DROP', '1234567890', undefined, null]) expect(parseId(bad as string)).toBeNull();
  });
});
