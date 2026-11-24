import { http } from '../client';

/** What the assistant wants the app to open, with only what the traveller actually said (`dest`, `from`, `to`, …). */
export interface AssistantAction {
  type: string;
  params: Record<string, unknown>;
}

/** A selectable answer, offered when a place was misspelt or ambiguous ("Did you mean …"). */
export interface AssistantChoice {
  label: string;
  message: string;
}

export interface AssistantReply {
  session_id: string;
  reply: string;
  intent: string;
  action: AssistantAction;
  suggestions: string[];
  choices: AssistantChoice[];
  /** Sent back unchanged with the next message, so a follow-up applies to the search it follows. */
  context: Record<string, unknown> | null;
}

export interface AssistantRequest {
  message: string;
  session_id?: string;
  context?: Record<string, unknown> | null;
}

/**
 * The Travel Assistant (`/api/customer/assistant`). Open to guests; a signed-in customer's token is used when present.
 * It never sees a price, a room or a booking: a reply is words plus an action naming a screen, and that screen does
 * its own search under the customer's own session.
 */
export const assistantApi = {
  async message(request: AssistantRequest): Promise<AssistantReply> {
    const { data } = await http.post<AssistantReply>('/api/customer/assistant/message', { ...request, kind: 'assistant' });
    return { ...data, suggestions: data.suggestions ?? [], choices: data.choices ?? [], context: data.context ?? null };
  },
};
