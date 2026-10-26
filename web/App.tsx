import { useCallback, useEffect, useState } from 'react';
import AppBar from '@mui/material/AppBar';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import Container from '@mui/material/Container';
import Stack from '@mui/material/Stack';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import ToggleButton from '@mui/material/ToggleButton';
import Toolbar from '@mui/material/Toolbar';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import useMediaQuery from '@mui/material/useMediaQuery';
import { useTheme } from '@mui/material/styles';
import TuneIcon from '@mui/icons-material/Tune';

import { errorMessage, getStatus, type Status } from './api';
import { MonitorView } from './MonitorView';
import { SettingsView } from './SettingsView';
import { compact, uptime } from './format';

type View = 'monitor' | 'settings';

const VIEWS: View[] = ['monitor', 'settings'];

function initialView(): View {
  const hash = window.location.hash.replace('#', '') as View;
  return VIEWS.includes(hash) ? hash : 'monitor';
}

function HealthDot({ ok }: { ok: boolean | null }) {
  const color = ok === null ? 'warning.main' : ok ? 'success.main' : 'error.main';
  return (
    <Box
      sx={{
        width: 10,
        height: 10,
        borderRadius: '50%',
        flexShrink: 0,
        bgcolor: color,
        boxShadow: `0 0 0 4px ${ok === null ? 'rgba(251,191,36,0.15)' : ok ? 'rgba(52,211,153,0.15)' : 'rgba(248,113,113,0.15)'}`,
      }}
    />
  );
}

export function App() {
  const [view, setView] = useState<View>(initialView);
  const [status, setStatus] = useState<Status | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  // Owned here because the toggle lives in the app bar on small screens and in the
  // settings sidebar on wide ones; the form reads it either way.
  const [advanced, setAdvanced] = useState(false);
  const theme = useTheme();
  const compactHeader = useMediaQuery(theme.breakpoints.down('sm'));

  const refresh = useCallback(async () => {
    try {
      const next = await getStatus();
      setStatus(next);
      setFailure(null);
    } catch (problem) {
      setFailure(errorMessage(problem));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 4000);
    return () => clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    // A sandboxed or cross-origin iframe (the app preview) refuses history writes with a
    // SecurityError, and an uncaught throw here would blank the whole tree. The view still works
    // without the hash, so a failed write is ignored.
    try {
      if (window.location.hash.replace('#', '') !== view) {
        window.history.replaceState(null, '', `#${view}`);
      }
    } catch {
      /* hash routing is a convenience, not a requirement */
    }
  }, [view]);

  const healthy = failure ? false : status ? status.ok : null;

  return (
    <Box sx={{ minHeight: '100dvh', bgcolor: 'background.default' }}>
      <AppBar position="sticky" elevation={0} color="transparent" sx={{
          borderBottom: 1,
          borderColor: 'divider',
          bgcolor: 'rgba(10, 15, 28, 0.9)',
          backdropFilter: 'blur(12px)',
          WebkitBackdropFilter: 'blur(12px)',
        }}>
        <Toolbar sx={{ gap: 2, minHeight: { xs: 64 } }}>
          <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center',  flex: 1, minWidth: 0 }}>
            <HealthDot ok={healthy} />
            <Box sx={{ minWidth: 0 }}>
              <Typography variant="subtitle1" sx={{ fontWeight: 700, lineHeight: 1.2 }} noWrap>
                Typesafe routing proxy
              </Typography>
              <Typography
                variant="caption"
                color="text.secondary"
                noWrap
                sx={{ display: { xs: 'none', sm: 'block' } }}
              >
                A calibrated fast path in front of hass_local_openai_llm
              </Typography>
            </Box>
            <Tooltip title="The build answering. Compare it with the release you meant to run.">
              <Chip
                size="small"
                variant="outlined"
                label={`v${status?.version ?? '—'}`}
                sx={{ flexShrink: 0 }}
              />
            </Tooltip>
          </Stack>

          {view === 'settings' && compactHeader ? (
            <Tooltip title={advanced ? 'Showing advanced settings' : 'Show advanced settings'}>
              <ToggleButton
                value="advanced"
                selected={advanced}
                size="small"
                aria-label="Advanced settings"
                onChange={() => setAdvanced(!advanced)}
                sx={{ borderColor: 'divider', px: 1 }}
              >
                <TuneIcon fontSize="small" />
              </ToggleButton>
            </Tooltip>
          ) : null}

          <Stack direction="row" spacing={1} sx={{ alignItems: 'center',  display: { xs: 'none', sm: 'flex' } }}>
            <Tooltip title={status?.decision.fastPath.reason ?? 'Waiting for the server'}>
              <Chip
                variant="outlined"
                color={status?.decision.fastPath.ready ? 'primary' : 'default'}
                label={`backend: ${status?.decision.backend ?? '—'}`}
              />
            </Tooltip>
            <Chip
              variant="outlined"
              label={`catalog: ${compact(status?.catalog.entities ?? 0)}`}
              title={status?.catalog.note ?? undefined}
            />
            <Chip variant="outlined" label={`uptime: ${uptime(status?.uptimeSeconds ?? 0)}`} />

          </Stack>
        </Toolbar>
        <Tabs
          value={view}
          onChange={(_event, next: View) => setView(next)}
          variant="fullWidth"
          sx={{ px: { xs: 1, sm: 2 }, minHeight: 44, '& .MuiTab-root': { minHeight: 44 } }}
        >
          <Tab value="monitor" label="Monitor" />
          <Tab value="settings" label="Settings" />
        </Tabs>
      </AppBar>

      {failure ? (
        <Box sx={{ bgcolor: 'error.dark', color: 'error.contrastText', px: 2, py: 1, textAlign: 'center' }}>
          <Typography variant="caption">Cannot reach the proxy API: {failure}</Typography>
        </Box>
      ) : null}

      <Container maxWidth="xl" sx={{ py: { xs: 2, md: 3 }, pb: { xs: 4, md: 6 } }}>
        {view === 'monitor' ? (
          <MonitorView status={status} onRefresh={() => void refresh()} />
        ) : (
          <SettingsView
            advanced={advanced}
            onAdvancedChange={setAdvanced}
            onSaved={() => void refresh()}
          />
        )}
      </Container>
    </Box>
  );
}
