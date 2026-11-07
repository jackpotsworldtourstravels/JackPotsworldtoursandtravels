import { EMPTY_GAMING_FORM, gamingErrors, gamingRequest, type GamingForm } from '@/features/gaming/gamingForm';

const valid: GamingForm = {
  name: ' Asha Rao ',
  email: ' asha@example.com ',
  mobile: ' +91 98765 43210 ',
  from: ' Hyderabad (HYD) ',
  to: 'Bangkok (BKK)',
  date: '2026-11-20',
  time: '10:00',
  nights: '3',
  casino: ' Poker rooms ',
};

describe('the gaming enquiry rules (the website’s)', () => {
  it('an empty form is refused field by field, in the website’s words', () => {
    expect(gamingErrors(EMPTY_GAMING_FORM)).toEqual({
      name: 'Please enter your full name.',
      email: 'Please enter your email address.',
      mobile: 'Please enter your mobile number.',
      from: 'Please enter a departure airport.',
      to: 'Please enter an arrival airport.',
      datetime: 'Please choose a travel date and time.',
      nights: 'Please enter the number of nights (1 or more).',
      casino: 'Please tell us your casino preference.',
    });
  });

  it('a complete form is accepted', () => {
    expect(gamingErrors(valid)).toEqual({});
  });

  it('checks the shape of the email and mobile', () => {
    expect(gamingErrors({ ...valid, email: 'asha@' }).email).toBe('Please enter a valid email address.');
    expect(gamingErrors({ ...valid, mobile: '12345' }).mobile).toBe('Please enter a valid mobile number.');
    expect(gamingErrors({ ...valid, mobile: '1'.repeat(16) }).mobile).toBe('Please enter a valid mobile number.');
    expect(gamingErrors({ ...valid, mobile: '1234567' }).mobile).toBeUndefined();
  });

  it('nights are 1 to 90', () => {
    for (const bad of ['0', '91', '', 'x']) expect(gamingErrors({ ...valid, nights: bad }).nights).toBe('Please enter the number of nights (1 or more).');
    for (const good of ['1', '90']) expect(gamingErrors({ ...valid, nights: good }).nights).toBeUndefined();
  });

  it('needs a real date and a 24-hour time', () => {
    expect(gamingErrors({ ...valid, date: null }).datetime).toBe('Please choose a travel date and time.');
    expect(gamingErrors({ ...valid, time: '25:00' }).datetime).toBe('Please choose a travel date and time.');
    expect(gamingErrors({ ...valid, time: '9:5' }).datetime).toBe('Please choose a travel date and time.');
    expect(gamingErrors({ ...valid, time: '23:59' }).datetime).toBeUndefined();
  });
});

describe('the request that is sent', () => {
  it('is trimmed and carries the offset the website adds to the local time', () => {
    expect(gamingRequest(valid)).toEqual({
      name: 'Asha Rao',
      email: 'asha@example.com',
      mobile: '+91 98765 43210',
      from_airport: 'Hyderabad (HYD)',
      to_airport: 'Bangkok (BKK)',
      travel_datetime: '2026-11-20T10:00:00+05:30',
      number_of_nights: 3,
      casino_type: 'Poker rooms',
    });
  });
});
