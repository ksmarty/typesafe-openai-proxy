import { useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import FormControlLabel from '@mui/material/FormControlLabel';
import IconButton from '@mui/material/IconButton';
import MenuItem from '@mui/material/MenuItem';
import Paper from '@mui/material/Paper';
import Slider from '@mui/material/Slider';
import Stack from '@mui/material/Stack';
import Switch from '@mui/material/Switch';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import AddIcon from '@mui/icons-material/Add';
import DeleteIcon from '@mui/icons-material/Delete';
import VisibilityIcon from '@mui/icons-material/Visibility';
import VisibilityOffIcon from '@mui/icons-material/VisibilityOff';

import type { SettingsField } from '../src/schema.js';
import { asNumber, asString, asTemplates, readPath, writePath, type Config } from './config';
import { fixed } from './format';

interface ControlProps {
  field: SettingsField;
  config: Config;
  onChange: (path: string, value: unknown) => void;
}

function PasswordField({ field, config, onChange }: ControlProps) {
  const [visible, setVisible] = useState(false);
  return (
    <TextField
      label={field.label}
      type={visible ? 'text' : 'password'}
      value={asString(readPath(config, field.key))}
      placeholder={field.placeholder}
      helperText={field.help}
      onChange={(event) => onChange(field.key, event.target.value)}
      autoComplete="off"
      slotProps={{
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

export function FieldControl(props: ControlProps) {
  const { field, config, onChange } = props;

  if (field.type === 'slider') return <SliderField {...props} />;
  if (field.type === 'templates') return <TemplateField {...props} />;

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
