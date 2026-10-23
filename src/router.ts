/**
 * The decision tree.
 *
 * A typed answer only becomes an action when it clears its own confidence gate *and*
 * the top-two margin is wide enough to mean the model actually chose. Everything that
 * fails a gate falls through to the forward path, so the worst case is exactly the
 * behaviour the user had before the proxy existed.
 */

import {
  ACTION_VERBS,
  INCREASING_ACTIONS,
  RISKY_ACTIONS,
  RISKY_DEVICE_CLASSES,
  RISKY_DOMAINS,
  specFor,
} from './actions.js';
import type { Config, DecisionThresholds } from './config.js';
import type { Extraction } from './extract.js';
import { Q, NO_AREA, NO_DOMAIN, NO_SINGLE_ENTITY, NOT_TARGETED, actionQuestion } from './questions.js';
import type { BuiltQuestions } from './questions.js';
import type {
  Answer,
  Catalog,
  CatalogEntity,
  ChoiceAnswer,
  Gate,
  Plan,
  RouteResult,
  ToolCallPlan,
} from './types.js';
import { buildToolCall, magnitudeStep, relativeTarget } from './toolcall.js';
import type { ToolInventory } from './toolcall.js';
import { INTENTS } from './actions.js';
import { marginOf } from './systemone.js';
import { round, normalise } from './util.js';

export interface RouteContext {
  utterance: string;
  language?: string;
  catalog: Catalog;
  answers: Record<string, Answer>;
  built: BuiltQuestions;
  extraction: Extraction;
  config: Config;
  inventory: ToolInventory;
}

export function choiceOf(answers: Record<string, Answer>, id: string): ChoiceAnswer | undefined {
  const answer = answers[id];
  return answer && answer.type === 'choice' ? answer : undefined;
}

export function noulOf(answers: Record<string, Answer>, id: string): number | undefined {
  const answer = answers[id];
  return answer && answer.type === 'noul' ? answer.noul : undefined;
}

function gateChoice(
  gates: Gate[],
  question: string,
  answer: ChoiceAnswer | undefined,
  threshold: number,
  minMargin: number,
): boolean {
  if (!answer) {
    gates.push({ question, passed: false, threshold });
    return false;
  }
  const margin = marginOf(answer);
  const probability = answer.probabilities[answer.choice] ?? answer.confidence;
  const passed = probability >= threshold && margin >= minMargin;
  gates.push({
    question,
    choice: answer.choice,
    probability: round(probability, 3),
    margin,
    threshold,
    passed,
  });
  return passed;
}

function gateNoul(gates: Gate[], question: string, value: number | undefined, threshold: number): boolean {
  const passed = value !== undefined && value >= threshold;
  gates.push({ question, probability: value, threshold, passed });
  return passed;
}

function forward(reason: string, gates: Gate[], extra: Partial<RouteResult> = {}): RouteResult {
  return { plan: { kind: 'forward', reason }, gates, reason, ...extra };
}

function templates(config: Config, language: string | undefined) {
  const key = (language ?? 'en').split('-')[0] ?? 'en';
  return config.speech.templates[key] ?? config.speech.templates.en ?? {
    done: '{action} {entity}.',
    clarify: 'Which one did you mean: {options}?',
    confirm: 'Do you want me to {action} the {entity}?',
  };
}

function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? '');
}

function entityLabel(entity: CatalogEntity): string {
  return entity.name || entity.id;
}

const CONFIRM_INFINITIVES: Record<string, string> = {
  unlock: 'unlock',
  lock: 'lock',
  open: 'open',
  close: 'close',
  disarm: 'disarm',
  turn_on: 'turn on',
  turn_off: 'turn off',
};

/** Is this action one that should be confirmed before it runs? */
function isRisky(
  action: string,
  domain: string | undefined,
  target: { entity?: CatalogEntity },
  riskyAnswer: number | undefined,
  thresholds: DecisionThresholds,
): boolean {
  if (RISKY_ACTIONS.has(action)) return true;
  if (domain && RISKY_DOMAINS.has(domain) && (action === 'open' || action === 'unlock')) return true;
  if (target.entity?.deviceClass && RISKY_DEVICE_CLASSES.has(target.entity.deviceClass)) return true;
  return (riskyAnswer ?? 0) >= thresholds.noulRisky;
}

