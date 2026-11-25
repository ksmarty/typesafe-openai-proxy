import { useEffect, useRef, useState } from 'react';
import Autocomplete from '@mui/material/Autocomplete';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Checkbox from '@mui/material/Checkbox';
import Chip from '@mui/material/Chip';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogTitle from '@mui/material/DialogTitle';
import Button from '@mui/material/Button';
import FormControlLabel from '@mui/material/FormControlLabel';
import IconButton from '@mui/material/IconButton';
import MenuItem from '@mui/material/MenuItem';
import Paper from '@mui/material/Paper';
import Slider from '@mui/material/Slider';
import Stack from '@mui/material/Stack';
import Switch from '@mui/material/Switch';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import useMediaQuery from '@mui/material/useMediaQuery';
import { useTheme } from '@mui/material/styles';
import AddIcon from '@mui/icons-material/Add';
import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward';
import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward';
import ContactsIcon from '@mui/icons-material/Contacts';
import DeleteIcon from '@mui/icons-material/Delete';
import KeyIcon from '@mui/icons-material/Key';
import VisibilityIcon from '@mui/icons-material/Visibility';
import VisibilityOffIcon from '@mui/icons-material/VisibilityOff';
import { monoFont } from './theme.js';

import type { SettingsField } from '../src/schema.js';
import { previewForRule } from '../src/speech.js';
import { generateToken } from '../src/token.js';
import {
  asContacts,
  asNumber,
  asRules,
  asString,
  asTemplates,
  readPath,
  writePath,
  type Config,
  type Contact,
  type SpeechRule,
  type TemplateRecord,
  type TemplateSlot,
} from './config';
import { fixed } from './format';
import {
  disconnectGoogle,
  getGoogleContacts,
  getGoogleStatus,
  startGoogleAuth,
  type GoogleStatus,
} from './api';

interface ControlProps {
  field: SettingsField;
  config: Config;
  onChange: (path: string, value: unknown) => void;
}

function PasswordField({ field, config, onChange }: ControlProps) {
  const [visible, setVisible] = useState(false);
  const [note, setNote] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);

  const generate = () => {
    const token = generateToken();
    onChange(field.key, token);
    // Show what was just made: the field is masked by default and only 12 characters of a
    // saved secret ever come back, so this is the one moment the whole token is on screen.
    setVisible(true);
    // Select it as soon as React has written the value, so Ctrl/Cmd+C works even where the
    // clipboard API is refused (an embedded frame, an insecure origin).
    setTimeout(() => inputRef.current?.select(), 0);
    const copied = 'Copied to your clipboard. Save to apply — after that only the first 12 characters stay visible.';
    const notCopied = 'Generated and selected. Copy it now — after saving only the first 12 characters stay visible.';
    const clipboard = navigator.clipboard;
    if (clipboard?.writeText) {
      clipboard.writeText(token).then(
        () => setNote(copied),
        () => setNote(notCopied),
      );
    } else {
      setNote(notCopied);
    }
  };

  const input = (
    <TextField
      label={field.label}
      type={visible ? 'text' : 'password'}
      value={asString(readPath(config, field.key))}
      placeholder={field.placeholder}
      helperText={note || field.help}
      onChange={(event) => {
        setNote('');
        onChange(field.key, event.target.value);
      }}
      autoComplete="off"
      slotProps={{
        htmlInput: { ref: inputRef },
        input: {
          endAdornment: (
            <IconButton
              size="small"
              edge="end"
              aria-label={visible ? 'Hide value' : 'Show value'}
              onClick={() => setVisible((current) => !current)}
            >
              {visible ? <VisibilityOffIcon fontSize="small" /> : <VisibilityIcon fontSize="small" />}
            </IconButton>
          ),
        },
      }}
    />
  );

  if (!field.generate) return input;

  return (
    <Box
      sx={{
        display: 'grid',
        gridTemplateColumns: { xs: 'minmax(0, 1fr)', sm: 'minmax(0, 1fr) auto' },
        alignItems: 'start',
        gap: 1,
      }}
    >
      {input}
      <Button
        variant="outlined"
        size="small"
        startIcon={<KeyIcon fontSize="small" />}
        onClick={generate}
        sx={{ minHeight: 40, whiteSpace: 'nowrap' }}
      >
        Generate
      </Button>
    </Box>
  );
}

