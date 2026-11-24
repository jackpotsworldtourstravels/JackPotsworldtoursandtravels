/**
 * Design tokens, lifted from the website's rendered design system.
 *
 * SOURCE OF TRUTH: frontend/assets/css/jw-system.css §1 (the `--ds-*` tokens)
 * and its "bridge" block, verified against computed styles on the live
 * homepage. main.css still *comments* a teal palette and jp-ds.css a violet
 * one; neither is what the customer site renders. The staff portals' violet is
 * deliberately absent here.
 *
 * Keep names aligned with the CSS (`navy800` = `--ds-navy-800`) so a change on
 * the website is a one-line diff here.
 */
export const colors = {
  // Surfaces
  night: '#060A12',
  navy900: '#0A1120',
  navy800: '#0F1B2E',
  navy700: '#16263F',
  navy600: '#22375A',
  ivory: '#F5F0E8',
  sand: '#EBE3D6',
  paper: '#FDFBF8',
  white: '#FFFFFF',
  surface2: '#F2F4F7',

  // Text
  ink: '#151B27',
  ink2: '#3B4252',
  muted: '#5B6577',
  onDark: 'rgba(255,255,255,0.92)',
  onDark2: 'rgba(255,255,255,0.66)',

  // The booking card's own surfaces (computed styles on the live homepage at 390px).
  /** `.search-card` field tile ground and edge, and its small upper-case label. */
  fieldFill: '#F6F5F2',
  fieldLine: 'rgba(21,27,39,0.2)',
  fieldLabel: '#6B7280',
  /** The trip-type segmented control's trough. */
  segFill: '#F0EEE9',
  /** The dock's tab strip runs navy 900-ish to 800-ish top to bottom. */
  dockTop: '#0B111D',
  dockBottom: '#121B2D',
  /** The card's border: gold at 30%. */
  cardEdge: 'rgba(217,178,111,0.3)',

  // Lines
  line: '#E4E7EC',
  lineDark: 'rgba(255,255,255,0.12)',

  // Metal and accent
  gold: '#D9B26F',
  goldLight: '#F0D9A6',
  /** The website's selected-tab wash and ring on the dark search dock (gold at 16% / 75%). */
  goldFill: 'rgba(217,178,111,0.16)',
  goldRing: 'rgba(217,178,111,0.75)',
  goldInk: '#85602A',
  coral: '#C9482F',
  coralDark: '#A63A24',
  coralLight: '#E8604C',
  coralSoft: '#FBEBE6',

  // Status. `danger` is a darker red than the coral CTA and always travels with an icon, so an error is never
  // mistaken for a primary action.
  success: '#1D7550',
  successSoft: '#E3F2EA',
  warning: '#8A5A0E',
  warningSoft: '#FBF0DC',
  danger: '#9E2A24',
  dangerSoft: '#F9E5E3',
  info: '#27578A',
  infoSoft: '#E4EDF7',

  // App UI roles (UI overhaul). Named by job, so screens never pick a raw palette value.
  /** Screen background: a cool light grey that lets the navy and gold read cleanly. */
  bg: '#F3F5F9',
  /** Cards, sheets, inputs. */
  surface: '#FFFFFF',
  /** Links and secondary actions ("Edit", "View All"): brand navy. */
  link: '#0B1D35',
  /** THE primary action (Search, Continue, Pay): solid brand navy. */
  primary: '#0B1D35',
  /** The circle loader's track on navy. */
  navyTrack: '#1E3254',
  /** Gold dark enough to read as a stroke on white. */
  goldDeep: '#B48A2E',
  /** Secondary text: 5.9:1 on white, 5.4:1 on the grey background. */
  textSecondary: '#5B6577',
  /** Placeholders and disabled labels only, never body text. */
  textDisabled: '#98A2B3',
  /** Hairlines inside a card. */
  divider: '#EAECF0',
  /** Skeleton placeholders. */
  skeleton: '#E9EDF3',
} as const;

/** The primary button's gradient (135deg, three stops), read from the site's computed style. */
export const gradients = {
  gold: ['#B98A42', '#946027', '#6F4417'] as const,
  /** `.search-card.is-premium` ground: white 97% to #FAF8F4 95%. */
  card: ['rgba(255,255,255,0.97)', 'rgba(250,248,244,0.95)'] as const,
  /** The dock's tab strip. */
  dock: ['#0B111D', '#121B2D'] as const,
} as const;

/** 4px base scale (`--ds-s1..s10`). */
export const spacing = {
  s1: 4,
  s2: 8,
  s3: 12,
  s4: 16,
  s5: 20,
  s6: 24,
  s7: 32,
  s8: 40,
  s9: 56,
  s10: 80,
} as const;

/** App radii: cards 12, larger panels 16, bottom sheets 20 (top corners), chips and CTAs full. */
export const radius = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  pill: 999,
} as const;

/**
 * Navy-tinted elevation, never grey. RN needs the iOS shadow props and Android's `elevation` side by side.
 * `sm` is THE card shadow; a card has this or a border, never both.
 */
export const shadow = {
  sm: {
    shadowColor: colors.navy900,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 8,
    elevation: 2,
  },
  md: {
    shadowColor: colors.navy900,
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.16,
    shadowRadius: 22,
    elevation: 5,
  },
} as const;

/** `--ds-t-*`, in milliseconds. */
export const motion = {
  fast: 200,
  base: 350,
  slow: 700,
} as const;

/** Smallest comfortable touch target (WCAG 2.5.8 asks for 24, HIG/Material for 44-48). */
export const minTouchTarget = 48;

/**
 * Cap on Dynamic Type / font scale for dense chrome (tab labels, badges, pills).
 * Body copy is left uncapped so people who need large text get it.
 */
export const maxChromeFontScale = 1.3;

export type ColorToken = keyof typeof colors;
