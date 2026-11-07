import { readFileSync } from 'fs';
import { resolve } from 'path';

import { DESTINATIONS, DEVIATIONS, FINALE, HERO, PROMISE, TRUST } from '@/features/home/copy';

/**
 * The Home page's words are the website's. These tests read the website's own files
 * (frontend/index.html and booking-card.js) and fail if the app's copy drifts, so a
 * wording change on the site is a visible diff here.
 */
const FRONTEND = resolve(__dirname, '../../../frontend');
const html = readFileSync(resolve(FRONTEND, 'index.html'), 'utf8');
const bookingCard = readFileSync(resolve(FRONTEND, 'assets/js/booking-card.js'), 'utf8');

const ENTITIES: Record<string, string> = { '&mdash;': '—', '&times;': '×', '&amp;': '&', '&nbsp;': ' ' };
const decode = (s: string) => s.replace(/&[a-z]+;/g, (e) => ENTITIES[e] ?? e);

/** Visible text of the first element matching `pattern`'s capture group 1. */
function inner(pattern: RegExp): string {
  const m = html.match(pattern);
  if (!m) throw new Error(`not found in index.html: ${pattern}`);
  return decode(m[1].replace(/<[^>]+>/g, '').trim());
}

describe('Home copy matches the website', () => {
  it('the hero headline', () => {
    const title = html.match(/<h1 class="cine-title">([\s\S]*?)<\/h1>/);
    expect(title).not.toBeNull();
    const text = decode(title![1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
    expect(text).toBe(`${HERO.line1} ${HERO.accent} ${HERO.line2}`);
  });

  it('the trust strip under the search card', () => {
    for (const t of TRUST) {
      expect(bookingCard).toContain(`title: '${t.title}'`);
      expect(bookingCard).toContain(`sub: '${t.sub}'`);
    }
    expect(TRUST).toHaveLength(3);
  });

  it('the destinations heading and lede', () => {
    expect(inner(/<p class="cine-kicker"><span class="cine-rule"><\/span>(Where we can take you)<\/p>/)).toBe(DESTINATIONS.kicker);
    expect(html).toContain(`<span>${DESTINATIONS.title1}</span>`);
    expect(html).toContain(`<span><em>${DESTINATIONS.title2}</em></span>`);
    expect(inner(/<p class="cine-lede">(Explore destinations[\s\S]*?)<\/p>/)).toBe(DESTINATIONS.lede);
  });

  it('the promise: heading, subtitle and all eight benefits, in order', () => {
    expect(html).toContain(`</span>${PROMISE.kicker}</p>`);
    expect(inner(/<p class="cine-why-sub">([\s\S]*?)<\/p>/)).toBe(PROMISE.sub);
    for (const word of PROMISE.statement) expect(html).toContain(`data-text="${word}"`);

    const site = [...html.matchAll(/<li class="cine-benefit"><span class="cine-benefit-icon"><i data-jp-icon="(\w+)"><\/i><\/span><div><h3>([\s\S]*?)<\/h3><p>([\s\S]*?)<\/p><\/div><\/li>/g)].map((m) => ({
      icon: m[1],
      title: decode(m[2]),
      body: decode(m[3]),
    }));
    expect(site).toHaveLength(8);
    expect(PROMISE.items).toHaveLength(8);
    PROMISE.items.forEach((item, i) => {
      expect(item.title).toBe(site[i].title);
      expect(item.siteIcon).toBe(site[i].icon);
      const deviation = DEVIATIONS[item.title];
      // Same words as the site, unless this line is a listed, reasoned deviation: then the
      // site's original is recorded here and must still be what the site says.
      if (deviation) {
        expect(site[i].body).toBe(deviation.website);
        expect(item.body).not.toBe(deviation.website);
        expect(deviation.reason.length).toBeGreaterThan(10);
      } else {
        expect(item.body).toBe(site[i].body);
      }
    });
  });

  it('lists exactly the two deviations, no others', () => {
    expect(Object.keys(DEVIATIONS).sort()).toEqual(['24×7 Customer Support', 'Travel Made Simple']);
  });

  it('the closing scene and the newsletter', () => {
    expect(inner(/<p class="cine-kicker"><span class="cine-rule"><\/span>(Your next chapter)<\/p>/)).toBe(FINALE.kicker);
    expect(html).toContain(`<span>${FINALE.title1}</span>`);
    expect(html).toContain(`<span><em>${FINALE.accent}</em></span>`);
    expect(inner(/<p class="cine-lede">(Tell us where[\s\S]*?)<\/p>/)).toBe(FINALE.lede);
    expect(html).toContain(`<span>${FINALE.cta}</span>`);
    expect(inner(/<h3 id="newsHead">([\s\S]*?)<\/h3>/)).toBe(FINALE.newsletter.heading);
    expect(inner(/<h3 id="newsHead">[\s\S]*?<\/h3>\s*<p>([\s\S]*?)<\/p>/)).toBe(FINALE.newsletter.text);
    expect(html).toContain(`placeholder="${FINALE.newsletter.placeholder}"`);
    expect(html).toContain(`>${FINALE.newsletter.button}</button>`);
    expect(html).toContain(FINALE.newsletter.success);
  });

  it('the newsletter messages match the handler in app.js', () => {
    const appJs = readFileSync(resolve(FRONTEND, 'assets/js/app.js'), 'utf8');
    expect(appJs).toContain(FINALE.newsletter.success);
    expect(appJs).toContain(FINALE.newsletter.error);
    expect(appJs).toContain("/api/newsletter");
  });
});
