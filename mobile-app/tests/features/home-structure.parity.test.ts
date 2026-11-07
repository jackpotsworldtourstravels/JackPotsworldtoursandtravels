import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

import { MENU_ITEMS } from '@/components/HeaderActions';
import { FIRST_SHOWN } from '@/features/home/DestinationGrid';
import { FOOTER_COPY, TRAVEL_LINKS } from '@/features/home/SiteFooter';
import { COMPANY_LINKS, LEGAL_LINKS } from '@/features/info/links';
import { colors } from '@/theme';

/**
 * The app's Home is the website's Home. These tests read the website's own files (index.html, site-footer.js,
 * home-cinema.css, home-destinations.js) and fail if the app's structure, colours or lists drift from them.
 * Skipped, not failed, if this folder is checked out without the website beside it.
 */
const FRONTEND = resolve(__dirname, '../../../frontend');
const present = existsSync(resolve(FRONTEND, 'index.html'));
const read = (path: string) => (present ? readFileSync(resolve(FRONTEND, path), 'utf8') : '');
const index = read('index.html');
const cinema = read('assets/css/home-cinema.css');
const destinationsJs = read('assets/js/home-destinations.js');
const footerJs = read('assets/js/site-footer.js');

const cssVar = (name: string) => cinema.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{3,8})`))?.[1].toUpperCase();

(present ? describe : describe.skip)('the Home page matches the website', () => {
  it('the colours are the cinematic home page’s own variables', () => {
    expect(colors.night).toBe(cssVar('cn-night'));
    expect(colors.ivory).toBe(cssVar('cn-ivory'));
    expect(colors.gold).toBe(cssVar('cn-gold'));
    expect(colors.goldLight).toBe(cssVar('cn-gold-lt'));
    expect(colors.ink).toBe(cssVar('cn-text'));
  });

  it('the header drawer lists the website’s five links in its order', () => {
    const drawer = index.match(/<nav class="jw-drawer__nav"[\s\S]*?<\/nav>/)?.[0] ?? '';
    const labels = [...drawer.matchAll(/<i>(\d\d)<\/i><span>([^<]+)<\/span>/g)].map((m) => [m[1], m[2]]);
    expect(labels).toEqual(MENU_ITEMS.map((item, i) => [String(i + 1).padStart(2, '0'), item.title]));
  });

  it('the destinations grid shows the site’s first nine, then "View all"', () => {
    expect(destinationsJs).toContain(`const FIRST_SHOWN = ${FIRST_SHOWN};`);
    expect(destinationsJs).toContain("'View all ' + destinations.length + ' destinations'");
  });

  it('the Home page has no hotel, package or offers shelf, and the website’s destinations section says why', () => {
    expect(index).toContain('the one section that replaced six');
    for (const heading of ['Featured tour packages', 'Popular fares', 'Featured stays']) expect(index).not.toContain(`<h2>${heading}`);
  });

  it('the section order is the website’s: hero, destinations, promise, closing scene, footer', () => {
    const marks = ['id="home"', 'id="destinations"', 'class="why-section cine-why"', 'id="newsletter"', 'class="jw-footer"'].map((m) => index.indexOf(m));
    expect(marks.every((i) => i > 0)).toBe(true);
    expect([...marks].sort((a, b) => a - b)).toEqual(marks);
  });
});

(present ? describe : describe.skip)('the footer matches the website', () => {
  const list = (name: string) => {
    const block = footerJs.match(new RegExp(`${name}:\\s*\\[([\\s\\S]*?)\\n\\s*\\]`))?.[1] ?? '';
    return [...block.matchAll(/\['([^']+)',\s*'([^']+)'\]/g)].map((m) => m[1]);
  };

  it('Company, Travel and Legal are the footer’s labels, in its order', () => {
    // Contact Us is the Help and support screen; About, Customer Support and FAQs open the site's pages.
    expect(['About Us', 'Contact Us', ...COMPANY_LINKS.slice(1).map((l) => l.label)]).toEqual(list('company'));
    expect(TRAVEL_LINKS.map((l) => l.label)).toEqual(list('travel'));
    expect(LEGAL_LINKS.map((l) => l.label)).toEqual(list('legal'));
  });

  it('the closing band, the about line, the tagline and the badges are the website’s words', () => {
    expect(index).toContain('The world <em>awaits.</em>');
    expect(index).toContain('JackPots World &middot; Tours &amp; Travel');
    expect(index).toContain('Plan your journey');
    expect(index).toContain('Explore destinations');
    expect(index).toContain(FOOTER_COPY.about);
    expect(index).toContain(FOOTER_COPY.tagline);
    for (const b of FOOTER_COPY.badges) expect(index).toContain(b.label);
    expect(index).toContain('24/7 Support');
    expect(index).toContain('Hyderabad,<br>Telangana,<br>India');
  });
});
