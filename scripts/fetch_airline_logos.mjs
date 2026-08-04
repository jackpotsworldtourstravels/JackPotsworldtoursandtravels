#!/usr/bin/env node
/* Fetch airline logos into the repo and generate the runtime lookup map.
   ===========================================================================
   Source dataset: https://github.com/imgmongelli/airlines-logos-dataset
   (1520 airlines, 856 of them with an IATA code; logos are PNG.)

   WHY THIS SCRIPT EXISTS INSTEAD OF HOTLINKING
   The portal must not depend on raw.githubusercontent.com at page load: a
   corporate network can block it, the repo can move or be deleted, and every
   result card would show a broken tile. So logos are vendored into
   frontend/assets/images/airlines/ and committed. This script makes that
   vendoring repeatable — adding an airline is one command, not a manual
   download-and-rename.

   WHY FILES ARE RENAMED
   The dataset names files by ICAO code (AIC.png, IGO.png, UAE.png). The portal
   only ever knows the IATA code, because that is what a flight number carries
   ("6E-1423" -> 6E). Renaming at download time to <IATA>.png means the runtime
   lookup is a plain path join with no mapping table to keep in sync.
   Airlines in the dataset with no IATA code are skipped: nothing in this
   product could ever resolve them.

   USAGE
     node scripts/fetch_airline_logos.mjs            # curated list below
     node scripts/fetch_airline_logos.mjs --all      # every IATA airline (~856)
     node scripts/fetch_airline_logos.mjs 6E AI QR   # just these codes

   Writes:
     frontend/assets/images/airlines/<IATA>.png
     frontend/assets/js/airline-logos.js   (generated — do not hand-edit)

   NOTE ON RIGHTS: airline logos are trademarks, and this dataset ships without
   a licence file. Vendoring them for a partner-facing booking portal is
   ordinary practice (every OTA shows carrier marks), but the call is the
   product owner's, not this script's. */

import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const OUT_IMAGES = path.join(REPO, 'frontend', 'assets', 'images', 'airlines');
const OUT_MAP = path.join(REPO, 'frontend', 'assets', 'js', 'airline-logos.js');

const RAW = 'https://raw.githubusercontent.com/imgmongelli/airlines-logos-dataset/master';
const INDEX_URL = `${RAW}/airlines.json`;

/* Curated default: every carrier the seeded catalog sells, plus the airlines a
   partner agency in this market realistically books next. Kept deliberately
   short — ~6.7MB of unused logos does not belong in a frontend repo, and
   anything missing falls back to the default icon rather than breaking.
   Extend this list (or pass codes as arguments) when inventory grows. */
const CURATED = [
  // --- in the seeded catalog today (0027_seed_catalog_inventory.py) ---
  'AI', '6E', 'EK', 'QR', 'SQ', 'LH', 'BA', 'EY', 'TG',
  // --- India ---
  'IX', 'SG', 'UK', 'QP', 'G8', '9I',
  // --- Gulf & Middle East ---
  'WY', 'GF', 'SV', 'KU', 'FZ', 'G9', 'ME', 'MS', 'TK',
  // --- South & South-East Asia ---
  'UL', 'BG', 'PK', 'MH', 'GA', 'VN', 'AK', 'TR', 'PR', 'ID', 'FD',
  // --- East Asia ---
  'CX', 'NH', 'JL', 'KE', 'OZ', 'CZ', 'MU', 'CA', 'BR', 'CI', 'HX',
  // --- Europe ---
  'AF', 'KL', 'LX', 'AZ', 'IB', 'TP', 'SK', 'AY', 'SU', 'VS', 'EI', 'OS', 'SN', 'FR', 'U2',
  // --- Americas ---
  'AA', 'UA', 'DL', 'AC', 'WN', 'B6', 'AS', 'LA', 'AV', 'CM',
  // --- Oceania & Africa ---
  'QF', 'NZ', 'VA', 'SA', 'ET', 'KQ', 'AT',
];

const args = process.argv.slice(2);
const wantAll = args.includes('--all');
const explicit = args.filter(a => !a.startsWith('--')).map(a => a.toUpperCase());

