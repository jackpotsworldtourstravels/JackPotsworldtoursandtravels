import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter, type Href } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useState } from 'react';
import { Linking, Pressable, StyleSheet, View } from 'react-native';

import { Logo } from '@/components/Logo';
import { Reveal } from '@/features/motion/ScrollMotion';
import { Text } from '@/components/Text';
import { DevStatus } from '@/features/dev/DevStatus';
import { SUPPORT_EMAIL, SUPPORT_PHONE, SUPPORT_PHONE_DISPLAY } from '@/features/account/support';
import { COMPANY_LINKS, LEGAL_LINKS, type InfoLink } from '@/features/info/links';
import { env } from '@/config/env';
import { colors, fontFamily, spacing } from '@/theme';

/**
 * THE WEBSITE'S FOOTER, at phone width (`.jw-footer` in index.html and `site-footer.js`): the closing band
 * ("The world awaits." with its two calls to action), then Company, Travel, Legal and Contact in one column,
 * then the copyright bar with its three badges. The labels and the order are the site's; Contact Us is the
 * Help and support screen, and the Travel links are the app's own screens for the same services.
 * `tests/features/footer.parity.test.ts` reads site-footer.js and fails if the lists drift.
 */
export const FOOTER_COPY = {
  kicker: 'JackPots World · Tours & Travel',
  statement: 'The world',
  accent: 'awaits.',
  plan: 'Plan your journey',
  explore: 'Explore destinations',
  about: 'Book flights, hotels and tour packages with confidence. Your trusted travel partner for memorable journeys.',
  copyright: '© 2026 JackpotsWorld Tours & Travels. All Rights Reserved.',
  tagline: 'Designed for every journey.',
  hours: '24/7 Support',
  address: ['Hyderabad,', 'Telangana,', 'India'],
  badges: [
    { icon: 'lock-closed-outline', label: 'SSL Secured' },
    { icon: 'shield-checkmark-outline', label: 'Privacy Protected' },
    { icon: 'card-outline', label: 'Secure Payments' },
  ],
} as const;

/** `travel` in the footer: the services, each a screen of the app. "Gaming Packages" is the site's own label. */
export const TRAVEL_LINKS: readonly { label: string; href: Href }[] = [
  { label: 'Flights', href: '/flights' },
  { label: 'Hotels', href: '/hotels' },
  { label: 'Tour Packages', href: '/packages' },
  { label: 'Destinations', href: '/explore' },
  { label: 'Gaming Packages', href: '/gaming' },
];

function Heading({ children }: { children: string }) {
  return (
    <Text variant="caption" color="gold" chrome accessibilityRole="header" style={styles.colHead}>
      {children.toUpperCase()}
    </Text>
  );
}

function FooterLink({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="link" accessibilityLabel={label} style={styles.link}>
      <Text variant="body" color="white" style={styles.linkText}>
        {label}
      </Text>
    </Pressable>
  );
}

