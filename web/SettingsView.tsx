import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import Alert from '@mui/material/Alert';
import Accordion from '@mui/material/Accordion';
import AccordionDetails from '@mui/material/AccordionDetails';
import AccordionSummary from '@mui/material/AccordionSummary';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Divider from '@mui/material/Divider';
import IconButton from '@mui/material/IconButton';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemText from '@mui/material/ListItemText';
import MenuItem from '@mui/material/MenuItem';
import Paper from '@mui/material/Paper';
import Snackbar from '@mui/material/Snackbar';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import ToggleButton from '@mui/material/ToggleButton';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import RefreshIcon from '@mui/icons-material/Refresh';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import SaveIcon from '@mui/icons-material/Save';
import SyncIcon from '@mui/icons-material/Sync';
import TuneIcon from '@mui/icons-material/Tune';
import WaterDropIcon from '@mui/icons-material/WaterDrop';
import RouteIcon from '@mui/icons-material/Route';
import SmartToyIcon from '@mui/icons-material/SmartToy';
import HubIcon from '@mui/icons-material/Hub';
import RecordVoiceOverIcon from '@mui/icons-material/RecordVoiceOver';
import DnsIcon from '@mui/icons-material/Dns';

import {
  errorMessage,
  getConfig,
  refreshCatalog,
  getSchema,
  resetConfig,
  saveConfig,
  testDecision,
  testHa,
  testUpstream,
  type AdjustedValue,
  type TestResult,
} from './api';
import { FieldList } from './fields';
import { asString, readPath, writePath, type Config } from './config';
import { pretty } from './format';
import { monoFont } from './theme';
import type { SettingsGroup } from '../src/schema.js';

const GROUP_ICON: Record<string, ReactElement> = {
  decision: <SmartToyIcon fontSize="small" />,
  catalog: <HubIcon fontSize="small" />,
  upstream: <RouteIcon fontSize="small" />,
  speech: <RecordVoiceOverIcon fontSize="small" />,
  routing: <WaterDropIcon fontSize="small" />,
  server: <DnsIcon fontSize="small" />,
};

function describeTest(result: TestResult): string {
  if (!result.ok) return result.error ?? 'Failed.';
  const parts: string[] = [];
  if (result.entities !== undefined) parts.push(`${result.entities} entities, ${result.areas ?? 0} areas`);
  if (result.typed?.length) parts.push(`typed models: ${result.typed.join(', ')}`);
  else if (result.models?.length) parts.push(`${result.models.length} models`);
  if (result.status !== undefined) parts.push(`HTTP ${result.status}`);
  if (result.ms !== undefined) parts.push(`${result.ms} ms`);
  if (result.note) parts.push(result.note);
  return parts.length ? parts.join(' · ') : 'Reachable.';
}

