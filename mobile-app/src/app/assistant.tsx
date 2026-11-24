import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useRef, useState, type ComponentRef } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { assistantApi, type AssistantChoice } from '@/api/endpoints/assistant';
import { isApiError } from '@/api/errors';
import { CircleLoader, Text } from '@/components';
import { actionLink, type ActionLink } from '@/features/assistant/actions';
import { useAuth } from '@/providers/AuthProvider';
import { colors, fontFamily, radius, spacing } from '@/theme';

interface Turn {
  id: number;
  from: 'you' | 'assistant' | 'system';
  text: string;
  link?: ActionLink | null;
  choices?: AssistantChoice[];
}

const STARTERS = ['Hotels in Goa', 'A weekend getaway', 'Help with a booking'];

/**
 * The Travel Assistant: a chat that understands what someone wants and opens the right search. Replies come from the
 * backend (`/api/customer/assistant/message`); the assistant never sees a price or a booking, so a reply is words plus
 * a card that opens the app's own screen. "Talk to a person" hands over to Help and support.
 */
export default function AssistantScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { customer, status } = useAuth();
  const firstName = status === 'customer' ? customer?.full_name?.trim().split(/\s+/)[0] : null;

  const [turns, setTurns] = useState<Turn[]>([
    {
      id: 0,
      from: 'assistant',
      text: `Hi${firstName ? ` ${firstName}` : ''}! I can help you plan a trip, find hotels and holiday packages, or answer questions about a booking. What are you planning?`,
    },
  ]);
  const [suggestions, setSuggestions] = useState<string[]>(STARTERS);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const session = useRef<{ id?: string; context?: Record<string, unknown> | null }>({});
  const nextId = useRef(1);
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);

  const add = (turn: Omit<Turn, 'id'>) => setTurns((all) => [...all, { ...turn, id: nextId.current++ }]);

  const send = async (raw: string) => {
    const message = raw.trim();
    if (!message || busy) return;
    setDraft('');
    setSuggestions([]);
    add({ from: 'you', text: message });
    setBusy(true);
    try {
      const reply = await assistantApi.message({ message, session_id: session.current.id, context: session.current.context });
      session.current = { id: reply.session_id, context: reply.context };
      add({ from: 'assistant', text: reply.reply, link: actionLink(reply.action), choices: reply.choices });
      setSuggestions(reply.suggestions.slice(0, 4));
    } catch (e) {
      add({ from: 'system', text: isApiError(e) && e.kind === 'network' ? 'You seem to be offline. Please try again when you’re connected.' : 'The assistant couldn’t answer just now. Please try again.' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.root}>
      <StatusBar style="light" />
      <View style={[styles.header, { paddingTop: insets.top + spacing.s2, paddingLeft: spacing.s3 + insets.left, paddingRight: spacing.s3 + insets.right }]}>
        <Pressable onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))} accessibilityRole="button" accessibilityLabel="Back" style={styles.round}>
          <Ionicons name="chevron-back" size={22} color={colors.white} />
        </Pressable>
        <View style={styles.avatar}>
          <Ionicons name="chatbubble-ellipses" size={20} color={colors.navy900} />
        </View>
        <View style={styles.flex}>
          <Text variant="h3" color="white" accessibilityRole="header">
            Travel Assistant
          </Text>
          <Text variant="caption" color="onDark2">
            Replies instantly
          </Text>
        </View>
        <Pressable onPress={() => router.push('/support')} accessibilityRole="button" style={({ pressed }) => [styles.person, pressed && styles.pressed]}>
          <Ionicons name="person-outline" size={14} color={colors.goldLight} />
          <Text variant="caption" chrome color="goldLight" style={styles.personText}>
            Talk to a person
          </Text>
        </Pressable>
      </View>

      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView
          ref={scroll}
          style={styles.flex}
          contentContainerStyle={[styles.log, { paddingLeft: spacing.s4 + insets.left, paddingRight: spacing.s4 + insets.right }]}
          onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: true })}
          keyboardShouldPersistTaps="handled"
          accessibilityLabel="Conversation"
        >
          {turns.map((turn) => (
            <View key={turn.id} style={turn.from === 'you' ? styles.mine : styles.theirs}>
              <View style={turn.from === 'you' ? styles.bubbleMine : turn.from === 'system' ? styles.bubbleSystem : styles.bubbleTheirs}>
                <Text variant="body" color={turn.from === 'you' ? 'white' : 'ink'} style={styles.bubbleText}>
                  {turn.text}
                </Text>
              </View>
              {turn.link ? (
                <Pressable onPress={() => router.push(turn.link!.href)} accessibilityRole="link" style={({ pressed }) => [styles.action, pressed && styles.pressed]}>
                  <View style={styles.actionIcon}>
                    <Ionicons name={turn.link.icon} size={20} color={colors.goldInk} />
                  </View>
                  <Text variant="bodyStrong" color="ink" style={styles.flex}>
                    {turn.link.label}
                  </Text>
                  <Ionicons name="chevron-forward" size={18} color={colors.goldInk} />
                </Pressable>
              ) : null}
              {turn.choices?.length ? (
                <View style={styles.chips}>
                  {turn.choices.map((choice) => (
                    <Pressable key={choice.label} onPress={() => void send(choice.message)} accessibilityRole="button" style={({ pressed }) => [styles.chip, pressed && styles.pressed]}>
                      <Text variant="small" chrome color="goldInk" style={styles.chipText}>
                        {choice.label}
                      </Text>
                    </Pressable>
                  ))}
                </View>
              ) : null}
            </View>
          ))}
          {busy ? (
            <View style={[styles.theirs, styles.typing]} accessibilityLiveRegion="polite">
              <CircleLoader size={16} label="The assistant is replying" />
              <Text variant="small" color="textSecondary">
                Thinking…
              </Text>
            </View>
          ) : null}
          {suggestions.length && !busy ? (
            <View style={styles.chips}>
              {suggestions.map((s) => (
                <Pressable key={s} onPress={() => void send(s)} accessibilityRole="button" style={({ pressed }) => [styles.chip, pressed && styles.pressed]}>
                  <Text variant="small" chrome color="goldInk" style={styles.chipText}>
                    {s}
                  </Text>
                </Pressable>
              ))}
            </View>
          ) : null}
        </ScrollView>

        <View style={[styles.composer, { paddingBottom: Math.max(insets.bottom, spacing.s3), paddingLeft: spacing.s3 + insets.left, paddingRight: spacing.s3 + insets.right }]}>
          <View style={styles.inputRow}>
            <TextInput
              value={draft}
              onChangeText={setDraft}
              placeholder="Ask about a trip or a booking"
              placeholderTextColor={colors.textDisabled}
              accessibilityLabel="Message"
              style={styles.input}
              returnKeyType="send"
              onSubmitEditing={() => void send(draft)}
              maxLength={500}
            />
            <Pressable
              onPress={() => void send(draft)}
              disabled={!draft.trim() || busy}
              accessibilityRole="button"
              accessibilityLabel="Send"
              accessibilityState={{ disabled: !draft.trim() || busy }}
              style={({ pressed }) => [styles.send, (!draft.trim() || busy) && styles.sendOff, pressed && styles.pressed]}
            >
              <Ionicons name="send" size={18} color={colors.white} />
            </Pressable>
          </View>
          <Text variant="caption" color="textSecondary" align="center">
            The assistant can make mistakes. Prices and availability always come from our search.
          </Text>
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  flex: { flex: 1, minWidth: 0 },
  pressed: { opacity: 0.7 },
  header: { backgroundColor: colors.navy900, flexDirection: 'row', alignItems: 'center', gap: spacing.s3, paddingBottom: spacing.s3 },
  round: { width: 44, height: 44, borderRadius: 22, backgroundColor: colors.navy700, alignItems: 'center', justifyContent: 'center' },
  avatar: { width: 40, height: 40, borderRadius: 20, backgroundColor: colors.gold, alignItems: 'center', justifyContent: 'center' },
  person: { minHeight: 36, borderRadius: 18, borderWidth: 1, borderColor: colors.navy600, paddingHorizontal: spacing.s3, flexDirection: 'row', alignItems: 'center', gap: 6 },
  personText: { fontFamily: fontFamily.sansBold },
  log: { paddingVertical: spacing.s4, gap: spacing.s3 },
  mine: { alignSelf: 'flex-end', maxWidth: '82%', gap: spacing.s2 },
  theirs: { alignSelf: 'flex-start', maxWidth: '86%', gap: spacing.s2 },
  bubbleMine: { backgroundColor: colors.primary, borderRadius: 18, borderTopRightRadius: 6, paddingHorizontal: 14, paddingVertical: 12 },
  bubbleTheirs: { backgroundColor: colors.surface, borderRadius: 18, borderTopLeftRadius: 6, paddingHorizontal: 14, paddingVertical: 12 },
  bubbleSystem: { backgroundColor: colors.warningSoft, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 10 },
  bubbleText: { fontSize: 14.5, lineHeight: 21 },
  action: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1.5,
    borderColor: colors.gold,
    padding: spacing.s3,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.s3,
    minHeight: 56,
  },
  actionIcon: { width: 40, height: 40, borderRadius: 12, backgroundColor: '#FBF3DF', alignItems: 'center', justifyContent: 'center' },
  typing: { flexDirection: 'row', alignItems: 'center', gap: spacing.s2, backgroundColor: colors.surface, borderRadius: 18, paddingHorizontal: 14, paddingVertical: 10 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.s2 },
  chip: { minHeight: 36, borderRadius: 18, borderWidth: 1, borderColor: '#E3C98C', backgroundColor: '#FFFCF4', paddingHorizontal: spacing.s3, justifyContent: 'center' },
  chipText: { fontFamily: fontFamily.sansBold },
  composer: { backgroundColor: colors.surface, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.divider, paddingTop: spacing.s3, gap: spacing.s2 },
  inputRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.s2 },
  input: {
    flex: 1,
    minHeight: 50,
    borderRadius: 25,
    borderWidth: 1.5,
    borderColor: colors.line,
    paddingHorizontal: spacing.s4,
    fontFamily: fontFamily.sansMedium,
    fontSize: 15,
    color: colors.ink,
  },
  send: { width: 50, height: 50, borderRadius: 25, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center' },
  sendOff: { opacity: 0.4 },
});