export function SiteFooter() {
  const router = useRouter();
  // Development builds only: a long press on the copyright line opens the connection diagnostics, so they are not
  // printed under the footer where the website has nothing.
  const [diagnostics, setDiagnostics] = useState(false);
  const openPage = (l: InfoLink) => void WebBrowser.openBrowserAsync(`${env.apiBaseUrl}${l.path}`);

  return (
    <View>
      {/* The closing band: the site's "The world awaits." with a solid and an outlined call to action. */}
      <LinearGradient colors={['#060A12', '#0A1120']} style={styles.band}>
        <View style={styles.kickerRow}>
          <View style={styles.rule} />
          <Text variant="caption" color="gold" chrome style={styles.kicker}>
            {FOOTER_COPY.kicker.toUpperCase()}
          </Text>
        </View>
        <Text variant="display" color="white" accessibilityRole="header" style={styles.statement}>
          {FOOTER_COPY.statement.toUpperCase()}
          {'\n'}
          <Text variant="display" color="gold" style={styles.statementAccent}>
            {FOOTER_COPY.accent.toUpperCase()}
          </Text>
        </Text>
        <View style={styles.ctas}>
          <Pressable onPress={() => router.push('/support')} accessibilityRole="button" accessibilityLabel={FOOTER_COPY.plan} style={[styles.cta, styles.ctaSolid]}>
            <Text variant="caption" color="white" chrome style={styles.ctaText}>
              {FOOTER_COPY.plan.toUpperCase()}
            </Text>
          </Pressable>
          <Pressable onPress={() => router.push('/explore')} accessibilityRole="button" accessibilityLabel={FOOTER_COPY.explore} style={[styles.cta, styles.ctaOutline]}>
            <Text variant="caption" color="white" chrome style={styles.ctaText}>
              {FOOTER_COPY.explore.toUpperCase()}
            </Text>
          </Pressable>
        </View>
      </LinearGradient>

      <LinearGradient colors={['#060A12', '#0A1120']} style={styles.body}>
        <Reveal y={40} duration={1100} startAt={0.85}>
          <Logo size={77} />
          <Text variant="body" color="onDark2" style={styles.about}>
            {FOOTER_COPY.about}
          </Text>
        </Reveal>

        <Reveal y={40} duration={1100} delay={80} startAt={0.85}>
          <View style={styles.col}>
            <Heading>Company</Heading>
            {COMPANY_LINKS.slice(0, 1).map((l) => (
              <FooterLink key={l.label} label={l.label} onPress={() => openPage(l)} />
            ))}
            <FooterLink label="Contact Us" onPress={() => router.push('/support')} />
            {COMPANY_LINKS.slice(1).map((l) => (
              <FooterLink key={l.label} label={l.label} onPress={() => openPage(l)} />
            ))}
          </View>
        </Reveal>

        <Reveal y={40} duration={1100} delay={160} startAt={0.85}>
          <View style={styles.col}>
            <Heading>Travel</Heading>
            {TRAVEL_LINKS.map((l) => (
              <FooterLink key={l.label} label={l.label} onPress={() => router.push(l.href)} />
            ))}
          </View>
        </Reveal>

        <Reveal y={40} duration={1100} delay={240} startAt={0.85}>
          <View style={styles.col}>
            <Heading>Legal</Heading>
            {LEGAL_LINKS.map((l) => (
              <FooterLink key={l.label} label={l.label} onPress={() => openPage(l)} />
            ))}
          </View>
        </Reveal>

        <Reveal y={40} duration={1100} delay={320} startAt={0.85}>
          <View style={styles.col}>
            <Heading>Contact</Heading>
            <ContactRow icon="call-outline" label="Phone" onPress={() => void Linking.openURL(`tel:${SUPPORT_PHONE}`).catch(() => undefined)}>
              {SUPPORT_PHONE_DISPLAY}
            </ContactRow>
            <ContactRow icon="mail-outline" label="Email" onPress={() => void Linking.openURL(`mailto:${SUPPORT_EMAIL}`).catch(() => undefined)}>
              {SUPPORT_EMAIL}
            </ContactRow>
            <ContactRow icon="location-outline" label="Address">
              {FOOTER_COPY.address.join('\n')}
            </ContactRow>
            <ContactRow icon="time-outline" label="Business hours">
              {FOOTER_COPY.hours}
            </ContactRow>
          </View>
        </Reveal>
      </LinearGradient>

      <View style={styles.bottom}>
        <Pressable onLongPress={__DEV__ ? () => setDiagnostics((d) => !d) : undefined} accessible={false}>
          <Text variant="small" color="onDark2" style={styles.copyright}>
            {FOOTER_COPY.copyright}
          </Text>
        </Pressable>
        <Text variant="small" color="onDark2" style={styles.tagline}>
          {FOOTER_COPY.tagline}
        </Text>
        <View style={styles.badges}>
          {FOOTER_COPY.badges.map((b) => (
            <View key={b.label} style={styles.badge}>
              <Ionicons name={b.icon} size={14} color={colors.onDark2} />
              <Text variant="small" color="onDark2" style={styles.badgeText}>
                {b.label}
              </Text>
            </View>
          ))}
        </View>
        {__DEV__ && diagnostics ? <DevStatus /> : null}
      </View>
    </View>
  );
}

