/**
 * "Nevermind." — the sentence that ends the conversation instead of adding to it.
 *
 * Home Assistant has an intent for exactly this (HassNevermind) and the router already answers
 * a classified cancel with it. But the chatter filter sits in front of the decision and sends
 * every short remark to the model, so the phrases that mean "stop talking" — "nevermind",
 * "cancel that", "forget it" — cost a full model round trip before Home Assistant ever hears
 * the intent. On a satellite answering aloud, that round trip *is* the delay between saying it
 * and the answer stopping, and the model has nothing useful to add at the end of it.
 *
 * This reader is deliberately narrow: the whole sentence has to be one of the phrases below and
 * nothing more. "Never mind the lights" still reaches the model, because that sentence names
 * something to act on. The readers that do own a device run before this one — a timer, a
 * playing speaker, the media player — so "stop" only lands here when nothing in the house
 * could have been what was meant.
 */

import { INTENTS } from './actions.js';
import { findTool, type ToolInventory } from './toolcall.js';
import type { ToolCallPlan } from './types.js';
import { normalise } from './util.js';

/**
 * Sentences that do nothing but end the turn.
 *
 * Kept as whole sentences rather than a word list: "no" and "nothing" are answers to the
 * assistant's question, and a model reads those better than an intent call can.
 */
const CANCEL_ONLY = new Set([
  'never mind',
  'nevermind',
  'never mind that',
  'never mind it',
  'nevermind that',
  'nevermind it',
  'no never mind',
  'ok never mind',
  'okay never mind',
  'forget it',
  'forget that',
  'forget about it',
  'ignore that',
  'ignore it',
  'ignore this',
  'no thanks',
  'nothing thanks',
  'no thank you',
  'no thank you very much',
  'cancel',
  'cancel that',
  'cancel it',
  'stop',
  'stop it',
  'stop that',
  'quit',
  'exit',
  'that is all',
  'thats all',
  'that is it',
  'thats it',
  'that will be all',
  'that will do',
]);

/** The call that ends the conversation, or null when the sentence is anything else. */
export function cancelPlan(
  utterance: string,
  inventory: ToolInventory,
): { plan: ToolCallPlan; reason: string } | null {
  const spoken = normalise(utterance);
  if (!spoken || !CANCEL_ONLY.has(spoken)) return null;

  // Without the intent the turn falls through to the model: a conversation agent that does not
  // offer HassNevermind still answers a remark, and forwarding is what it did before.
  const tool = findTool(inventory, INTENTS.nevermind);
  if (!tool) return null;

  return {
    plan: { kind: 'tool', tool: tool.name, args: {}, targets: [], action: 'cancel' },
    reason: `cancel: "${utterance.trim()}" ends the turn, no model call`,
  };
}