function SliderField({ field, config, onChange }: ControlProps) {
  const value = asNumber(readPath(config, field.key), field.min ?? 0);
  return (
    <Box>
      <Stack direction="row" sx={{ alignItems: 'baseline', justifyContent: 'space-between' }}>
        <Typography variant="body2" component="label">
          {field.label}
        </Typography>
        <Typography variant="caption" sx={{ fontVariantNumeric: 'tabular-nums' }}>
          {fixed(value, 2)}
        </Typography>
      </Stack>
      <Slider
        value={value}
        min={field.min ?? 0}
        max={field.max ?? 1}
        step={field.step ?? 0.01}
        onChange={(_event, next) => onChange(field.key, next as number)}
        valueLabelDisplay="auto"
        sx={{ py: 1 }}
      />
      {field.help ? (
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
          {field.help}
        </Typography>
      ) : null}
    </Box>
  );
}

/** The slots that surround an action, in the order they are spoken. */
const ACTION_SLOTS: { slot: TemplateSlot; label: string; hint: string }[] = [
  { slot: 'done', label: 'Done', hint: '{action} and {entity}' },
  { slot: 'clarify', label: 'Clarify', hint: '{options}' },
  { slot: 'confirm', label: 'Confirm', hint: '{action} and {entity}' },
];

/**
 * The slots that answer a state question: a yes, a no, the plain state, and what to say when
 * the entity is not reporting. {state} is the word that was asked, {actual} the state itself.
 */
const STATE_SLOTS: { slot: TemplateSlot; label: string; hint: string }[] = [
  { slot: 'yes', label: 'Yes', hint: '“Yes, it’s {state}.” — {entity} and {actual} work too' },
  { slot: 'no', label: 'No', hint: '“No, it’s not {state}.”' },
  { slot: 'state', label: 'State', hint: '“The {entity} is {state}.”' },
  { slot: 'unknown', label: 'Unreadable', hint: '“I can’t read the state of the {entity} right now.”' },
];

/** The English wording a new language starts from. */
const TEMPLATE_SEED: TemplateRecord = {
  done: '{action} {entity}.',
  clarify: 'Which one did you mean: {options}?',
  confirm: 'Do you want me to {action} the {entity}?',
  yes: "Yes, it's {state}.",
  no: "No, it's not {state}.",
  state: 'The {entity} is {state}.',
  unknown: "I can't read the state of the {entity} right now.",
};