export function route(ctx: RouteContext): RouteResult {
  const { answers, config, inventory, extraction, built, catalog } = ctx;
  const t = config.routing.thresholds;
  const gates: Gate[] = [];

  const category = choiceOf(answers, Q.category);
  if (!category) return forward('the decision model did not answer the category question', gates);

  // --- compound: out of scope in v1, the LLM splits it ---------------------
  if (gateNoul(gates, Q.compound, noulOf(answers, Q.compound), t.noulCompound)) {
    return forward('compound request', gates, { category: category.choice });
  }

  // Does the utterance clearly name something to act on? That decides how sure the
  // category answer has to be before a command is taken over.
  const entityAnswer = choiceOf(answers, Q.targetEntity);
  const namedEntity = entityAnswer ? built.entityOptions.get(entityAnswer.choice) : undefined;
  const domainAnswer = choiceOf(answers, Q.targetDomain);
  const namedDomain = domainAnswer && domainAnswer.choice !== NO_DOMAIN ? domainAnswer.choice : undefined;
  const areaAnswer = choiceOf(answers, Q.targetArea);
  const namedArea = areaAnswer ? built.areaOptions.get(areaAnswer.choice) : undefined;
  const explicit = Boolean(
    (namedEntity && entityAnswer && entityAnswer.confidence >= t.entity) ||
      (namedArea && areaAnswer && areaAnswer.confidence >= t.area) ||
      (namedDomain && domainAnswer && domainAnswer.confidence >= t.domain),
  );
  const categoryThreshold =
    category.choice === 'cancel'
      ? t.categoryCancel
      : category.choice === 'information'
        ? t.categoryInformation
        : category.choice === 'unclear'
          ? t.categoryUnclear
          : category.choice === 'query'
            ? t.categoryQuery
            : explicit
              ? t.actExplicit
              : t.actTerse;

  if (!gateChoice(gates, Q.category, category, categoryThreshold, t.minMargin)) {
    return forward(`category "${category.choice}" is not confident enough`, gates, {
      category: category.choice,
    });
  }

  if (category.choice === 'information') {
    return forward('informational request', gates, { category: category.choice });
  }
  if (category.choice === 'unclear') {
    return forward('unclear request', gates, { category: category.choice });
  }
  if (category.choice === 'cancel') {
    if (inventory.has(INTENTS.nevermind)) {
      return {
        plan: { kind: 'tool', tool: INTENTS.nevermind, args: {}, targets: [], action: 'cancel' },
        gates,
        reason: 'cancel',
        category: 'cancel',
        action: 'cancel',
      };
    }
    return { plan: { kind: 'text', text: '' }, gates, reason: 'cancel with nothing to cancel', category: 'cancel' };
  }

  if (category.choice === 'query') return planQuery(ctx, gates);
  return planCommand(ctx, gates);
}

// --- queries ----------------------------------------------------------------