export function SettingsView({
  onSaved,
  advanced,
  onAdvancedChange,
}: {
  onSaved: () => void;
  advanced: boolean;
  onAdvancedChange: (value: boolean) => void;
}) {
  const [groups, setGroups] = useState<SettingsGroup[]>([]);
  const [envOverrides, setEnvOverrides] = useState<string[]>([]);
  const [configPath, setConfigPath] = useState('');
  const [saved, setSaved] = useState<Config | null>(null);
  const [draft, setDraft] = useState<Config | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [active, setActive] = useState('decision');
  const [adjusted, setAdjusted] = useState<AdjustedValue[]>([]);
  const [restartRequired, setRestartRequired] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [catalogNote, setCatalogNote] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ group: string; result: TestResult } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [schema, current] = await Promise.all([getSchema(), getConfig()]);
      setGroups(schema.groups);
      setEnvOverrides(schema.envOverrides);
      setConfigPath(current.path ?? '');
      setSaved(current.config);
      setDraft(current.config);
      setActive((previous) => (schema.groups.some((group) => group.id === previous) ? previous : (schema.groups[0]?.id ?? 'decision')));
    } catch (problem) {
      setError(errorMessage(problem));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const dirty = useMemo(
    () => Boolean(draft && saved && JSON.stringify(draft) !== JSON.stringify(saved)),
    [draft, saved],
  );

  const group = groups.find((entry) => entry.id === active) ?? null;
  const visibleFields = useMemo(() => {
    if (!group) return [];
    return group.fields.filter((field) => advanced || !field.advanced);
  }, [group, advanced]);
  const hiddenCount = group ? group.fields.length - visibleFields.length : 0;

  const patch = useCallback((path: string, value: unknown) => {
    setDraft((current) => (current ? writePath(current, path, value) : current));
  }, []);

  const save = async (): Promise<boolean> => {
    if (!draft) return false;
    setSaving(true);
    setError(null);
    try {
      const result = await saveConfig(draft);
      setSaved(result.config);
      setDraft(result.config);
      setAdjusted(result.adjusted ?? []);
      setRestartRequired(Boolean(result.restartRequired));
      setToast('Settings saved.');
      onSaved();
      return true;
    } catch (problem) {
      setError(errorMessage(problem));
      return false;
    } finally {
      setSaving(false);
    }
  };

  const reset = async () => {
    setSaving(true);
    try {
      const result = await resetConfig();
      setSaved(result.config);
      setDraft(result.config);
      setAdjusted([]);
      setRestartRequired(false);
      setToast('Settings reset to defaults.');
      onSaved();
    } catch (problem) {
      setError(errorMessage(problem));
    } finally {
      setSaving(false);
    }
  };

  const runTest = async (groupId: string) => {
    if (!draft) return;
    setTesting(groupId);
    setTestResult(null);
    try {
      let result: TestResult;
      if (groupId === 'catalog') {
        result = await testHa(asString(readPath(draft, 'catalog.haUrl')), asString(readPath(draft, 'catalog.haToken')));
      } else if (groupId === 'decision') {
        result = await testDecision(
          asString(readPath(draft, 'decision.baseUrl')),
          asString(readPath(draft, 'decision.apiKey')),
          asString(readPath(draft, 'decision.model')),
        );
      } else {
        result = await testUpstream(asString(readPath(draft, 'upstream.baseUrl')), asString(readPath(draft, 'upstream.apiKey')));
      }
      setTestResult({ group: groupId, result });
    } catch (problem) {
      setTestResult({ group: groupId, result: { ok: false, error: errorMessage(problem) } });
    } finally {
      setTesting(null);
    }
  };

  const refreshCatalogNow = async () => {
    setRefreshing(true);
    setCatalogNote(null);
    try {
      // A token typed a moment ago is not what the server would use, so land the form first.
      if (dirty && !(await save())) return;
      const payload = await refreshCatalog();
      const info = payload.catalog;
      setCatalogNote(
        !info
          ? 'Catalog re-read.'
          : info.entities > 0
            ? `Re-read Home Assistant: ${info.entities} entities, ${info.areas} areas (${info.source}) at ${new Date(info.builtAt).toLocaleTimeString()}.`
            : `Nothing to read yet — ${info.note ?? 'no entities came back'}.`,
      );
      onSaved();
    } catch (problem) {
      setCatalogNote(`Refresh failed: ${errorMessage(problem)}`);
    } finally {
      setRefreshing(false);
    }
  };

  if (loading) {
    return (
      <Stack sx={{ alignItems: 'center',  py: 8 }}>
        <CircularProgress />
      </Stack>
    );
  }

  if (!draft || !group) {
    return (
      <Alert severity="error" action={<Button onClick={() => void load()}>Retry</Button>}>
        {error ?? 'The configuration could not be loaded.'}
      </Alert>
    );
  }

  const groupList = (
    <List dense disablePadding>
      {groups.map((entry) => (
        <ListItemButton
          key={entry.id}
          selected={entry.id === active}
          onClick={() => {
            setActive(entry.id);
            setTestResult(null);
          }}
          sx={{ borderRadius: 2, mb: 0.5 }}
        >
          <Box sx={{ mr: 1.25, display: 'flex', color: entry.id === active ? 'primary.main' : 'text.secondary' }}>
            {GROUP_ICON[entry.id] ?? <WaterDropIcon fontSize="small" />}
          </Box>
          <ListItemText
            primary={entry.title}
            slotProps={{ primary: { variant: 'body2' } }}
          />
        </ListItemButton>
      ))}
    </List>
  );

  return (
    <Box sx={{ display: 'grid', gap: 2.5, gridTemplateColumns: { xs: 'minmax(0, 1fr)', md: '236px minmax(0, 1fr)' }, alignItems: 'start' }}>
      <Paper
        variant="outlined"
        sx={{ p: 1.5, minWidth: 0, position: { md: 'sticky' }, top: { md: 96 }, display: { xs: 'none', md: 'block' } }}
      >
        {groupList}
        <Divider sx={{ my: 1.5 }} />
        <ToggleButton
          value="advanced"
          selected={advanced}
          size="small"
          fullWidth
          aria-label="Advanced settings"
          onChange={() => onAdvancedChange(!advanced)}
          sx={{
            justifyContent: 'flex-start',
            gap: 1,
            px: 1.25,
            py: 0.5,
            textTransform: 'none',
            borderColor: 'divider',
          }}
        >
          <TuneIcon fontSize="small" />
          <Typography variant="body2" component="span">
            Advanced
          </Typography>
        </ToggleButton>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1, overflowWrap: 'anywhere' }}>
          Saved to <Box component="code" sx={{ fontFamily: monoFont, fontSize: 11 }}>{configPath || 'data/config.json'}</Box>. A host or port change needs a restart; everything else applies on the next request.
        </Typography>
      </Paper>

      <Stack spacing={2} sx={{ minWidth: 0 }}>
        <Paper variant="outlined" sx={{ p: 1, minWidth: 0, display: { xs: 'block', md: 'none' } }}>
          <TextField
            select
            size="small"
            fullWidth
            label="Section"
            value={active}
            onChange={(event) => {
              setActive(event.target.value);
              setTestResult(null);
            }}
          >
            {groups.map((entry) => (
              <MenuItem key={entry.id} value={entry.id}>
                {entry.title}
              </MenuItem>
            ))}
          </TextField>
        </Paper>

        {envOverrides.length ? (
          <Alert severity="info" variant="outlined">
            Set by environment variables, so they win over anything saved here:{' '}
            <Box component="code" sx={{ fontFamily: monoFont, fontSize: 12 }}>{envOverrides.join(', ')}</Box>
          </Alert>
        ) : null}

        {error ? <Alert severity="error">{error}</Alert> : null}

        <Card>
          <CardContent>
            <Stack direction="row" spacing={1} sx={{ alignItems: 'center',  mb: 1 }}>
              <Typography variant="h6" sx={{ flex: 1 }}>
                {group.title}
              </Typography>
              {dirty ? <Chip color="warning" variant="outlined" label="unsaved" /> : null}
            </Stack>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2.5 }}>
              {group.description}
            </Typography>

            <FieldList fields={visibleFields} config={draft} onPatch={patch} />

            {hiddenCount > 0 ? (
              <Typography variant="caption" color="text.disabled" sx={{ display: 'block', mt: 2 }}>
                {hiddenCount} advanced {hiddenCount === 1 ? 'setting' : 'settings'} hidden.
              </Typography>
            ) : null}

            {group.id === 'decision' || group.id === 'catalog' || group.id === 'upstream' ? (
              <Box sx={{ mt: 2.5 }}>
                <Button
                  variant="outlined"
                  size="small"
                  disabled={testing === group.id}
                  startIcon={testing === group.id ? <CircularProgress size={14} color="inherit" /> : <SyncIcon />}
                  onClick={() => void runTest(group.id)}
                >
                  Test connection
                </Button>
                {testResult && testResult.group === group.id ? (
                  <Alert severity={testResult.result.ok ? 'success' : 'warning'} variant="outlined" sx={{ mt: 1.5 }}>
                    {describeTest(testResult.result)}
                  </Alert>
                ) : null}
              </Box>
            ) : null}

            {group.id === 'catalog' ? (
              <Box sx={{ mt: 2 }}>
                <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'center' }}>
                  <Button
                    size="small"
                    variant="contained"
                    disabled={refreshing || saving}
                    startIcon={refreshing ? <CircularProgress size={14} color="inherit" /> : <RefreshIcon fontSize="small" />}
                    onClick={() => void refreshCatalogNow()}
                  >
                    {dirty ? 'Save & refresh catalog' : 'Refresh catalog'}
                  </Button>
                  <Typography variant="caption" color="text.secondary" sx={{ minWidth: 0 }}>
                    Re-reads entities, areas and aliases from Home Assistant now instead of waiting for the{' '}
                    {Math.round(Number(readPath(draft, 'catalog.cacheMs') ?? 0) / 1000)}s cache.
                  </Typography>
                </Stack>
                {catalogNote ? (
                  <Alert
                    severity={catalogNote.startsWith('Refresh failed') ? 'warning' : 'success'}
                    variant="outlined"
                    sx={{ mt: 1.5 }}
                  >
                    {catalogNote}
                  </Alert>
                ) : null}
              </Box>
            ) : null}
          </CardContent>
        </Card>

        <Paper
          variant="outlined"
          sx={{
            position: 'sticky',
            bottom: 0,
            zIndex: 2,
            px: 1,
            py: 0.75,
            bgcolor: 'background.paper',
            boxShadow: '0 -6px 16px rgba(0, 0, 0, 0.35)',
          }}
        >
          {adjusted.length ? (
            <Alert severity="info" variant="outlined" sx={{ mb: 1, py: 0 }}>
              Adjusted to stay within range:{' '}
              {adjusted.map((entry) => `${entry.key} → ${String(entry.to)}`).join(', ')}
            </Alert>
          ) : null}
          {restartRequired ? (
            <Alert severity="warning" variant="outlined" sx={{ mb: 1, py: 0 }}>
              Restart needed before the new host or port applies.
            </Alert>
          ) : null}
          <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center' }}>
            <Typography
              variant="caption"
              color={dirty ? 'warning.main' : 'text.secondary'}
              noWrap
              sx={{ flex: 1, minWidth: 0, pl: 0.5 }}
            >
              {saving ? 'Saving…' : dirty ? 'Unsaved changes' : 'Everything saved'}
            </Typography>
            <Tooltip title="Reload from disk">
              <span>
                <IconButton size="small" aria-label="Reload settings" onClick={() => void load()} disabled={saving}>
                  <SyncIcon fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
            <Tooltip title="Reset to defaults">
              <span>
                <IconButton size="small" aria-label="Reset to defaults" onClick={() => void reset()} disabled={saving}>
                  <RestartAltIcon fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
            <Button
              size="small"
              variant="contained"
              onClick={() => void save()}
              disabled={saving || !dirty}
              startIcon={saving ? <CircularProgress size={14} color="inherit" /> : <SaveIcon fontSize="small" />}
              sx={{ minWidth: 0, px: 1.75, flexShrink: 0 }}
            >
              Save
            </Button>
          </Stack>
        </Paper>

        <Accordion disableGutters elevation={0} sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 2, '&:before': { display: 'none' } }}>
          <AccordionSummary expandIcon={<ExpandMoreIcon />}>
            <Typography variant="body2">Raw configuration</Typography>
          </AccordionSummary>
          <AccordionDetails>
            <Box
              component="pre"
              sx={{
                m: 0,
                p: 1.5,
                borderRadius: 2,
                bgcolor: 'rgba(0, 0, 0, 0.35)',
                fontFamily: monoFont,
                fontSize: 12,
                overflowX: 'auto',
                maxHeight: 420,
              }}
            >
              {pretty(draft)}
            </Box>
          </AccordionDetails>
        </Accordion>
      </Stack>

      <Snackbar open={Boolean(toast)} autoHideDuration={3000} onClose={() => setToast(null)} message={toast ?? ''} />
    </Box>
  );
}