function TemplateField({ field, config, onChange }: ControlProps) {
  const templates = asTemplates(readPath(config, field.key));
  const [language, setLanguage] = useState('');
  const languages = Object.keys(templates);
  const setSlot = (lang: string, slot: TemplateSlot, value: string) => {
    const next = { ...templates, [lang]: { ...templates[lang], [slot]: value } };
    onChange(field.key, next);
  };
  const add = () => {
    const code = language.trim().toLowerCase();
    if (!code || templates[code]) return;
    onChange(field.key, { ...templates, [code]: { ...TEMPLATE_SEED } });
    setLanguage('');
  };
  const remove = (lang: string) => {
    const next = { ...templates };
    delete next[lang];
    onChange(field.key, next);
  };

  const slotFields = (lang: string, slots: Partial<TemplateRecord>, fields: typeof ACTION_SLOTS) =>
    fields.map(({ slot, label, hint }) => (
      <TextField
        key={slot}
        label={label}
        helperText={hint}
        value={asString(slots[slot])}
        multiline
        minRows={1}
        onChange={(event) => setSlot(lang, slot, event.target.value)}
      />
    ));

  return (
    <Stack spacing={1.5}>
      <Typography variant="body2" component="label">
        {field.label}
      </Typography>
      {field.help ? (
        <Typography variant="caption" color="text.secondary">
          {field.help}
        </Typography>
      ) : null}
      {languages.map((lang) => {
        const slots = templates[lang] ?? {};
        return (
          <Paper key={lang} variant="outlined" sx={{ p: 1.5 }}>
            <Stack direction="row" spacing={1} sx={{ alignItems: 'center',  mb: 1 }}>
              <Typography variant="subtitle2" sx={{ flex: 1, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                {lang}
              </Typography>
              <IconButton size="small" aria-label={`Remove ${lang}`} onClick={() => remove(lang)}>
                <DeleteIcon fontSize="small" />
              </IconButton>
            </Stack>
            <Stack spacing={1.5}>
              <Typography variant="caption" color="text.secondary" sx={{ textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                After an action
              </Typography>
              {slotFields(lang, slots, ACTION_SLOTS)}
              <Typography variant="caption" color="text.secondary" sx={{ textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                Answering a state question
              </Typography>
              {slotFields(lang, slots, STATE_SLOTS)}
            </Stack>
          </Paper>
        );
      })}
      <Stack direction="row" spacing={1} sx={{ alignItems: 'flex-start' }}>
        <TextField
          label="Add language"
          value={language}
          placeholder="de"
          onChange={(event) => setLanguage(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') add();
          }}
        />
        <Button
          onClick={add}
          startIcon={<AddIcon />}
          disabled={!language.trim() || Boolean(templates[language.trim().toLowerCase()])}
          sx={{ flexShrink: 0, minWidth: 96, height: 40 }}
        >
          Add
        </Button>
      </Stack>
    </Stack>
  );
}


/** Up, down, remove — the order controls that sit to the left of every rule. */
function RuleOrder({
  rule,
  index,
  count,
  onMove,
  onRemove,
}: {
  rule: SpeechRule;
  index: number;
  count: number;
  onMove: (direction: -1 | 1) => void;
  onRemove: () => void;
}) {
  const label = rule.match || 'this rule';
  return (
    <Stack spacing={0} sx={{ width: 36, flexShrink: 0, alignItems: 'center' }}>
      <IconButton size="small" aria-label={`Move the rule for ${label} up`} disabled={index === 0} onClick={() => onMove(-1)} sx={{ p: 0.5 }}>
        <ArrowUpwardIcon fontSize="small" />
      </IconButton>
      <IconButton
        size="small"
        aria-label={`Move the rule for ${label} down`}
        disabled={index === count - 1}
        onClick={() => onMove(1)}
        sx={{ p: 0.5 }}
      >
        <ArrowDownwardIcon fontSize="small" />
      </IconButton>
      <IconButton size="small" aria-label={`Remove the rule for ${label}`} onClick={onRemove} sx={{ p: 0.5, color: 'text.secondary' }}>
        <DeleteIcon fontSize="small" />
      </IconButton>
    </Stack>
  );
}

/** The match, then and response controls, shared by the table and the phone cards. */
function RuleFields({
  rule,
  suggestions,
  stacked,
  onMatch,
  onMode,
  onSay,
}: {
  rule: SpeechRule;
  suggestions: string[];
  stacked: boolean;
  onMatch: (value: string) => void;
  onMode: (value: SpeechRule['mode']) => void;
  onSay: (value: string) => void;
}) {
  return (
    <>
      <Autocomplete
        freeSolo
        size="small"
        options={suggestions}
        value={rule.match}
        onChange={(_event, next) => onMatch(next ?? '')}
        onInputChange={(_event, next) => onMatch(next)}
        renderInput={(params) => (
          <TextField
            {...params}
            label={stacked ? 'Match' : undefined}
            placeholder={stacked ? undefined : 'light, HassTurnOn, todo.*'}
            fullWidth
          />
        )}
        sx={{ minWidth: 0 }}
      />
      <TextField
        select
        size="small"
        label={stacked ? 'Then' : undefined}
        value={rule.mode}
        onChange={(event) => onMode(event.target.value as SpeechRule['mode'])}
        fullWidth
      >
        <MenuItem value="speak">Speak it</MenuItem>
        <MenuItem value="silent">Stay quiet</MenuItem>
        <MenuItem value="custom">Say this…</MenuItem>
      </TextField>
      {rule.mode === 'custom' || !stacked ? (
        <Stack spacing={0.5} sx={{ minWidth: 0 }}>
          <TextField
            size="small"
            label={stacked ? 'Say this' : undefined}
            value={rule.say ?? ''}
            placeholder="{action} {entity}."
            disabled={rule.mode !== 'custom'}
            onChange={(event) => onSay(event.target.value)}
            helperText={!stacked && rule.mode === 'custom' ? '{action} and {entity} are filled in' : undefined}
            fullWidth
          />
          {rule.mode === 'custom' ? (
            <Typography variant="caption" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
              Says:{' '}
              <Box component="em" sx={{ fontStyle: 'italic', color: 'text.primary' }}>
                {previewForRule(rule)}
              </Box>
            </Typography>
          ) : null}
        </Stack>
      ) : null}
    </>
  );
}

function RulesField({ field, config, onChange }: ControlProps) {
  const theme = useTheme();
  const stacked = useMediaQuery(theme.breakpoints.down('sm'));
  const rules = asRules(readPath(config, field.key));
  const suggestions = field.suggestions ?? [];
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState<number | null>(null);

  const write = (next: SpeechRule[]) => onChange(field.key, next);
  const patch = (index: number, change: Partial<SpeechRule>) => {
    const next = rules.slice();
    const current = next[index];
    if (!current) return;
    const merged = { ...current, ...change };
    // A rule that stops being custom should not carry a stale sentence around.
    if (merged.mode !== 'custom') delete merged.say;
    if (merged.mode === 'custom' && !merged.say) merged.say = '{action} {entity}.';
    next[index] = merged;
    write(next);
  };
  const move = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= rules.length) return;
    const next = rules.slice();
    const [item] = next.splice(index, 1);
    if (!item) return;
    next.splice(target, 0, item);
    write(next);
  };
  /** Picking an option from the list adds the rule immediately: no second click. */
  const add = (value: string) => {
    const match = value.trim();
    if (!match) return;
    if (!rules.some((rule) => rule.match.toLowerCase() === match.toLowerCase())) {
      write([...rules, { match, mode: 'silent' }]);
    }
    setDraft('');
  };
  const confirming = pending !== null ? rules[pending] : undefined;

  return (
    <Stack spacing={1.5}>
      <Typography variant="body2" component="label">
        {field.label}
      </Typography>
      {field.help ? (
        <Typography variant="caption" color="text.secondary">
          {field.help}
        </Typography>
      ) : null}

      {stacked
        ? rules.map((rule, index) => (
            <Paper key={`${rule.match}-${index}`} variant="outlined" sx={{ p: 1.25 }}>
              <Stack direction="row" spacing={1.25} sx={{ alignItems: 'flex-start' }}>
                <RuleOrder
                  rule={rule}
                  index={index}
                  count={rules.length}
                  onMove={(direction) => move(index, direction)}
                  onRemove={() => setPending(index)}
                />
                <Stack spacing={1.25} sx={{ flex: 1, minWidth: 0 }}>
                  <RuleFields
                    rule={rule}
                    suggestions={suggestions}
                    stacked
                    onMatch={(value) => patch(index, { match: value })}
                    onMode={(mode) => patch(index, { mode })}
                    onSay={(say) => patch(index, { say })}
                  />
                </Stack>
              </Stack>
            </Paper>
          ))
        : (
            <TableContainer component={Paper} variant="outlined">
              <Table size="small" sx={{ '& td, & th': { verticalAlign: 'top', py: 1 } }}>
                <TableHead>
                  <TableRow>
                    <TableCell sx={{ width: 48, pr: 0 }} />
                    <TableCell sx={{ width: '32%' }}>Match</TableCell>
                    <TableCell sx={{ width: 160 }}>Then</TableCell>
                    <TableCell>Response</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {rules.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={4} sx={{ color: 'text.secondary' }}>
                        No rules yet — every finished action follows the default below.
                      </TableCell>
                    </TableRow>
                  ) : null}
                  {rules.map((rule, index) => (
                    <TableRow key={`${rule.match}-${index}`}>
                      <TableCell colSpan={4} sx={{ p: 0, border: 0 }}>
                        <Box
                          sx={{
                            display: 'grid',
                            gridTemplateColumns: '48px minmax(0, 32fr) minmax(0, 21fr) minmax(0, 40fr)',
                            gap: 1,
                            alignItems: 'start',
                            pl: 1,
                            pr: 2,
                            py: 1,
                            borderTop: index === 0 ? 0 : '1px solid',
                            borderColor: 'divider',
                          }}
                        >
                          <RuleOrder
                            rule={rule}
                            index={index}
                            count={rules.length}
                            onMove={(direction) => move(index, direction)}
                            onRemove={() => setPending(index)}
                          />
                          <Box sx={{ display: 'contents' }}>
                            <RuleFields
                              rule={rule}
                              suggestions={suggestions}
                              stacked={false}
                              onMatch={(value) => patch(index, { match: value })}
                              onMode={(mode) => patch(index, { mode })}
                              onSay={(say) => patch(index, { say })}
                            />
                          </Box>
                        </Box>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          )}

      <Autocomplete
        freeSolo
        size="small"
        options={suggestions}
        inputValue={draft}
        onChange={(_event, next) => {
          // A selection, or a typed value confirmed with Enter, becomes a rule at once.
          if (typeof next === 'string') add(next);
        }}
        onInputChange={(_event, next, reason) => {
          if (reason === 'input' || reason === 'clear') setDraft(next);
        }}
        renderInput={(params) => (
          <TextField {...params} label="Add a rule" placeholder="vacuum, media_player, todo.*" />
        )}
        sx={{ maxWidth: { xs: '100%', sm: 420 } }}
      />

      <Stack
        direction="row"
        useFlexGap
        spacing={1}
        sx={{ flexWrap: 'wrap', alignItems: 'center', pt: 0.5, rowGap: 0.75 }}
      >
        <Typography variant="caption" color="text.secondary">
          Substitutions:
        </Typography>
        {[
          { token: '{action}', sample: 'Turned on' },
          { token: '{entity}', sample: 'Shopping List' },
          { token: '{item}', sample: 'Milk' },
        ].map((entry) => (
          <Chip
            key={entry.token}
            size="small"
            variant="outlined"
            label={`${entry.token} = ${entry.sample}`}
            sx={{ fontFamily: monoFont, fontSize: 11.5, maxWidth: '100%' }}
          />
        ))}
      </Stack>

      <Dialog open={pending !== null} onClose={() => setPending(null)} maxWidth="xs" fullWidth>
        <DialogTitle>Remove this rule?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            {confirming
              ? `“${confirming.match}” → ${
                  confirming.mode === 'silent'
                    ? 'stay quiet'
                    : confirming.mode === 'custom'
                      ? `say “${confirming.say ?? ''}”`
                      : 'speak it'
                }. The rules below it keep their order.`
              : ''}
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setPending(null)}>Keep it</Button>
          <Button
            color="error"
            onClick={() => {
              if (pending !== null) write(rules.filter((_rule, position) => position !== pending));
              setPending(null);
            }}
          >
            Remove
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}

/**
 * The contacts a spoken name is resolved against.
 *
 * Each row is one name and the number or address it sends to: "Sarah" → +15551234567. A name
 * resolves by the whole name first and then by its first word, so two contacts called Sarah
 * make the house ask instead of guessing — which is why the name column is the key, not the
 * address. Rows are held here while they are typed and written whole, so a row that is still
 * missing its address is not dropped between keystrokes.
 */
function ContactsField({ field, config, onChange }: ControlProps) {
  const theme = useTheme();
  const stacked = useMediaQuery(theme.breakpoints.down('sm'));
  const [rows, setRows] = useState<Contact[]>(() => asContacts(readPath(config, field.key)));
  const [pending, setPending] = useState<number | null>(null);
  const [importing, setImporting] = useState(false);
  // The switch that arms this list lives above it in the same group, and it is easy to leave
  // off while filling the list in — which looks exactly like the feature being broken.
  const off = readPath(config, 'messaging.enabled') === false;

  const write = (next: Contact[]) => {
    setRows(next);
    onChange(field.key, next);
  };
  const patch = (index: number, change: Partial<Contact>) => {
    const next = rows.slice();
    const current = next[index];
    if (!current) return;
    next[index] = { ...current, ...change };
    write(next);
  };
  const move = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= rows.length) return;
    const next = rows.slice();
    const [item] = next.splice(index, 1);
    if (!item) return;
    next.splice(target, 0, item);
    write(next);
  };
  const confirming = pending !== null ? rows[pending] : undefined;

  return (
    <Stack spacing={1.5}>
      <Typography variant="body2" component="label">
        {field.label}
      </Typography>
      {field.help ? (
        <Typography variant="caption" color="text.secondary">
          {field.help}
        </Typography>
      ) : null}

      {off ? (
        <Typography variant="caption" color="warning.main">
          Nothing will be sent: “Read message sentences here” above is switched off, so this list
          is never used.
        </Typography>
      ) : null}

      {rows.length === 0 ? (
        <Typography variant="caption" color="text.secondary">
          No contacts yet — add one so “text Sarah that I’m on my way” knows where to go.
        </Typography>
      ) : null}

      <Stack spacing={1}>
        {rows.map((contact, index) => (
          <Paper key={index} variant="outlined" sx={{ p: 1.25 }}>
            <Stack
              direction={stacked ? 'column' : 'row'}
              spacing={1.25}
              sx={{ alignItems: stacked ? 'stretch' : 'center' }}
            >
              <Stack direction="row" spacing={0.25} sx={{ alignItems: 'center', flexShrink: 0 }}>
                <IconButton
                  size="small"
                  aria-label="Move up"
                  disabled={index === 0}
                  onClick={() => move(index, -1)}
                >
                  <ArrowUpwardIcon fontSize="small" />
                </IconButton>
                <IconButton
                  size="small"
                  aria-label="Move down"
                  disabled={index === rows.length - 1}
                  onClick={() => move(index, 1)}
                >
                  <ArrowDownwardIcon fontSize="small" />
                </IconButton>
                <IconButton size="small" aria-label="Remove contact" onClick={() => setPending(index)}>
                  <DeleteIcon fontSize="small" />
                </IconButton>
              </Stack>
              <TextField
                size="small"
                label="Name"
                placeholder="Sarah"
                value={contact.name}
                onChange={(event) => patch(index, { name: event.target.value })}
                sx={{ flex: '0 0 auto', width: { xs: '100%', sm: 200 } }}
              />
              <TextField
                size="small"
                label="Phone or email"
                placeholder="+15551234567"
                value={contact.address}
                onChange={(event) => patch(index, { address: event.target.value })}
                helperText={contact.address.trim() ? undefined : 'Needed before a message can be sent.'}
                sx={{ flex: 1, minWidth: 0 }}
              />
            </Stack>
          </Paper>
        ))}
      </Stack>

      <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap' }}>
        <Button size="small" startIcon={<AddIcon />} onClick={() => write([...rows, { name: '', address: '' }])}>
          Add a contact
        </Button>
        <Button
          size="small"
          variant="outlined"
          startIcon={<ContactsIcon />}
          onClick={() => setImporting(true)}
        >
          Import from Google
        </Button>
      </Stack>

      <GoogleImportDialog
        open={importing}
        onClose={() => setImporting(false)}
        existing={rows}
        onAdd={(incoming) => {
          const have = new Set(rows.map((row) => row.address.trim().toLowerCase()).filter(Boolean));
          const next = rows.slice();
          for (const contact of incoming) {
            const key = contact.address.trim().toLowerCase();
            if (key && have.has(key)) continue;
            have.add(key);
            next.push({ name: contact.name, address: contact.address });
          }
          write(next);
        }}
      />

      <Dialog open={pending !== null} onClose={() => setPending(null)} maxWidth="xs" fullWidth>
        <DialogTitle>Remove this contact?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            {confirming
              ? `“Text ${confirming.name || 'them'} …” will be handed to the model again instead of being sent, and no message will go to ${confirming.address || 'that address'}.`
              : ''}
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setPending(null)}>Keep it</Button>
          <Button
            color="error"
            onClick={() => {
              if (pending !== null) write(rows.filter((_row, position) => position !== pending));
              setPending(null);
            }}
          >
            Remove
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}

/**
 * Picking contacts out of Google instead of typing them.
 *
 * The list is read each time the dialog opens and never kept: a contact added in Google should
 * appear here without a restart, and a stale copy in this page is one more thing that can make
 * "text Sarah" go to an address she no longer has.
 */
function GoogleImportDialog({
  open,
  onClose,
  existing,
  onAdd,
}: {
  open: boolean;
  onClose: () => void;
  existing: Contact[];
  onAdd: (rows: Contact[]) => void;
}) {
  const [status, setStatus] = useState<GoogleStatus | null>(null);
  const [contacts, setContacts] = useState<Contact[] | null>(null);
  const [chosen, setChosen] = useState<string[]>([]);
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = async (silent = false) => {
    if (!silent) setBusy(true);
    setError('');
    try {
      const next = await getGoogleStatus();
      setStatus(next);
      if (!next.connected) {
        setContacts(null);
        return;
      }
      const listed = await getGoogleContacts();
      if (!listed.ok) {
        setError(listed.error ?? 'Google refused to list the contacts.');
        setContacts([]);
        return;
      }
      setContacts(listed.contacts);
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : String(problem));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    setChosen([]);
    setFilter('');
    void load();
    // The consent tab closes itself; this one gets focus back, which is when to look again.
    const again = () => void load(true);
    window.addEventListener('focus', again);
    return () => window.removeEventListener('focus', again);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const connect = async () => {
    setBusy(true);
    setError('');
    try {
      const started = await startGoogleAuth();
      window.open(started.url, '_blank', 'noopener,noreferrer');
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : String(problem));
    } finally {
      setBusy(false);
    }
  };

  const forget = async () => {
    setBusy(true);
    setError('');
    try {
      await disconnectGoogle();
      setContacts(null);
      await load(true);
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : String(problem));
    } finally {
      setBusy(false);
    }
  };

  const known = new Set(existing.map((row) => row.address.trim().toLowerCase()).filter(Boolean));
  const needle = filter.trim().toLowerCase();
  const visible = (contacts ?? []).filter(
    (row) => !needle || `${row.name} ${row.address}`.toLowerCase().includes(needle),
  );
  const toggle = (address: string) => {
    setChosen((current) =>
      current.includes(address) ? current.filter((one) => one !== address) : [...current, address],
    );
  };
  const add = () => {
    const picked = (contacts ?? []).filter((row) => chosen.includes(row.address));
    if (picked.length > 0) onAdd(picked);
    setChosen([]);
    onClose();
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Import from Google Contacts</DialogTitle>
      <DialogContent dividers>
        <Stack spacing={1.5}>
          {error ? <Alert severity="error">{error}</Alert> : null}

          {status && !status.configured ? (
            <Alert severity="info">
              Add an OAuth client first, under Settings, Google Contacts. The client ID and secret
              come from your own Google Cloud project: Google has to trust the redirect address,
              and a client shipped with the proxy could not be trusted for yours.
            </Alert>
          ) : null}

          {status && status.configured && !status.connected ? (
            <Stack spacing={1.5}>
              <Typography variant="body2">
                Connect the Google account whose contacts you want to read. Access is read-only,
                and the connection can be removed again here.
              </Typography>
              <Typography variant="caption" color="text.secondary" sx={{ fontFamily: monoFont }}>
                redirect URI: {status.redirectUri}
              </Typography>
              <Box>
                <Button variant="outlined" size="small" onClick={() => void connect()} disabled={busy}>
                  Connect Google
                </Button>
              </Box>
            </Stack>
          ) : null}

          {busy && !contacts ? (
            <Typography variant="caption" color="text.secondary">
              Reading Google Contacts…
            </Typography>
          ) : null}

          {contacts ? (
            <>
              <TextField
                size="small"
                label="Find a contact"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                fullWidth
              />
              <Box sx={{ maxHeight: 340, overflowY: 'auto' }}>
                <Table size="small">
                  <TableBody>
                    {visible.length === 0 ? (
                      <TableRow>
                        <TableCell sx={{ border: 0 }}>
                          <Typography variant="caption" color="text.secondary">
                            {contacts.length === 0
                              ? 'That Google account has no contacts with a phone number or an email address.'
                              : 'No contact matches that.'}
                          </Typography>
                        </TableCell>
                      </TableRow>
                    ) : null}
                    {visible.map((row) => {
                      const have = known.has(row.address.trim().toLowerCase());
                      return (
                        <TableRow key={row.address} hover={!have}>
                          <TableCell padding="checkbox" sx={{ border: 0 }}>
                            <Checkbox
                              size="small"
                              disabled={have}
                              checked={chosen.includes(row.address)}
                              onChange={() => toggle(row.address)}
                              slotProps={{ input: { 'aria-label': `Import ${row.name}` } }}
                            />
                          </TableCell>
                          <TableCell sx={{ border: 0 }}>
                            <Typography variant="body2">{row.name || '(no name)'}</Typography>
                            <Typography variant="caption" color="text.secondary">
                              {row.address}
                              {have ? ' — already in this list' : ''}
                            </Typography>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </Box>
              <Box>
                <Button size="small" color="inherit" onClick={() => void forget()} disabled={busy}>
                  Disconnect
                </Button>
              </Box>
            </>
          ) : null}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" onClick={add} disabled={chosen.length === 0}>
          {chosen.length === 0 ? 'Add contacts' : `Add ${chosen.length} contact${chosen.length === 1 ? '' : 's'}`}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export function FieldControl(props: ControlProps) {
  const { field, config, onChange } = props;

  if (field.type === 'slider') return <SliderField {...props} />;
  if (field.type === 'templates') return <TemplateField {...props} />;
  if (field.type === 'rules') return <RulesField {...props} />;
  if (field.type === 'contacts') return <ContactsField {...props} />;

  if (field.type === 'checkbox') {
    return (
      <FormControlLabel
        control={
          <Switch
            checked={Boolean(readPath(config, field.key))}
            onChange={(event) => onChange(field.key, event.target.checked)}
          />
        }
        label={
          <Box>
            <Typography variant="body2">{field.label}</Typography>
            {field.help ? (
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                {field.help}
              </Typography>
            ) : null}
          </Box>
        }
      />
    );
  }

  if (field.type === 'select') {
    const value = asString(readPath(config, field.key));
    return (
      <TextField
        select
        label={field.label}
        value={value}
        helperText={field.help}
        onChange={(event) => onChange(field.key, event.target.value)}
      >
        {(field.options ?? []).map((option) => (
          <MenuItem key={option.value} value={option.value}>
            {option.label}
          </MenuItem>
        ))}
      </TextField>
    );
  }

  if (field.type === 'number') {
    return (
      <TextField
        type="number"
        label={field.label}
        value={asNumber(readPath(config, field.key), 0)}
        placeholder={field.placeholder}
        helperText={field.help}
        slotProps={{
          htmlInput: { min: field.min, max: field.max, step: field.step ?? 1 },
          input: field.unit ? { endAdornment: <Typography variant="caption" color="text.secondary">{field.unit}</Typography> } : undefined,
        }}
        onChange={(event) => {
          const parsed = Number(event.target.value);
          onChange(field.key, Number.isFinite(parsed) ? parsed : 0);
        }}
      />
    );
  }

  if (field.type === 'password') return <PasswordField {...props} />;

  return (
    <TextField
      label={field.label}
      value={asString(readPath(config, field.key))}
      placeholder={field.placeholder}
      helperText={field.help}
      onChange={(event) => onChange(field.key, event.target.value)}
    />
  );
}

export function FieldList({
  fields,
  config,
  onPatch,
}: {
  fields: SettingsField[];
  config: Config;
  onPatch: (path: string, value: unknown) => void;
}) {
  return (
    <Stack spacing={2.5}>
      {fields.map((field) => (
        <Box key={field.key}>
          <FieldControl field={field} config={config} onChange={onPatch} />
        </Box>
      ))}
    </Stack>
  );
}

export { writePath };
