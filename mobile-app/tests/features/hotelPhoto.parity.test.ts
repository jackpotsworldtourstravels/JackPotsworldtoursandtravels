import * as fs from 'fs';
import * as path from 'path';

import { CITY_ALIASES, CITY_PHOTOS, VERIFIED_PROPERTIES } from '@/features/media/hotelPhoto';

/**
 * hotelPhoto.ts is a port of the website's resolver, and a port drifts. When the
 * website's file is present (it is, in this repository) the tables must match it
 * exactly; when this folder is built on its own, the file is absent and the
 * checks skip rather than fail.
 */
const SITE_FILE = path.resolve(__dirname, '../../../frontend/assets/js/hotel-image-map.js');
const present = fs.existsSync(SITE_FILE);
const source = present ? fs.readFileSync(SITE_FILE, 'utf8') : '';
const maybe = present ? it : it.skip;

/** Evaluate one `const NAME = <literal>;` out of the website's file. The file is this repository's own. */
function literal<T>(name: string, closer: string): T {
  const start = source.indexOf(`const ${name} = `);
  if (start < 0) throw new Error(`${name} not found in the website file`);
  const from = source.indexOf('=', start) + 1;
  const end = source.indexOf(closer, from);
  const body = source.slice(from, end + closer.length - 1);
  return new Function(`const D = 'assets/destinations/', L = 'assets/locations/'; return (${body});`)() as T;
}

describe('hotelPhoto.ts matches frontend/assets/js/hotel-image-map.js', () => {
  maybe('verified properties are identical', () => {
    const site = literal<typeof VERIFIED_PROPERTIES>('VERIFIED_PROPERTIES', '\n  ];');
    const norm = (list: typeof VERIFIED_PROPERTIES) =>
      list.map((p) => ({ slug: p.slug, subject: p.subject, names: p.names, city: p.city, areas: p.areas, unique: Boolean(p.unique) }));
    expect(norm(VERIFIED_PROPERTIES)).toEqual(norm(site));
  });

  maybe('city photographs name the same files and subjects', () => {
    const site = literal<Record<string, { dir: string; file: string; subject: string }>>('CITY_PHOTOS', '\n  };');
    const siteMap = Object.fromEntries(
      Object.entries(site).map(([city, p]) => [
        city,
        { dir: p.dir === 'assets/destinations/' ? 'destinations' : 'locations', file: p.file, subject: p.subject },
      ]),
    );
    expect(CITY_PHOTOS).toEqual(siteMap);
  });

  maybe('city aliases are identical', () => {
    const site = literal<Record<string, string>>('CITY_ALIASES', '\n  };');
    expect(CITY_ALIASES).toEqual(site);
  });
});