function planQuery(ctx: RouteContext, gates: Gate[]): RouteResult {
  const { answers, config, inventory, extraction, built, catalog } = ctx;
  const t = config.routing.thresholds;
  const queryKind = choiceOf(answers, Q.queryKind);
  if (!gateChoice(gates, Q.queryKind, queryKind, t.queryKind, t.minMargin)) {
    return forward('no confident reading of the question', gates, { category: 'query' });
  }
  const kind = queryKind!.choice;

  if (kind === 'time_or_date') {
    const intent = kind === 'time_or_date' && /date|day|today|month|year/i.test(ctx.utterance)
      ? INTENTS.getCurrentDate
      : INTENTS.getCurrentTime;
    if (inventory.has(intent)) {
      return {
        plan: { kind: 'tool', tool: intent, args: {}, targets: [], action: 'query' },
        gates,
        reason: `query:${kind}`,
        category: 'query',
        action: 'query',
      };
    }
    return forward('no time/date intent offered', gates, { category: 'query' });
  }

  if (kind === 'needs_prose' || kind === 'not_a_query') {
    return forward(`question needs prose (${kind})`, gates, { category: 'query' });
  }

  if (kind === 'temperature') {
    const entity = entityFrom(answers, built, t);
    if (inventory.has(INTENTS.climateGetTemperature) && entity) {
      return {
        plan: {
          kind: 'tool',
          tool: INTENTS.climateGetTemperature,
          args: { name: entity.id },
          targets: [entity.id],
          action: 'query',
          domain: entity.domain,
        },
        gates,
        reason: 'query:temperature',
        category: 'query',
        action: 'query',
        target: entity.id,
      };
    }
    return forward('temperature question without a confident target', gates, { category: 'query' });
  }

  if (kind === 'count') {
    const domainAnswer = choiceOf(answers, Q.targetDomain);
    if (!gateChoice(gates, Q.targetDomain, domainAnswer, t.domain, t.minMargin)) {
      return forward('count question without a confident kind of device', gates, { category: 'query' });
    }
    const domain = domainAnswer!.choice;
    if (!inventory.has(INTENTS.getState)) return forward('no state intent offered', gates, { category: 'query' });
    const args: Record<string, unknown> = { domain };
    const state = extraction.stateWord;
    const call = buildToolCall({
      intent: INTENTS.getState,
      spec: { intentType: INTENTS.getState },
      inventory,
      target: { domain },
      action: 'query',
      text: state,
    });
    if ('error' in call) return forward(call.error, gates, { category: 'query' });
    if (state) {
      const slot = Object.keys(inventory.get(INTENTS.getState)?.parameters?.properties ?? {}).includes('state')
        ? 'state'
        : undefined;
      if (slot) call.args.state = state;
    }
    return {
      plan: { kind: 'tool', tool: call.tool, args: call.args, targets: [], action: 'query', domain },
      gates,
      reason: `query:count:${domain}`,
      category: 'query',
      action: 'query',
      target: domain,
    };
  }

  // device_state
  const entity = entityFrom(answers, built, t);
  if (!entity) {
    return forward('state question without a confident target', gates, { category: 'query' });
  }
  if (!gateChoice(gates, Q.targetEntity, choiceOf(answers, Q.targetEntity), t.entity, t.minMargin)) {
    return forward('entity answer failed its gate', gates, { category: 'query' });
  }
  if (!inventory.has(INTENTS.getState)) return forward('no state intent offered', gates, { category: 'query' });
  const call = buildToolCall({
    intent: INTENTS.getState,
    spec: { intentType: INTENTS.getState },
    inventory,
    target: { entity },
    action: 'query',
  });
  if ('error' in call) return forward(call.error, gates, { category: 'query' });
  return {
    plan: { kind: 'tool', tool: call.tool, args: call.args, targets: [entity.id], action: 'query', domain: entity.domain },
    gates,
    reason: `query:device_state:${entity.id}`,
    category: 'query',
    action: 'query',
    target: entity.id,
  };
}

// --- commands ---------------------------------------------------------------

