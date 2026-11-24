import { addDays, todayISO, type ISODate } from '@/utils/dates';

import { SAMPLE_AIRLINES, type SampleAirline } from './sample';

/**
 * ONE SAMPLE FLIGHT BOOKING, for previewing the screens after booking (the booked flight, its e-ticket, managing and
 * cancelling it). No flight booking can exist until a supplier is connected, so these screens are reached only from
 * the development preview and always say they show sample data.
 */

export interface BookedSegment {
  from: string;
  fromCity: string;
  fromAirport: string;
  to: string;
  toCity: string;
  toAirport: string;
  date: ISODate;
  dep: string;
  arr: string;
  minutes: number;
  airline: SampleAirline;
  number: string;
  pnr: string;
  fare: string;
  price: number;
}

export interface BookedTraveller {
  title: string;
  name: string;
  seats: string[];
  meal: string | null;
  checkinKg: number;
}

export interface SampleFlightBooking {
  ref: string;
  paid: number;
  paidOn: ISODate;
  segments: BookedSegment[];
  travellers: BookedTraveller[];
}

export function sampleFlightBooking(today: ISODate = todayISO()): SampleFlightBooking {
  const first = addDays(today, 11);
  return {
    ref: 'JPF-SAMPLE',
    paid: 27680,
    paidOn: today,
    segments: [
      {
        from: 'HYD',
        fromCity: 'Hyderabad',
        fromAirport: 'Rajiv Gandhi International Airport',
        to: 'DEL',
        toCity: 'Delhi',
        toAirport: 'Indira Gandhi International Airport',
        date: first,
        dep: '06:10',
        arr: '08:20',
        minutes: 130,
        airline: SAMPLE_AIRLINES[1],
        number: 'MA 214',
        pnr: 'K7QX2M',
        fare: 'Saver',
        price: 6150,
      },
      {
        from: 'DEL',
        fromCity: 'Delhi',
        fromAirport: 'Indira Gandhi International Airport',
        to: 'CCU',
        toCity: 'Kolkata',
        toAirport: 'Netaji Subhas Chandra Bose International Airport',
        date: addDays(first, 4),
        dep: '07:15',
        arr: '09:20',
        minutes: 125,
        airline: SAMPLE_AIRLINES[0],
        number: 'SA 518',
        pnr: 'W3PZ8R',
        fare: 'Saver',
        price: 5840,
      },
    ],
    travellers: [
      { title: 'Ms', name: 'Asha Rao', seats: ['12C', '—'], meal: 'Paneer tikka sandwich', checkinKg: 15 },
      { title: 'Mr', name: 'Ravi Rao', seats: ['12D', '—'], meal: 'Chicken biryani', checkinKg: 20 },
    ],
  };
}

/** Days from today to a date, for "In 11 days". */
export function daysUntil(date: ISODate, today: ISODate = todayISO()): number {
  return Math.round((new Date(`${date}T00:00:00`).getTime() - new Date(`${today}T00:00:00`).getTime()) / 86_400_000);
}