async function main() {
  console.log('Reading dataset index…');
  const index = await fetchJson(INDEX_URL);
  const withIata = index.data.filter(a => a.iata_code && a.logo);
  console.log(`  ${index.count} airlines, ${withIata.length} with an IATA code.`);

  /* First entry wins on a duplicate IATA code. The dataset is ordered by fleet
     size (num_aircraft descending after the first few rows), so the mainline
     carrier beats a regional subsidiary sharing the code. */
  const byIata = new Map();
  for (const a of withIata) {
    const code = a.iata_code.toUpperCase();
    if (!byIata.has(code)) byIata.set(code, a);
  }

  const wanted = wantAll ? [...byIata.keys()]
    : (explicit.length ? explicit : CURATED);

  await mkdir(OUT_IMAGES, { recursive: true });

  const saved = [];
  const missing = [];
  for (const code of wanted) {
    const entry = byIata.get(code);
    if (!entry) { missing.push(code); continue; }

    const file = path.posix.basename(entry.logo);              // "IGO.png"
    const ext = path.extname(file).toLowerCase() || '.png';
    const dest = path.join(OUT_IMAGES, `${code}${ext}`);

    if (existsSync(dest)) {
      const meta = await pngMeta(dest);
      saved.push({ code, name: entry.name, file: `${code}${ext}`, ...meta, cached: true });
      continue;
    }
    try {
      const bytes = await fetchBinary(`${RAW}/images/${file}`);
      await writeFile(dest, bytes);
      const meta = await pngMeta(dest);
      saved.push({ code, name: entry.name, file: `${code}${ext}`, ...meta });
      process.stdout.write(`  ${code} ${entry.name}\n`);
    } catch (err) {
      missing.push(`${code} (download failed: ${err.message})`);
    }
  }

  await writeMap(saved);

  const bytes = saved.reduce((n, s) => n + (s.bytes || 0), 0);
  console.log(`\nSaved ${saved.length} logos (${(bytes / 1024).toFixed(0)} KB) to ${path.relative(REPO, OUT_IMAGES)}`);
  console.log(`Wrote ${path.relative(REPO, OUT_MAP)}`);
  if (missing.length) {
    console.log(`\nNot in the dataset (these fall back to the default icon):\n  ${missing.join(', ')}`);
  }

  /* Aspect ratios drive the CSS: these are wordmarks, not square icons, so the
     container has to be wide enough that a 3:1 logo is still legible. */
  const ratios = saved.filter(s => s.w && s.h).map(s => s.w / s.h);
  if (ratios.length) {
    ratios.sort((a, b) => a - b);
    const at = p => ratios[Math.floor(ratios.length * p)].toFixed(2);
    console.log(`\nAspect ratio (w/h) across ${ratios.length} logos: min ${at(0)}, median ${at(0.5)}, p90 ${at(0.9)}, max ${ratios[ratios.length - 1].toFixed(2)}`);
  }
}

/* Minimal PNG header read — width/height live at bytes 16..23 of the IHDR. Good
   enough to report aspect ratios; not a general image parser. */
async function pngMeta(file) {
  try {
    const b = await readFile(file);
    if (b.length < 24 || b.readUInt32BE(0) !== 0x89504e47) return { bytes: b.length };
    return { bytes: b.length, w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  } catch { return {}; }
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

async function fetchBinary(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  return buf;
}

async function writeMap(saved) {
  const rows = [...saved].sort((a, b) => a.code.localeCompare(b.code));
  /* name -> IATA, for the case where inventory carries an airline name but no
     flight number. Lowercased, and "Airways"/"Airlines" suffixes are kept as-is
     because resolveAirlineLogo() normalises the lookup side instead. */
  const names = rows.map(r => `  ${JSON.stringify(r.name.toLowerCase())}: '${r.code}',`).join('\n');
  const files = rows.map(r => `  ${r.code.length === 2 ? `'${r.code}'` : `'${r.code}'`}: '${r.file}',`).join('\n');

  const body = `'use strict';
/* GENERATED by scripts/fetch_airline_logos.mjs — do not hand-edit.
   Re-run that script to add or refresh airlines.

   Source: https://github.com/imgmongelli/airlines-logos-dataset
   ${rows.length} carriers vendored into assets/images/airlines/, named by IATA
   code so a flight number resolves to a file with no extra mapping at runtime. */

const AIRLINE_LOGO_DIR = 'assets/images/airlines/';

/* IATA code -> file name inside AIRLINE_LOGO_DIR. */
const AIRLINE_LOGO_FILES = {
${files}
};

/* Airline display name (lowercase) -> IATA code, for inventory that names the
   carrier but carries no flight number. */
const AIRLINE_NAME_TO_IATA = {
${names}
};
`;
  await writeFile(OUT_MAP, body, 'utf8');
}

main().catch(err => {
  console.error('\nFailed:', err.message);
  process.exit(1);
});