function planCommand(ctx: RouteContext, gates: Gate[]): RouteResult {
  const { answers, config, inventory, extraction, built, catalog, utterance } = ctx;
  const t = config.routing.thresholds;
  const said = templates(config, ctx.language);

  const scopeAnswer = choiceOf(answers, Q.scope);
  if (!scopeAnswer) return forward('the decision model did not answer the scope question', gates);
  const scopeThreshold = scopeAnswer.choice === 'whole_house' ? t.scopeWholeHouse : t.scope;
  if (!gateChoice(gates, Q.scope, scopeAnswer, scopeThreshold, t.minMargin)) {
    return forward('no confident reading of the target width', gates, { category: 'command' });
  }
  const scope = scopeAnswer.choice;
  if (scope === 'not_a_target') return forward('nothing in the home is targeted', gates, { category: 'command' });
  if (scope === 'floor') return forward('floor-wide requests are not handled by the fast path', gates, { category: 'command' });

  // Where does the request land?
  const hereRelative = noulOf(answers, Q.hereRelative) ?? 0;
  const wantsHere = hereRelative >= t.noulHereRelative;

  let targetEntity: CatalogEntity | undefined;
  let targetRoom: { id: string; name: string } | undefined;
  let reduceHint = false;

  if (scope === 'single') {
    const answer = choiceOf(answers, Q.targetEntity);
    const chosen = answer ? built.entityOptions.get(answer.choice) : undefined;
    const gateOk = gateChoice(gates, Q.targetEntity, answer, t.entity, t.minMargin);
    if (chosen && gateOk) {
      targetEntity = chosen;
    } else if (answer && answer.choice !== NO_SINGLE_ENTITY) {
      // Close, but not close enough: name the runners-up and let the speaker choose.
      const candidates = Object.entries(answer.probabilities)
        .filter(([id]) => id !== NO_SINGLE_ENTITY && built.entityOptions.has(id))
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([id]) => built.entityOptions.get(id)!);
      if (candidates.length > 0 && answer.confidence >= t.clarifyFloor) {
        return {
          plan: {
            kind: 'clarify',
            text: fill(said.clarify, { options: candidates.map(entityLabel).join(', ') }),
            options: candidates.map(entityLabel),
          },
          gates,
          reason: 'ambiguous target',
          category: 'command',
          target: candidates[0]?.id,
        };
      }
    }
    if (!targetEntity && answer) {
      // The words fit more than one device equally well. Ask, rather than guessing or
      // handing the turn to the model: two lights called "kitchen …" are exactly the
      // case a speaker expects a question about.
      const tied = tiedNameCandidates(utterance, built.entityOptions);
      if (tied.length >= 2) {
        return {
          plan: {
            kind: 'clarify',
            text: fill(said.clarify, { options: tied.map(entityLabel).join(', ') }),
            options: tied.map(entityLabel),
          },
          gates,
          reason: 'ambiguous target: several devices fit equally well',
          category: 'command',
          target: tied[0]?.id,
        };
      }
    }
    if (!targetEntity) {
      // No single device: fall back to a room-wide request if a room is clear.
      const areaGateOk = gateChoice(gates, Q.targetArea, choiceOf(answers, Q.targetArea), t.area, t.minMargin);
      const room = areaGateOk && areaAnswerOf(answers, built);
      if (room) {
        targetRoom = room;
        reduceHint = true;
      } else if (wantsHere) {
        const spoken = ctx.config.catalog.defaultArea;
        if (spoken) {
          const area = catalog.areas.find((candidate) => candidate.name.toLowerCase() === spoken.toLowerCase());
          if (area) targetRoom = { id: area.id, name: area.name };
        }
      }
      if (!targetEntity && !targetRoom) {
        return forward('no confident single target', gates, { category: 'command' });
      }
    }
  } else if (scope === 'area' || wantsHere) {
    const room = areaAnswerOf(answers, built);
    const areaGateOk = gateChoice(gates, Q.targetArea, choiceOf(answers, Q.targetArea), t.area, t.minMargin);
    if (room && areaGateOk) {
      targetRoom = room;
    } else if (wantsHere) {
      const spoken = config.catalog.defaultArea;
      const area = spoken
        ? catalog.areas.find((candidate) => candidate.name.toLowerCase() === spoken.toLowerCase())
        : undefined;
      if (area) targetRoom = { id: area.id, name: area.name };
    }
    if (!targetRoom) return forward('no confident room', gates, { category: 'command' });
  }

  // Which kind of device?
  const domainAnswer = choiceOf(answers, Q.targetDomain);
  let domain = targetEntity?.domain;
  if (!domain) {
    if (!gateChoice(gates, Q.targetDomain, domainAnswer, t.domain, t.minMargin)) {
      return forward('no confident kind of device', gates, { category: 'command' });
    }
    domain = domainAnswer!.choice;
    if (domain === NO_DOMAIN) return forward('no kind of device named', gates, { category: 'command' });
  }

  // What should happen to it?
  const actionKey = actionQuestion(domain);
  const actionAnswer = choiceOf(answers, actionKey);
  if (!actionAnswer) return forward(`no action question for ${domain}`, gates, { category: 'command' });
  const actionMargin = marginOf(actionAnswer);
  const actionProbability = actionAnswer.probabilities[actionAnswer.choice] ?? actionAnswer.confidence;
  const actionPassed = actionProbability >= t.actionProbability && actionMargin >= t.minMargin;
  gates.push({
    question: actionKey,
    choice: actionAnswer.choice,
    probability: round(actionProbability, 3),
    margin: actionMargin,
    threshold: t.actionProbability,
    passed: actionPassed,
  });
  if (!actionPassed) return forward(`${domain} action is not confident enough`, gates, { category: 'command' });
  const action = actionAnswer.choice;
  if (action === NOT_TARGETED) return forward('the request is not about that kind of device', gates, { category: 'command' });

  const spec = specFor(domain, action);
  if (!spec) return forward(`${domain}:${action} has no Home Assistant intent`, gates, { category: 'command' });
  if (spec.nameOnly && !targetEntity) {
    return forward(`${action} needs one specific device`, gates, { category: 'command' });
  }
  if (spec.singleTarget && !targetEntity) {
    return forward(`${action} acts on one device only`, gates, { category: 'command' });
  }

  // Values.
  let value: number | undefined;
  let text: string | undefined;
  const directionAnswer = choiceOf(answers, Q.changeDirection);
  const direction = directionAnswer?.choice;
  const magnitude = choiceOf(answers, Q.magnitude)?.choice;

  if (spec.needsText) {
    if (spec.valueKind === undefined && spec.valueSlot === undefined && spec.needsText === 'color') {
      text = extraction.color ?? undefined;
      if (!text) return forward('no colour named', gates, { category: 'command' });
    } else if (spec.needsText === 'item') {
      text = extraction.item;
      if (!text) return forward('no list item named', gates, { category: 'command' });
    } else if (spec.needsText === 'search_query') {
      text = extraction.mediaQuery;
      if (!text) return forward('no media query named', gates, { category: 'command' });
    } else if (spec.needsText === 'mode') {
      text = undefined;
      return forward('mode changes are not handled by the fast path', gates, { category: 'command' });
    }
  }

  if (spec.valueSlot) {
    const kind = spec.valueKind;
    if (spec.relative) {
      const step = magnitudeStep(kind, magnitude);
      const increasing = INCREASING_ACTIONS.has(action);
      if (kind === 'volume_step') {
        value = (increasing ? 1 : -1) * step;
      } else {
        const resolved = relativeTarget(targetEntity, kind, step, increasing ? 1 : -1);
        if (resolved === undefined) {
          return forward(`no current level to move from for ${action}`, gates, { category: 'command' });
        }
        value = resolved;
      }
    } else if (direction === 'absolute' || direction === undefined) {
      value = absoluteValue(ctx, spec.valueSlot, spec.valueKind);
      if (value === undefined) {
        return forward(`no value stated for ${action}`, gates, { category: 'command' });
      }
    } else {
      return forward(`${action} without a stated value`, gates, { category: 'command' });
    }
  }

  const call = buildToolCall({
    intent: spec.intentType,
    spec,
    inventory,
    target: {
      ...(targetEntity ? { entity: targetEntity } : {}),
      ...(targetRoom ? { areaName: targetRoom.name } : {}),
      ...(domain ? { domain } : {}),
    },
    action,
    ...(value !== undefined ? { value } : {}),
    ...(text !== undefined ? { text } : {}),
  });
  if ('error' in call) return forward(call.error, gates, { category: 'command' });

  const targets = targetEntity ? [targetEntity.id] : targetRoom ? [targetRoom.name] : [domain];
  const plan: ToolCallPlan = {
    kind: 'tool',
    tool: call.tool,
    args: call.args,
    targets,
    action,
    domain,
  };

  const risky = isRisky(action, domain, targetEntity ? { entity: targetEntity } : {}, noulOf(answers, Q.risky), t);
  if (risky && config.decision.alwaysConfirmRisky) {
    const verb = CONFIRM_INFINITIVES[action] ?? ACTION_VERBS[action]?.toLowerCase() ?? action;
    return {
      plan: {
        kind: 'confirm',
        text: fill(said.confirm, { action: verb, entity: entityLabel(targetEntity ?? { name: targetRoom?.name ?? domain } as CatalogEntity) }),
        pending: plan,
      },
      gates,
      reason: 'risky action needs confirmation',
      category: 'command',
      action,
      target: targets[0],
      risky: true,
    };
  }

  return {
    plan,
    gates,
    reason: `${action}${targetEntity ? ` ${targetEntity.id}` : targetRoom ? ` in ${targetRoom.name}` : ` all ${domain}`}`,
    category: 'command',
    action,
    target: targets[0],
    risky,
  };
}