function ContactRow({ icon, label, children, onPress }: { icon: keyof typeof Ionicons.glyphMap; label: string; children: string; onPress?: () => void }) {
  const body = (
    <View style={styles.contactRow}>
      <Ionicons name={icon} size={18} color={colors.gold} style={styles.contactIcon} />
      <View style={styles.contactText}>
        <Text variant="caption" color="onDark2" chrome style={styles.contactLabel}>
          {label.toUpperCase()}
        </Text>
        <Text variant="body" color="white" style={styles.linkText}>
          {children}
        </Text>
      </View>
    </View>
  );
  return onPress ? (
    <Pressable onPress={onPress} accessibilityRole="link" accessibilityLabel={`${label}: ${children}`}>
      {body}
    </Pressable>
  ) : (
    <View accessible accessibilityLabel={`${label}: ${children.replace(/\n/g, ' ')}`}>
      {body}
    </View>
  );
}

const styles = StyleSheet.create({
  band: {
    paddingHorizontal: spacing.s5,
    paddingTop: spacing.s8,
    paddingBottom: spacing.s7,
    gap: spacing.s4,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(255,255,255,0.08)',
  },
  kickerRow: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  rule: { width: 28, height: 1, backgroundColor: colors.gold },
  kicker: {
    flex: 1,
    fontSize: 11,
    lineHeight: 17,
    letterSpacing: 3.3,
    fontWeight: '600',
  },
  statement: { fontSize: 44, lineHeight: 40, letterSpacing: -1.1 },
  statementAccent: {
    fontFamily: fontFamily.displayItalic,
    fontSize: 44,
    lineHeight: 40,
    letterSpacing: -1.1,
  },
  ctas: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.s3,
    marginTop: spacing.s2,
  },
  cta: {
    minHeight: 48,
    justifyContent: 'center',
    paddingHorizontal: 24,
    borderRadius: 999,
  },
  ctaSolid: { backgroundColor: colors.coral },
  ctaOutline: { borderWidth: 1, borderColor: 'rgba(255,255,255,0.3)' },
  ctaText: { fontSize: 12, letterSpacing: 1.92, fontWeight: '700' },
  body: {
    paddingHorizontal: spacing.s5,
    paddingTop: spacing.s7,
    paddingBottom: spacing.s6,
    gap: 34,
  },
  about: { color: 'rgba(255,255,255,0.62)', lineHeight: 24 },
  col: { gap: 0 },
  colHead: {
    fontSize: 11,
    lineHeight: 14,
    letterSpacing: 2.64,
    fontWeight: '700',
    paddingBottom: 10,
    marginBottom: spacing.s2,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(255,255,255,0.12)',
  },
  link: { minHeight: 44, justifyContent: 'center' },
  linkText: { color: 'rgba(255,255,255,0.74)', fontSize: 14, lineHeight: 22 },
  contactRow: {
    flexDirection: 'row',
    gap: spacing.s3,
    minHeight: 44,
    paddingVertical: spacing.s2,
  },
  contactIcon: { marginTop: 2 },
  contactText: { flex: 1 },
  contactLabel: {
    fontSize: 11,
    lineHeight: 17,
    letterSpacing: 0.77,
    fontWeight: '700',
    color: 'rgba(255,255,255,0.5)',
  },
  bottom: {
    gap: spacing.s2,
    paddingHorizontal: spacing.s5,
    paddingVertical: spacing.s5,
    backgroundColor: '#04070D',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(255,255,255,0.08)',
  },
  copyright: { color: 'rgba(255,255,255,0.72)' },
  tagline: {
    fontFamily: fontFamily.display,
    fontSize: 12.5,
    color: 'rgba(255,255,255,0.55)',
  },
  badges: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.s4,
    marginTop: spacing.s1,
  },
  badge: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  badgeText: { fontSize: 12.5, color: 'rgba(255,255,255,0.6)' },
});
