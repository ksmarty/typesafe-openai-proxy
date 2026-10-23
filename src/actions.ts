/**
 * How each (domain, action) pair becomes a Home Assistant intent.
 *
 * Ported from the reference implementation (custom_components/typesafe_conversation/actions.py).
 * Targeting goes through the intent handlers rather than the service layer, because
 * `intent._filter_by_name` matches an entity id passed in the `name` slot exactly,
 * so a request can be targeted deterministically *and* still get Home Assistant's
 * own argument validation and exposure check.
 */

export interface ActionSpec {
  intentType: string;
  /** Slot that carries the numeric value, when the action takes one. */
  valueSlot?: string;
  /** How to derive that value. */
  valueKind?: 'percent' | 'temperature' | 'volume' | 'volume_step';
  /** The value is a delta rather than an absolute setting. */
  relative?: boolean;
  /** The handler refuses to act on more than one entity. */
  singleTarget?: boolean;
  /** No `area` slot, so it must be given one specific entity. */
  nameOnly?: boolean;
  /** A free-text slot we can only fill from an extracted span. */
  needsText?: string;
}

export const INTENTS = {
  turnOn: 'HassTurnOn',
  turnOff: 'HassTurnOff',
  toggle: 'HassToggle',
  lightSet: 'HassLightSet',
  setPosition: 'HassSetPosition',
  stopMoving: 'HassStopMoving',
  fanSetSpeed: 'HassFanSetSpeed',
  climateSetTemperature: 'HassClimateSetTemperature',
  climateGetTemperature: 'HassClimateGetTemperature',
  getState: 'HassGetState',
  nevermind: 'HassNevermind',
  getCurrentTime: 'HassGetCurrentTime',
  getCurrentDate: 'HassGetCurrentDate',
  mediaPause: 'HassMediaPause',
  mediaUnpause: 'HassMediaUnpause',
  mediaNext: 'HassMediaNext',
  mediaPrevious: 'HassMediaPrevious',
  mediaMute: 'HassMediaPlayerMute',
  mediaUnmute: 'HassMediaPlayerUnmute',
  setVolume: 'HassSetVolume',
  setVolumeRelative: 'HassSetVolumeRelative',
  mediaSearchAndPlay: 'HassMediaSearchAndPlay',
  humidifierSetpoint: 'HassHumidifierSetpoint',
  humidifierMode: 'HassHumidifierMode',
  vacuumStart: 'HassVacuumStart',
  vacuumReturnToBase: 'HassVacuumReturnToBase',
  vacuumCleanArea: 'HassVacuumCleanArea',
  listAddItem: 'HassListAddItem',
  listCompleteItem: 'HassListCompleteItem',
  listRemoveItem: 'HassListRemoveItem',
} as const;

const POWER_DOMAINS = [
  'light',
  'switch',
  'fan',
  'climate',
  'media_player',
  'humidifier',
  'water_heater',
  'input_boolean',
] as const;

