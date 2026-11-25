/**
 * Messages, sent by name.
 *
 * "Text Sarah that I'm running late" names a person and a sentence, and nothing else: there is
 * no device to turn on and no state to read. Every other fast path in this proxy answers with a
 * tool call that Home Assistant runs, but ha-bluebubbles registers
 * `bluebubbles.send_message` and no LLM-API tool, so Home Assistant never offers anything an
 * Assist turn could call — a tool call here would be a call into nothing.
 *
 * So this reader does the whole thing, which is why it is the only one that acts rather than
 * describes. It reads the sentence, resolves the spoken name against the contacts configured
 * for it, calls the service over the websocket the catalog is already read over, and says what
 * happened. Three deliberate choices:
 *
 *  1. **The name is resolved here, not in Home Assistant.** ha-bluebubbles addresses a message
 *     by phone number or email (`addresses`), and a person says "Sarah". The contacts map is
 *     what turns one into the other. It lives in this proxy's settings because the resolution
 *     happens here, and because a helper entity in Home Assistant would need an automation to
 *     stay in step with it.
 *  2. **The body is never invented.** Everything after the name is the message, as said, minus
 *     the words that introduced it ("that", "saying", "and tell her"). A sentence that names no
 *     body at all — "text Sarah" — is not a message, so it is left to the model to ask about.
 *  3. **A name that resolves to nothing is a question, not a guess.** Two contacts called Sarah
 *     is "Who do you mean?", and an unknown name says so. Sending a personal message to the
 *     wrong person is the one mistake this feature cannot take back.
 *
 * Only the sentence shape is read here: who to resolve and what to say. Whether anything may go
 * out at all (the service name, the confirmation) is `messaging` in the config, and the decision
 * to act at all is the pipeline's.
 */

import type { Contact, Config } from './config.js';
import type { SendPlan } from './types.js';

/** What a sentence asked for, or what has to be settled before anything is sent. */
export type MessagingRead =
  | { kind: 'send'; plan: SendPlan; reason: string }
  | { kind: 'ask'; text: string; reason: string }
  | { kind: 'error'; error: string };

/** A sentence read as a recipient and a body, before any name is resolved. */
export interface MessagingSentence {
  /** Who was named, one entry per recipient, in the words that were said. */
  recipients: string[];
  /** The message itself. */
  message: string;
}

/**
 * Leading words that say nothing about the request.
 *
 * A speaker says "hey, can you text Sarah …" far more often than "text Sarah …", and the
 * request is the same either way.
 */