/**
 * The devices whose names the utterance fits at least as well as the best match.
 * Equality matters: `Kitchen Ceiling` and `Kitchen Overhead` both take one word from
 * "the kitchen light", so neither may win by accident.
 */
function tiedNameCandidates(
  utterance: string,
  options: Map<string, CatalogEntity>,
  limit = 3,
): CatalogEntity[] {
  const skip = new Set(['the', 'a', 'an', 'in', 'on', 'off', 'and', 'of', 'to', 'my', 'our', 'all', 'please', 'some']);
  const words = new Set(
    normalise(utterance)
      .split(' ')
      .filter((word) => word.length > 2 && !skip.has(word)),
  );
  if (words.size === 0) return [];

  const scored = [...options.values()].map((entity) => {
    const nameWords = normalise(entity.name).split(' ').filter((word) => word.length > 2);
    const shared = nameWords.filter((word) => words.has(word)).length;
    return { entity, shared };
  });
  const best = Math.max(...scored.map((entry) => entry.shared));
  if (best === 0) return [];
  return scored
    .filter((entry) => entry.shared === best)
    .slice(0, limit)
    .map((entry) => entry.entity);
}

function areaAnswerOf(
  answers: Record<string, Answer>,
  built: BuiltQuestions,
): { id: string; name: string } | undefined {
  const answer = choiceOf(answers, Q.targetArea);
  if (!answer || answer.choice === NO_AREA) return undefined;
  const area = built.areaOptions.get(answer.choice);
  return area ? { id: area.id, name: area.name } : undefined;
}

