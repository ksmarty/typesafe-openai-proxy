import { useRef, useState } from 'react';
import Autocomplete from '@mui/material/Autocomplete';
import Box from '@mui/material/Box';
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
import DeleteIcon from '@mui/icons-material/Delete';
import KeyIcon from '@mui/icons-material/Key';
import VisibilityIcon from '@mui/icons-material/Visibility';
import VisibilityOffIcon from '@mui/icons-material/VisibilityOff';

import type { SettingsField } from '../src/schema.js';
import { generateToken } from '../src/token.js';
import { asNumber, asRules, asString, asTemplates, readPath, writePath, type Config, type SpeechRule } from './config';
import { fixed } from './format';

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

function TemplateField({ field, config, onChange }: ControlProps) {
  const templates = asTemplates(readPath(config, field.key));
  const [language, setLanguage] = useState('');
  const languages = Object.keys(templates);
  const setSlot = (lang: string, slot: 'done' | 'clarify' | 'confirm', value: string) => {
    const next = { ...templates, [lang]: { ...templates[lang], [slot]: value } };
    onChange(field.key, next);
  };
  const add = () => {
    const code = language.trim().toLowerCase();
    if (!code || templates[code]) return;
    onChange(field.key, { ...templates, [code]: { done: '{action} {entity}.', clarify: 'Which one: {options}?', confirm: 'Do you want me to {action} the {entity}?' } });
    setLanguage('');
  };
  const remove = (lang: string) => {
    const next = { ...templates };
    delete next[lang];
    onChange(field.key, next);
  };

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
              <TextField
                label="Done"
                value={asString(slots.done)}
                multiline
                minRows={1}
                onChange={(event) => setSlot(lang, 'done', event.target.value)}
              />
              <TextField
                label="Clarify"
                value={asString(slots.clarify)}
                multiline
                minRows={1}
                onChange={(event) => setSlot(lang, 'clarify', event.target.value)}
              />
              <TextField
                label="Confirm"
                value={asString(slots.confirm)}
                multiline
                minRows={1}
                onChange={(event) => setSlot(lang, 'confirm', event.target.value)}
              />
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
  const add = () => {
    const match = draft.trim();
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

      <Stack direction="row" spacing={1} sx={{ alignItems: 'flex-start' }}>
        <Autocomplete
          freeSolo
          size="small"
          options={suggestions}
          inputValue={draft}
          onInputChange={(_event, next) => setDraft(next)}
          onChange={(_event, next) => setDraft(next ?? '')}
          renderInput={(params) => (
            <TextField
              {...params}
              label="Add a rule"
              placeholder="vacuum, media_player, todo.*"
              onKeyDown={(event) => {
                if (event.key === 'Enter') add();
              }}
            />
          )}
          sx={{ flex: 1, minWidth: 0 }}
        />
        <Button onClick={add} startIcon={<AddIcon />} disabled={!draft.trim()} sx={{ flexShrink: 0, minWidth: 96, height: 40 }}>
          Add
        </Button>
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

export function FieldControl(props: ControlProps) {
  const { field, config, onChange } = props;

  if (field.type === 'slider') return <SliderField {...props} />;
  if (field.type === 'templates') return <TemplateField {...props} />;
  if (field.type === 'rules') return <RulesField {...props} />;

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