const LEAD =
  /^(?:(?:ok|okay|hey|hi|hello|so|now|and|also|please|can you|could you|would you|will you|i want you to|i'd like you to|i need you to|go ahead and)\s+)+/i;

/** "text Sarah that I'm late", "message Sarah …", "imessage …", "sms …", "msg …". */
const VERB = /^(?:text|imessage|sms|message|msg)\s+(?<rest>[\s\S]+)$/i;

/** "send a text to Sarah saying I'm late", "send an sms to …". */
const SEND_TO = /^send\s+(?:a\s+|an\s+)?(?:text|message|imessage|sms)\s+to\s+(?<rest>[\s\S]+)$/i;

/** "send Sarah a text saying I'm late" — the bodyless form is not a message. */
const SEND_OBJECT =
  /^send\s+(?<who>[\s\S]+?)\s+(?:a|an)\s+(?:text|message|imessage|sms)\s+(?:that\s+|saying\s+|to say\s+|which says\s+)(?<body>[\s\S]+)$/i;

/**
 * Where the name stops and the message starts.
 *
 * A person marks that boundary one of three ways: a comma or colon ("text Sarah, I'm late"), a
 * spoken word ("saying", "that", "and say"), or a dash with spaces around it — never a bare
 * dash, because a spoken phone number has those in it.
 */
const BODY =
  /^(?<who>[\s\S]+?)(?:\s*(?:,|:)\s*|\s+[-–—]\s+|\s+(?:saying(?:\s+that)?|that\s+says|to\s+say|and\s+say|which\s+says|with\s+the\s+message|that)\s+)(?<body>[\s\S]+)$/i;

/** Several recipients in one turn: "text Sarah and Bob …", "text Sarah, Bob …". */
const SEPARATOR = /\s*(?:,|;|&|\band\b|\bplus\b)\s*/i;

/** A phone number or an email address, said as its own recipient. */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE = /^[+()\d][\d\s().-]*$/;

/**
 * Strip the words that introduce a message.
 *
 * "… and tell her I'm late" is the same message as "… I'm late"; so is a quoted one. Speech
 * recognition also adds a trailing full stop that the message itself would not have.
 */
function tidyBody(text: string): string {
  let body = text
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/^["“”'‘’]+/, '')
    .replace(/["“”'‘’]+$/, '')
    .trim();
  const told = /^(?:and\s+)?(?:tell\s+(?:her|him|them)\s+(?:that\s+)?|say\s+(?:that\s+)?)(?<body>[\s\S]+)$/i.exec(body);
  if (told?.groups?.body) body = told.groups.body.trim();
  return body;
}

function isAddress(text: string): boolean {
  if (EMAIL.test(text)) return true;
  return PHONE.test(text) && text.replace(/\D/g, '').length >= 7;
}

/** A spoken number sent as digits, with a leading `+` kept when it was said. */
function tidyAddress(text: string): string {
  const trimmed = text.trim();
  if (EMAIL.test(trimmed)) return trimmed;
  const digits = trimmed.replace(/\D/g, '');
  return trimmed.startsWith('+') ? `+${digits}` : digits;
}

/** Lower case, no quotes, no possessive, no leading "the"/"my": what a name is compared on. */
function normaliseName(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/^["“'‘]+|["”'’]+$/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^(?:the|my)\s+/, '')
    .replace(/['’]s$/, '')
    .trim();
}

function firstWord(name: string): string {
  return normaliseName(name).split(' ')[0] ?? '';
}

/**
 * Where a known contact's name ends and the body begins, when the speaker named no boundary.
 *
 * "Text Sarah I'm running late" is said far more often than "text Sarah that I'm running late",
 * and only the configured contacts can say where "Sarah" stops. The longest name wins, so a
 * contact listed as "Sarah Miller" beats one listed as "Sarah".
 */
function contactPrefix(rest: string, contacts: Contact[]): MessagingSentence | null {
  const spoken = rest.trim();
  let best: { name: string; body: string } | null = null;
  for (const contact of contacts) {
    const name = normaliseName(contact.name);
    if (!name) continue;
    if (spoken.toLowerCase().slice(0, name.length) !== name) continue;
    const after = spoken.slice(name.length);
    // The name has to be a word, not the start of one: "Sam" is not the start of "Samantha".
    if (!/^[\s,:-]/.test(after)) continue;
    const body = tidyBody(after.replace(/^[\s,:-]+/, ''));
    if (!body) continue;
    if (!best || name.length > normaliseName(best.name).length) best = { name: contact.name, body };
  }
  return best ? { recipients: [best.name], message: best.body } : null;
}

/**
 * Read one sentence as "send this to these people".
 *
 * `contacts` is what lets a name with no punctuation after it be read at all, so it is part of
 * the parse rather than something applied afterwards.
 */
export function readMessagingSentence(utterance: string, contacts: Contact[]): MessagingSentence | null {
  const text = utterance.trim().replace(LEAD, '').replace(/\s+/g, ' ').trim();
  if (!text) return null;

  const object = SEND_OBJECT.exec(text);
  if (object?.groups?.who && object.groups.body) {
    const recipients = splitWho(object.groups.who);
    const message = tidyBody(object.groups.body);
    return recipients.length > 0 && message ? { recipients, message } : null;
  }

  const rest = SEND_TO.exec(text)?.groups?.rest ?? VERB.exec(text)?.groups?.rest;
  if (!rest) return null;

  const split = BODY.exec(rest);
  if (split?.groups?.who && split.groups.body) {
    const recipients = splitWho(split.groups.who);
    const message = tidyBody(split.groups.body);
    if (recipients.length > 0 && message) return { recipients, message };
  }

  return contactPrefix(rest, contacts) ?? addressPrefix(rest);
}

function splitWho(who: string): string[] {
  return who
    .split(SEPARATOR)
    .map((part) => part.trim())
    .filter(Boolean);
}

/** "text +15551234567 I'm late": a number said as the recipient, with no separator after it. */
function addressPrefix(rest: string): MessagingSentence | null {
  const match = /^(?<who>[^\s]+)\s+(?<body>[\s\S]+)$/.exec(rest.trim());
  if (!match?.groups?.who || !match.groups.body) return null;
  const who = match.groups.who.replace(/[,:]$/, '');
  if (!isAddress(who)) return null;
  const message = tidyBody(match.groups.body);
  return message ? { recipients: [who], message } : null;
}

/** What one spoken recipient turned out to mean. */
export type NameMatch =
  | { kind: 'contact'; contact: Contact }
  /** A phone number or address said outright, which needs no contact row. */
  | { kind: 'address'; address: string }
  | { kind: 'ambiguous'; options: string[] }
  | { kind: 'unknown' };

/**
 * Resolve one spoken name.
 *
 * A whole name first, because "Sara" and "Sarah" are different people; then the first word,
 * because nobody says a surname to their own assistant. Two matches of either kind stays
 * ambiguous: picking the first row would send a personal message to the wrong person.
 */
export function matchContact(contacts: Contact[], spoken: string): NameMatch {
  const said = normaliseName(spoken);
  if (!said) return { kind: 'unknown' };
  if (isAddress(said)) return { kind: 'address', address: tidyAddress(said) };

  const whole = contacts.filter((contact) => normaliseName(contact.name) === said);
  if (whole.length === 1 && whole[0]) return { kind: 'contact', contact: whole[0] };
  if (whole.length > 1) return { kind: 'ambiguous', options: whole.map((contact) => contact.name) };

  const word = said.split(' ')[0] ?? said;
  const byFirst = contacts.filter((contact) => firstWord(contact.name) === word);
  if (byFirst.length === 1 && byFirst[0]) return { kind: 'contact', contact: byFirst[0] };
  if (byFirst.length > 1) return { kind: 'ambiguous', options: byFirst.map((contact) => contact.name) };
  return { kind: 'unknown' };
}

function joinChoices(options: string[]): string {
  if (options.length <= 1) return options[0] ?? '';
  return `${options.slice(0, -1).join(', ')} or ${options[options.length - 1]}`;
}

/** The address list a plan sends to, deduplicated: the same person named twice is one message. */
function dedupe(plan: SendPlan): SendPlan {
  return { ...plan, addresses: [...new Set(plan.addresses.filter(Boolean))] };
}

export interface MessagingInput {
  utterance: string;
  config: Config;
}

/**
 * Read one sentence into a plan, a question, or an error.
 *
 * `null` means the sentence is not a message at all, and the turn belongs to the model exactly
 * as it did before this reader existed.
 */
export function messagingPlan({ utterance, config }: MessagingInput): MessagingRead | null {
  const contacts = config.messaging.contacts;
  const sentence = readMessagingSentence(utterance, contacts);
  if (!sentence) return null;

  const service = config.messaging.service.trim().toLowerCase();
  if (!/^[a-z0-9_]+\.[a-z0-9_]+$/.test(service)) {
    return { kind: 'error', error: `"${config.messaging.service}" is not a Home Assistant service` };
  }

  const addresses: string[] = [];
  const names: string[] = [];
  for (const spoken of sentence.recipients) {
    const match = matchContact(contacts, spoken);
    if (match.kind === 'address') {
      addresses.push(match.address);
      names.push(spoken);
      continue;
    }
    if (match.kind === 'contact') {
      addresses.push(match.contact.address.trim());
      names.push(match.contact.name);
      continue;
    }
    if (match.kind === 'ambiguous') {
      return {
        kind: 'ask',
        text: `Who do you mean — ${joinChoices(match.options)}?`,
        reason: `“${spoken}” matches more than one contact`,
      };
    }
    return {
      kind: 'ask',
      text: `I don't have a contact called ${spoken}. Add one under Settings, Messages.`,
      reason: `no contact called “${spoken}”`,
    };
  }

  const contact = [...new Set(names)].join(' and ');
  const plan = dedupe({ kind: 'send', service, addresses, contact, message: sentence.message });
  if (plan.addresses.length === 0) {
    return { kind: 'ask', text: `I don't have an address for ${contact}.`, reason: `no address for ${contact}` };
  }
  return { kind: 'send', plan, reason: `texting ${contact} through ${service}` };
}

/** The slots `bluebubbles.send_message` takes, built from the plan. */
export function sendServiceData(plan: SendPlan): Record<string, unknown> {
  // ha-bluebubbles takes the recipients as one comma-separated string and needs the Private API
  // for a group; the body is sent exactly as the speaker said it.
  return { addresses: plan.addresses.join(', '), message: plan.message };
}

/** Said once the message is away. */
export function spokenSend(plan: SendPlan): string {
  return `Sent it to ${plan.contact}.`;
}

/** Said before sending, when the house asked to be sure. */
export function spokenConfirm(plan: SendPlan): string {
  return `Should I text ${plan.contact} “${plan.message}”?`;
}

/** Said when Home Assistant refused the call — never a claim that the message went out. */
export function spokenFailure(plan: SendPlan, error: string): string {
  // Home Assistant's message may or may not end in a stop, and the sentence is spoken: close
  // it either way, so the reason never runs into the next sentence the house says.
  const reason = error.trim().replace(/[.!?]*$/, '.');
  return `I couldn't send that to ${plan.contact}: ${reason}`;
}
