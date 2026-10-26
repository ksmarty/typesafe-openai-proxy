/**
 * Turning a plan into a tool call.
 *
 * Tool names and argument slots are read from the request Home Assistant actually
 * sent, never assumed: a name it does not offer, or a slot its schema does not
 * declare, means this proxy cannot act and the request is forwarded upstream instead.
 */

import { INTENTS, type ActionSpec } from './actions.js';
import type { CatalogEntity, OpenAITool, OpenAIToolFunction } from './types.js';
import { clamp } from './util.js';

export type ToolInventory = Map<string, OpenAIToolFunction>;

/**
 * Every intent this proxy knows how to call, as OpenAI tool definitions.
 *
 * Used by the dry-run probe: a real request carries Home Assistant's own list of
 * schemas, but a probe has no request behind it, and answering "not offered by
 * Home Assistant" for every dry run would make the probe useless.
 */
export function assistTools(): OpenAITool[] {
  // A permissive superset of the slots Home Assistant's intents accept, so a dry
  // run can build the call instead of reporting a missing slot.
  const slots = [
    'name',
    'area',
    'floor',
    'domain',
    'device_class',
    'brightness_pct',
    'brightness',
    'position',
    'percentage',
    'current_position',
    'temperature',
    'target_temperature',
    'volume_level',
    'volume_step',
    'humidity',
    'color_name',
    'color',
    'item',
    'mode',
    'search_query',
    'media_id',
    'query',
  ];
  const properties = Object.fromEntries(slots.map((slot) => [slot, { type: 'string' }]));
  return Object.values(INTENTS).map((name) => ({
    type: 'function' as const,
    function: {
      name,
      description: 'Home Assistant intent (dry run: every slot accepted)',
      parameters: { type: 'object', properties, required: [] },
    },
  }));
}

export function inventoryFor(tools: OpenAITool[] | undefined): ToolInventory {
  const map: ToolInventory = new Map();
  for (const tool of tools ?? []) {
    if (tool?.type === 'function' && tool.function?.name) map.set(tool.function.name, tool.function);
  }
  return map;
}

/**
 * Home Assistant offers its intents under a namespace: `assist__intent__HassTurnOn`,
 * `assist__light__HassLightSet`, `assist__media_player__HassMediaNext`. The name that has
 * to come back in the tool call is the namespaced one, so matching is done on the short
 * name while the namespaced name is what gets emitted.
 */
export function shortToolName(name: string): string {
  const seam = name.lastIndexOf('__');
  return seam === -1 ? name : name.slice(seam + 2);
}

/** The tool offering `intent`, under whatever name Home Assistant used. */
export function findTool(
  inventory: ToolInventory,
  intent: string,
): { name: string; function: OpenAIToolFunction } | undefined {
  const exact = inventory.get(intent);
  if (exact) return { name: intent, function: exact };
  for (const [name, fn] of inventory) {
    if (shortToolName(name) === intent) return { name, function: fn };
  }
  for (const [name, fn] of inventory) {
    if (shortToolName(name).endsWith(intent)) return { name, function: fn };
  }
  return undefined;
}

export function hasTool(inventory: ToolInventory, intent: string): boolean {
  return findTool(inventory, intent) !== undefined;
}

function propertiesOf(tool: OpenAIToolFunction): Record<string, { type?: string; enum?: unknown[] }> {
  return (tool.parameters?.properties ?? {}) as Record<string, { type?: string; enum?: unknown[] }>;
}

/** Slot aliases: the reference slot name -> names Home Assistant's schemas use. */
const SLOT_ALIASES: Record<string, string[]> = {
  brightness: ['brightness_pct', 'brightness'],
  position: ['position', 'percentage', 'current_position'],
  percentage: ['percentage'],
  temperature: ['temperature', 'target_temperature'],
  volume_level: ['volume_level'],
  volume_step: ['volume_step'],
  humidity: ['humidity'],
  color: ['color_name', 'color'],
  item: ['item'],
  mode: ['mode'],
  search_query: ['search_query', 'media_id', 'query'],
};

function pickSlot(
  properties: Record<string, unknown>,
  candidates: string[],
): string | undefined {
  return candidates.find((candidate) => Object.prototype.hasOwnProperty.call(properties, candidate));
}