function buildActions(): Record<string, ActionSpec> {
  const table: Record<string, ActionSpec> = {};
  const put = (domain: string, action: string, spec: ActionSpec): void => {
    table[`${domain}:${action}`] = spec;
  };

  for (const domain of POWER_DOMAINS) {
    put(domain, 'turn_on', { intentType: INTENTS.turnOn });
    put(domain, 'turn_off', { intentType: INTENTS.turnOff });
  }
  for (const domain of ['light', 'switch', 'input_boolean']) {
    put(domain, 'toggle', { intentType: INTENTS.toggle });
  }

  // light
  put('light', 'set_brightness', { intentType: INTENTS.lightSet, valueSlot: 'brightness', valueKind: 'percent' });
  put('light', 'brighter', { intentType: INTENTS.lightSet, valueSlot: 'brightness', valueKind: 'percent', relative: true });
  put('light', 'dimmer', { intentType: INTENTS.lightSet, valueSlot: 'brightness', valueKind: 'percent', relative: true });
  put('light', 'set_color', { intentType: INTENTS.lightSet, needsText: 'color' });

  // cover
  put('cover', 'open', { intentType: INTENTS.turnOn });
  put('cover', 'close', { intentType: INTENTS.turnOff });
  put('cover', 'stop', { intentType: INTENTS.stopMoving });
  put('cover', 'set_position', { intentType: INTENTS.setPosition, valueSlot: 'position', valueKind: 'percent' });

  // lock
  put('lock', 'lock', { intentType: INTENTS.turnOn });
  put('lock', 'unlock', { intentType: INTENTS.turnOff });

  // fan
  put('fan', 'set_speed', { intentType: INTENTS.fanSetSpeed, valueSlot: 'percentage', valueKind: 'percent' });
  put('fan', 'faster', { intentType: INTENTS.fanSetSpeed, valueSlot: 'percentage', valueKind: 'percent', relative: true });
  put('fan', 'slower', { intentType: INTENTS.fanSetSpeed, valueSlot: 'percentage', valueKind: 'percent', relative: true });

  // climate
  put('climate', 'set_temperature', {
    intentType: INTENTS.climateSetTemperature,
    valueSlot: 'temperature',
    valueKind: 'temperature',
    singleTarget: true,
  });
  put('climate', 'warmer', {
    intentType: INTENTS.climateSetTemperature,
    valueSlot: 'temperature',
    valueKind: 'temperature',
    relative: true,
    singleTarget: true,
  });
  put('climate', 'cooler', {
    intentType: INTENTS.climateSetTemperature,
    valueSlot: 'temperature',
    valueKind: 'temperature',
    relative: true,
    singleTarget: true,
  });

  // media player
  put('media_player', 'play', { intentType: INTENTS.mediaUnpause });
  put('media_player', 'pause', { intentType: INTENTS.mediaPause });
  // Kept mapped (though no longer offered) so an answer naming it lands somewhere sane:
  // a media player is often a software endpoint with no power to cut.
  put('media_player', 'stop', { intentType: INTENTS.mediaPause });
  put('media_player', 'next', { intentType: INTENTS.mediaNext });
  put('media_player', 'previous', { intentType: INTENTS.mediaPrevious });
  put('media_player', 'mute', { intentType: INTENTS.mediaMute });
  put('media_player', 'unmute', { intentType: INTENTS.mediaUnmute });
  put('media_player', 'set_volume', { intentType: INTENTS.setVolume, valueSlot: 'volume_level', valueKind: 'volume' });
  put('media_player', 'louder', {
    intentType: INTENTS.setVolumeRelative,
    valueSlot: 'volume_step',
    valueKind: 'volume_step',
    relative: true,
  });
  put('media_player', 'quieter', {
    intentType: INTENTS.setVolumeRelative,
    valueSlot: 'volume_step',
    valueKind: 'volume_step',
    relative: true,
  });
  put('media_player', 'search_and_play', {
    intentType: INTENTS.mediaSearchAndPlay,
    needsText: 'search_query',
    singleTarget: true,
  });

  // simple trigger domains
  put('scene', 'activate', { intentType: INTENTS.turnOn });
  put('script', 'run', { intentType: INTENTS.turnOn });
  put('button', 'press', { intentType: INTENTS.turnOn });

  // vacuum
  put('vacuum', 'start', { intentType: INTENTS.vacuumStart });
  put('vacuum', 'return_to_base', { intentType: INTENTS.vacuumReturnToBase });
  put('vacuum', 'clean_area', { intentType: INTENTS.vacuumCleanArea });

  // humidifier: these handlers have no `area` slot
  put('humidifier', 'set_humidity', {
    intentType: INTENTS.humidifierSetpoint,
    valueSlot: 'humidity',
    valueKind: 'percent',
    nameOnly: true,
  });
  put('humidifier', 'set_mode', { intentType: INTENTS.humidifierMode, needsText: 'mode', nameOnly: true });

  // to-do lists: the item is free text, and the list must be named
  put('todo', 'add_item', { intentType: INTENTS.listAddItem, needsText: 'item', nameOnly: true });
  put('todo', 'complete_item', { intentType: INTENTS.listCompleteItem, needsText: 'item', nameOnly: true });
  put('todo', 'remove_item', { intentType: INTENTS.listRemoveItem, needsText: 'item', nameOnly: true });

  return table;
}

/** `${domain}:${action}` -> spec. Anything missing is not something we execute. */
export const ACTIONS: Record<string, ActionSpec> = buildActions();

export function specFor(domain: string, action: string): ActionSpec | undefined {
  return ACTIONS[`${domain}:${action}`];
}

/** Actions that move a value up rather than down; used to sign a relative step. */
export const INCREASING_ACTIONS = new Set(['brighter', 'faster', 'warmer', 'louder']);

export const RISKY_ACTIONS = new Set(['unlock', 'open', 'disarm']);
export const RISKY_DOMAINS = new Set(['lock', 'cover']);
export const RISKY_DEVICE_CLASSES = new Set(['garage', 'gate', 'door', 'window']);

/** Human-readable verbs for the speech the proxy composes itself. */
export const ACTION_VERBS: Record<string, string> = {
  turn_on: 'Turned on',
  turn_off: 'Turned off',
  toggle: 'Toggled',
  open: 'Opened',
  close: 'Closed',
  stop: 'Stopped',
  lock: 'Locked',
  unlock: 'Unlocked',
  activate: 'Activated',
  run: 'Ran',
  press: 'Pressed',
  play: 'Resumed',
  pause: 'Paused',
  next: 'Skipped ahead on',
  previous: 'Went back on',
  mute: 'Muted',
  unmute: 'Unmuted',
  start: 'Started',
  return_to_base: 'Sent back to the dock:',
  clean_area: 'Started cleaning with',
  set_brightness: 'Set the brightness of',
  brighter: 'Brightened',
  dimmer: 'Dimmed',
  set_color: 'Changed the colour of',
  set_position: 'Moved',
  set_speed: 'Set the speed of',
  faster: 'Sped up',
  slower: 'Slowed down',
  set_temperature: 'Set',
  warmer: 'Turned up',
  cooler: 'Turned down',
  set_volume: 'Set the volume of',
  louder: 'Turned up',
  quieter: 'Turned down',
  search_and_play: 'Playing that on',
  set_humidity: 'Set the humidity of',
  set_mode: 'Changed the mode of',
  add_item: 'Added that to',
  complete_item: 'Ticked that off',
  remove_item: 'Removed that from',
};