function entityFrom(
  answers: Record<string, Answer>,
  built: BuiltQuestions,
  thresholds: DecisionThresholds,
): CatalogEntity | undefined {
  const answer = choiceOf(answers, Q.targetEntity);
  if (!answer || answer.choice === NO_SINGLE_ENTITY) return undefined;
  const entity = built.entityOptions.get(answer.choice);
  if (!entity) return undefined;
  const probability = answer.probabilities[answer.choice] ?? answer.confidence;
  if (probability < thresholds.entity) return undefined;
  if (marginOf(answer) < thresholds.minMargin) return undefined;
  return entity;
}

function absoluteValue(
  ctx: RouteContext,
  slot: string,
  kind: string | undefined,
): number | undefined {
  const { extraction, answers, built } = ctx;
  const answer = choiceOf(answers, Q.valuePick);
  if (answer && answer.choice !== 'none') {
    const candidate = extraction.candidates.find((entry) => entry.id === answer.choice);
    if (candidate) {
      if (typeof candidate.value === 'number') return candidate.value;
    }
  }
  if (slot === 'brightness' || slot === 'position' || slot === 'percentage' || slot === 'humidity') {
    return extraction.percent;
  }
  if (slot === 'temperature') return extraction.number;
  if (slot === 'volume_level') return extraction.percent;
  return extraction.percent ?? extraction.number;
}