/** Target an entity: Home Assistant's intent filters match an entity id passed as `name`. */
function targetArgs(
  properties: Record<string, unknown>,
  target: { entity?: CatalogEntity; areaName?: string; floorName?: string; domain?: string },
): Record<string, unknown> | { error: string } {
  const args: Record<string, unknown> = {};
  const offersName = Object.prototype.hasOwnProperty.call(properties, 'name');
  const offersArea = Object.prototype.hasOwnProperty.call(properties, 'area');
  const offersFloor = Object.prototype.hasOwnProperty.call(properties, 'floor');
  const offersDomain = Object.prototype.hasOwnProperty.call(properties, 'domain');

  if (target.entity) {
    if (!offersName) return { error: 'this intent has no name slot' };
    args.name = target.entity.id;
    return args;
  }
  if (target.areaName) {
    if (!offersArea) return { error: 'this intent has no area slot' };
    args.area = target.areaName;
    if (target.domain && offersDomain) args.domain = target.domain;
    return args;
  }
  if (target.floorName) {
    if (!offersFloor) return { error: 'this intent has no floor slot' };
    args.floor = target.floorName;
    if (target.domain && offersDomain) args.domain = target.domain;
    return args;
  }
  if (target.domain) {
    if (!offersDomain) return { error: 'this intent has no domain slot' };
    args.domain = target.domain;
    return args;
  }
  return { error: 'nothing to target' };
}

export interface ToolCallInput {
  intent: string;
  spec: ActionSpec;
  inventory: ToolInventory;
  target: { entity?: CatalogEntity; areaName?: string; floorName?: string; domain?: string };
  action: string;
  /** Value the plan resolved, already in the slot's natural unit (percent 0-100). */
  value?: number | string;
  /** Extra free text the intent needs (colour, list item, media query). */
  text?: string;
}

export interface ToolCallResult {
  tool: string;
  args: Record<string, unknown>;
}

/** `a, b, c (+4 more)` — short enough for a trace reason, specific enough to debug. */
export function describeInventory(inventory: ToolInventory): string {
  const names = [...inventory.keys()].map(shortToolName).sort();
  if (!names.length) return 'the request carried no tools at all';
  const shown = names.slice(0, 8).join(', ');
  return `it offered ${shown}${names.length > 8 ? ` (+${names.length - 8} more)` : ''}`;
}

export function buildToolCall(input: ToolCallInput): ToolCallResult | { error: string } {
  const { inventory, intent, spec } = input;
  const found = findTool(inventory, intent);
  if (!found) return { error: `${intent} is not offered by Home Assistant (${describeInventory(inventory)})` };
  const tool = found.function;
  const properties = propertiesOf(tool);

  const args = targetArgs(properties, input.target);
  if ('error' in args) return { error: String(args.error) };

  // Value slot.
  if (spec.valueSlot && input.value !== undefined && typeof input.value === 'number') {
    const slot = pickSlot(properties, SLOT_ALIASES[spec.valueSlot] ?? [spec.valueSlot]);
    if (!slot) return { error: `${intent} has no ${spec.valueSlot} slot` };
    let value = input.value;
    if (slot === 'brightness') value = Math.round(clamp(value, 0, 100) * 2.55);
    if (slot === 'volume_level') value = clamp(value, 0, 100);
    if (slot === 'position' || slot === 'current_position') value = clamp(value, 0, 100);
    if (slot === 'temperature') value = Math.round(value * 10) / 10;
    args[slot] = Math.round(value * 10) / 10;
  }

  // Free-text slot.
  if (spec.needsText && input.text) {
    const slot = pickSlot(properties, SLOT_ALIASES[spec.needsText] ?? [spec.needsText]);
    if (!slot) return { error: `${intent} has no ${spec.needsText} slot` };
    args[slot] = input.text;
  }

  return { tool: found.name, args };
}

/** A value relative to what the entity is doing now, for "brighter" / "louder". */
export function relativeTarget(
  entity: CatalogEntity | undefined,
  kind: ActionSpec['valueKind'],
  stepPercent: number,
  direction: 1 | -1,
): number | undefined {
  if (!entity) return undefined;
  const current = entity.level;
  if (current === undefined) return undefined;

  switch (kind) {
    case 'percent': {
      // Lights report brightness 0-255, fans a percentage, covers a position.
      const normalised = entity.levelIn === 'brightness' ? (current / 255) * 100 : current;
      return clamp(normalised + direction * stepPercent, 0, 100);
    }
    case 'volume': {
      const normalised = entity.levelIn === 'volume_level' ? current * 100 : current;
      return clamp(normalised + direction * stepPercent, 0, 100);
    }
    case 'temperature': {
      const normalised = current;
      return Math.round((normalised + direction * stepPercent) * 10) / 10;
    }
    default:
      return undefined;
  }
}

/** The step a relative request moves by, given the magnitude the model read. */
export function magnitudeStep(
  kind: ActionSpec['valueKind'],
  magnitude: string | undefined,
): number {
  const scale: Record<string, number> = { slight: 0.1, moderate: 0.25, large: 0.5, maximum: 1 };
  const fraction = scale[magnitude ?? 'moderate'] ?? 0.25;
  switch (kind) {
    case 'temperature':
      return Math.max(1, Math.round(10 * fraction));
    case 'volume_step':
      return Math.max(5, Math.round(100 * fraction * 0.5));
    default:
      return Math.max(5, Math.round(100 * fraction));
  }
}
