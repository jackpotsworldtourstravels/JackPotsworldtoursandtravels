import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

import { COMPANY_LINKS, LEGAL_LINKS } from '@/features/info/links';

/**
 * The app lists the website's information pages. This reads the website's own footer
 * (`site-footer.js`) and fails if a label or address drifts, or a page goes missing.
 */
const FRONTEND = resolve(__dirname, '../../../frontend');
const footerFile = resolve(FRONTEND, 'assets/js/site-footer.js');
const present = existsSync(footerFile);
const footer = present ? readFileSync(footerFile, 'utf8') : '';

const group = (name: string) => {
  const block = footer.match(new RegExp(`${name}:\\s*\\[([\\s\\S]*?)\\n\\s*\\]`))?.[1] ?? '';
  return [...block.matchAll(/\['([^']+)',\s*'([^']+)'\]/g)].map((m) => ({ label: m[1], file: m[2] }));
};

(present ? describe : describe.skip)('information links match frontend/assets/js/site-footer.js', () => {
  it('Legal is the footer’s seven, in its order', () => {
    const legal = group('legal');
    expect(legal).toHaveLength(7);
    expect(LEGAL_LINKS.map((l) => [l.label, l.path])).toEqual(legal.map((l) => [l.label, `/${l.file}`]));
  });

  it('About is the footer’s company list without Contact Us, which is the Help and support screen', () => {
    const company = group('company').filter((l) => l.label !== 'Contact Us');
    expect(company.length).toBeGreaterThan(0);
    expect(COMPANY_LINKS.map((l) => [l.label, l.path])).toEqual(company.map((l) => [l.label, `/${l.file}`]));
  });

  it('every page it opens exists on the website', () => {
    for (const link of [...COMPANY_LINKS, ...LEGAL_LINKS]) expect(existsSync(resolve(FRONTEND, link.path.slice(1)))).toBe(true);
  });
});