/** Domain -> human label, used for question options and clarifications. */
export const DOMAIN_LABELS: Record<string, string> = {
  light: 'Lights, lamps, bulbs, brightness or light colour.',
  switch: 'Switches and appliances on a plug: a coffee maker, kettle, heater, dishwasher or similar.',
  cover: 'Blinds, shades, curtains, shutters or awnings, and anything that opens and closes.',
  lock: 'Door locks.',
  fan: 'Fans and their speed.',
  climate: 'Thermostats, heating, cooling or air conditioning.',
  media_player: 'Speakers, TVs, music, volume or playback.',
  scene: 'Named scenes, moods or presets.',
  script: 'Named routines the user has set up.',
  vacuum: 'Robot vacuums.',
  humidifier: 'Humidifiers and dehumidifiers.',
  water_heater: 'Water heaters and boilers.',
  button: 'Buttons that are pressed to trigger something.',
  input_boolean: 'User-defined on/off toggles and flags.',
  sensor: 'Sensor readings.',
  binary_sensor: 'Sensors that report an open/closed or on/off condition.',
  number: 'Numeric settings.',
  select: 'Multi-option settings.',
  alarm_control_panel: 'Alarm systems.',
  valve: 'Valves.',
  todo: 'To-do and shopping lists.',
};

/** Per-domain action labels, ported from the reference question set. */
export const ACTION_LABELS: Record<string, Record<string, string>> = {
  light: {
    turn_on: 'Switch them on.',
    turn_off: 'Switch them off.',
    toggle: 'Flip whatever state they are in.',
    set_brightness: 'Set them to a specific brightness, or to a named colour.',
    brighter: 'Increase the brightness, with no specific level named.',
    dimmer: 'Reduce the brightness, with no specific level named.',
  },
  switch: {
    turn_on: 'Switch it on.',
    turn_off: 'Switch it off.',
    toggle: 'Flip whatever state it is in.',
  },
  cover: {
    open: 'Open, raise, lift or draw them back.',
    close: 'Close, lower, shut or draw them across.',
    stop: 'Halt them part-way through moving.',
    set_position: 'Move them to a specific degree of openness.',
  },
  lock: { lock: 'Lock them.', unlock: 'Unlock them.' },
  fan: {
    turn_on: 'Switch them on.',
    turn_off: 'Switch them off.',
    set_speed: 'Set them to a specific speed.',
    faster: 'Increase the speed, with no specific speed named.',
    slower: 'Reduce the speed, with no specific speed named.',
  },
  climate: {
    turn_on: 'Switch them on.',
    turn_off: 'Switch them off.',
    set_temperature: 'Set them to a specific target temperature.',
    warmer: 'Raise the temperature, with no specific value named.',
    cooler: 'Lower the temperature, with no specific value named.',
  },
  media_player: {
    play: 'Resume or start playback.',
    pause: 'Pause, stop or halt playback.',
    next: 'Skip to the next track or item.',
    previous: 'Go back to the previous track or item.',
    set_volume: 'Set the volume to a specific level.',
    louder: 'Raise the volume, with no specific level named.',
    quieter: 'Lower the volume, with no specific level named.',
    mute: 'Silence them without stopping playback.',
    unmute: 'Restore the sound.',
    search_and_play: 'Find and play specific content the user named - a song, artist, album, station or genre.',
  },
  scene: { activate: 'Apply the scene.' },
  script: { run: 'Run the routine.' },
  vacuum: {
    start: 'Start cleaning.',
    return_to_base: 'Send it back to its dock.',
    clean_area: 'Clean one specific room or area.',
  },
  humidifier: {
    turn_on: 'Switch them on.',
    turn_off: 'Switch them off.',
    set_humidity: 'Set them to a specific target humidity.',
    set_mode: 'Switch between their operating modes.',
  },
  water_heater: { turn_on: 'Switch it on.', turn_off: 'Switch it off.' },
  button: { press: 'Press it.' },
  input_boolean: {
    turn_on: 'Switch it on.',
    turn_off: 'Switch it off.',
    toggle: 'Flip whatever state it is in.',
  },
  todo: {
    add_item: 'Put something new on the list.',
    complete_item: 'Mark something on the list as done or bought.',
    remove_item: 'Take something off the list.',
  },
};

export function actionsForDomain(domain: string): string[] {
  return Object.keys(ACTION_LABELS[domain] ?? {});
}
