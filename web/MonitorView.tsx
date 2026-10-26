import { useCallback, useEffect, useMemo, useState } from 'react';
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
import FormControlLabel from '@mui/material/FormControlLabel';
import LinearProgress from '@mui/material/LinearProgress';
import Stack from '@mui/material/Stack';
import Switch from '@mui/material/Switch';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import BoltIcon from '@mui/icons-material/Bolt';
import DownloadIcon from '@mui/icons-material/Download';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';

import {
  clearTrace,
  downloadDebugBundle,
  errorMessage,
  getTrace,
  probe,
  refreshCatalog,
  resetBreaker,
  type ProbeResponse,
  type Status,
} from './api';
import { compact, fixed, ms, pretty, timeAgo } from './format';
import { monoFont } from './theme';
import type { TraceEntry } from '../src/types.js';

const SAMPLES = [
  'turn on the kitchen lights',
  'make it brighter',
  'is the back door locked',
  'how many lights are on',
  'what is the temperature in the bedroom',
  'unlock the front door',
  'set the living room lamp to 20 percent',
  'write me a poem about the sea',
];

const ROUTE_COLOR: Record<string, 'success' | 'info' | 'warning' | 'secondary' | 'default'> = {
  tool: 'success',
  clarify: 'info',
  confirm: 'warning',
  forward: 'secondary',
  text: 'default',
};

function RouteChip({ kind, label }: { kind: string; label?: string }) {
  return <Chip label={label ?? kind} color={ROUTE_COLOR[kind] ?? 'default'} variant="outlined" />;
}

function CodeBlock({ children }: { children: string }) {
  return (
    <Box
      component="pre"
      sx={{
        m: 0,
        p: 1.5,
        borderRadius: 2,
        bgcolor: 'rgba(0, 0, 0, 0.35)',
        border: '1px solid',
        borderColor: 'divider',
        fontFamily: monoFont,
        fontSize: 12,
        lineHeight: 1.55,
        overflowX: 'auto',
        maxWidth: '100%',
      }}
    >
      {children}
    </Box>
  );
}

/** A value that may be longer than the row: it scrolls sideways instead of overflowing. */
function ScrollLine({ children }: { children: string }) {
  return (
    <Box
      sx={{
        mt: 0.5,
        px: 1,
        py: 0.5,
        borderRadius: 1,
        border: '1px solid',
        borderColor: 'divider',
        bgcolor: 'rgba(0, 0, 0, 0.28)',
        fontFamily: monoFont,
        fontSize: 12,
        lineHeight: 1.45,
        whiteSpace: 'nowrap',
        overflowX: 'auto',
        overflowY: 'hidden',
        scrollbarWidth: 'thin',
      }}
    >
      {children}
    </Box>
  );
}

function Gates({ gates }: { gates: TraceEntry['gates'] }) {
  if (!gates.length) return <Typography variant="body2" color="text.secondary">No gates reached.</Typography>;
  return (
    <Stack spacing={1}>
      {gates.map((gate, index) => {
        const value = gate.confidence ?? gate.probability ?? 0;
        return (
          <Box key={`${gate.question}-${index}`}>
            <Stack direction="row" spacing={1} sx={{ alignItems: 'baseline', justifyContent: 'space-between', minWidth: 0 }}>
              <Typography
                variant="caption"
                sx={{ fontFamily: monoFont, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
              >
                {gate.question}
              </Typography>
              <Typography
                variant="caption"
                sx={{ flex: '0 0 auto' }}
                color={gate.passed ? 'success.main' : 'text.disabled'}
              >
                {fixed(value)}
                {gate.threshold !== undefined ? ` / ${fixed(gate.threshold)}` : ''} {gate.passed ? '✓' : '✗'}
              </Typography>
            </Stack>
            {gate.choice ? <ScrollLine>{gate.choice}</ScrollLine> : null}
            <LinearProgress
              variant="determinate"
              value={Math.min(100, Math.max(0, value * 100))}
              color={gate.passed ? 'success' : 'inherit'}
              sx={{ height: 5, borderRadius: 3, mt: 0.5 }}
            />
          </Box>
        );
      })}
    </Stack>
  );
}

type Plan = ProbeResponse['route']['plan'];

/**
 * What Home Assistant would actually be asked to do.
 *
 * A decision test is only useful if it shows the call — intent name and slots —
 * or says plainly that no call is made (and why).
 */
/** A plan that sends several calls, whether one action across targets or a split sentence. */
function callsOf(plan: unknown): { tool: string; args: unknown }[] {
  const record = (plan ?? {}) as { kind?: unknown; calls?: unknown; tool?: unknown; args?: unknown; pending?: unknown };
  if (record.kind === 'calls' && Array.isArray(record.calls)) {
    return record.calls.map((call) => {
      const entry = (call ?? {}) as { tool?: unknown; args?: unknown };
      return { tool: String(entry.tool ?? ''), args: entry.args ?? {} };
    });
  }
  if (record.kind === 'confirm' && record.pending) return callsOf(record.pending);
  if (record.kind === 'tool') return [{ tool: String(record.tool ?? ''), args: record.args ?? {} }];
  return [];
}

function CallPanel({ plan }: { plan: Plan }) {
  const kind = String(plan.kind ?? '');
  const text = typeof plan.text === 'string' ? plan.text : '';
  const calls = callsOf(plan);
  let heading = 'No Home Assistant call';
  let body = '';

  if (kind === 'calls') {
    heading = `${calls.length} Home Assistant calls, in this order`;
    body = calls.map((call, index) => `${index + 1}. ${call.tool} ${pretty(call.args)}`).join('\n');
  } else if (kind === 'tool') {
    heading = 'Home Assistant call';
    body = `${String(plan.tool)} ${pretty(plan.args ?? {})}`;
  } else if (kind === 'confirm') {
    heading =
      calls.length > 1 ? `Home Assistant calls — after you confirm` : 'Home Assistant call — after you confirm';
    body =
      calls.length === 0 ? text : calls.map((call, index) => `${calls.length > 1 ? `${index + 1}. ` : ''}${call.tool} ${pretty(call.args)}`).join('\n');
  } else if (kind === 'clarify') {
    heading = 'No call yet — it asks which one';
    body = text;
  } else if (kind === 'forward') {
    heading = 'No call — forwarded to your model server';
    body = String(plan.reason ?? '');
  } else if (kind === 'text') {
    heading = 'No call — answered by the proxy';
    body = text;
  } else if (kind) {
    heading = `No call — ${kind}`;
  }

  return (
    <Box sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 2, p: 1.5, minWidth: 0 }}>
      <Typography variant="overline" color="text.secondary" component="div" sx={{ display: 'block', mb: 0.5 }}>
        {heading}
      </Typography>
      {body ? <CodeBlock>{body}</CodeBlock> : null}
    </Box>
  );
}

function ProbeResult({ result }: { result: ProbeResponse }) {
  const { route, trace } = result;
  return (
    <Stack spacing={2} sx={{ mt: 2 }}>
      <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
        <RouteChip kind={route.plan.kind} />
        <Typography variant="body2" sx={{ flex: 1, minWidth: 200 }}>
          {route.reason}
        </Typography>
        <Chip variant="outlined" label={`${ms(trace.decisionMs)} decide`} />
        <Chip variant="outlined" label={result.probeBackend} />
      </Stack>

      <CallPanel plan={route.plan} />

      <Box>
        <Typography variant="overline" color="text.secondary">Gates</Typography>
        <Gates gates={route.gates} />
      </Box>
    </Stack>
  );
}

function StatTile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Box
      sx={{
        p: 1.5,
        borderRadius: 2,
        border: '1px solid',
        borderColor: 'divider',
        bgcolor: 'rgba(255, 255, 255, 0.02)',
        minWidth: 0,
      }}
    >
      <Typography
        variant="caption"
        color="text.secondary"
        sx={{ display: 'block', lineHeight: 1.25, overflowWrap: 'anywhere' }}
      >
        {label}
      </Typography>
      <Typography variant="h6" sx={{ lineHeight: 1.3 }} noWrap>
        {value}
      </Typography>
      {hint ? (
        <Typography
          variant="caption"
          color="text.disabled"
          sx={{ display: 'block', lineHeight: 1.25, overflowWrap: 'anywhere' }}
        >
          {hint}
        </Typography>
      ) : null}
    </Box>
  );
}

function TraceRow({ entry }: { entry: TraceEntry }) {
  const tool = entry.tool ? `${entry.tool} ${pretty(entry.args ?? {})}` : null;
  const callLines = (entry.calls ?? []).map((call, index) => `${index + 1}. ${call.tool} ${pretty(call.args ?? {})}`);
  return (
    <Accordion disableGutters elevation={0} sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 2, '&:before': { display: 'none' }, mb: 1 }}>
      <AccordionSummary expandIcon={<ExpandMoreIcon />} sx={{ px: 2 }}>
        <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center',  width: '100%', minWidth: 0 }}>
          <RouteChip kind={entry.route} />
          <Typography variant="body2" sx={{ flex: 1, minWidth: 0 }} noWrap>
            {entry.utterance || '(empty)'}
          </Typography>
          <Typography variant="caption" color="text.secondary" sx={{ display: { xs: 'none', sm: 'block' } }}>
            {ms(entry.decisionMs)}
          </Typography>
          <Typography variant="caption" color="text.disabled" sx={{ display: { xs: 'none', md: 'block' }, minWidth: 62, textAlign: 'right' }}>
            {timeAgo(entry.at)}
          </Typography>
        </Stack>
      </AccordionSummary>
      <AccordionDetails sx={{ px: 2, pt: 0 }}>
        <Stack spacing={1.5}>
          <Typography variant="body2" color="text.secondary">{entry.reason}</Typography>
          <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
            {entry.category ? <Chip label={entry.category} variant="outlined" /> : null}
            {entry.action ? <Chip label={entry.action} variant="outlined" /> : null}
            {entry.target ? <Chip label={entry.target} variant="outlined" /> : null}
            {entry.backend ? <Chip label={entry.backend} variant="outlined" /> : null}
            {entry.model ? <Chip label={entry.model} variant="outlined" /> : null}
            {entry.inputTokens ? <Chip label={`${compact(entry.inputTokens)} tokens`} variant="outlined" /> : null}
            {entry.entities ? <Chip label={`${entry.entities} entities`} variant="outlined" /> : null}
            {entry.toolsOffered ? (
              entry.toolsOffered.length ? (
                <Chip label={`${entry.toolsOffered.length} tools offered`} variant="outlined" />
              ) : (
                <Chip label="no tools offered" color="warning" variant="outlined" />
              )
            ) : null}
            {entry.totalMs ? <Chip label={`${ms(entry.totalMs)} total`} variant="outlined" /> : null}
          </Stack>
          {tool ? <CodeBlock>{tool}</CodeBlock> : null}
          {callLines.length ? (
            <Box>
              <Typography variant="overline" color="text.secondary">
                {callLines.length} calls
              </Typography>
              <CodeBlock>{callLines.join('\n')}</CodeBlock>
            </Box>
          ) : null}
          {entry.toolsOffered ? (
            <Box>
              <Typography variant="overline" color="text.secondary">
                {entry.toolsOffered.length ? 'Tools the request offered' : 'Tools the request offered — none'}
              </Typography>
              {entry.toolsOffered.length ? (
                <ScrollLine>{entry.toolsOffered.join(', ')}</ScrollLine>
              ) : (
                <Typography variant="body2" color="text.secondary">
                  Home Assistant sent no intent schemas with this request, so nothing could be called
                  and it went straight to your model server.
                </Typography>
              )}
            </Box>
          ) : null}
          {entry.clarification ? <Alert severity="info" variant="outlined">{entry.clarification}</Alert> : null}
          {entry.error ? <Alert severity="error" variant="outlined">{entry.error}</Alert> : null}
          {entry.gates.length ? (
            <Box>
              <Typography variant="overline" color="text.secondary">Gates</Typography>
              <Gates gates={entry.gates} />
            </Box>
          ) : null}
          {entry.toolResult !== undefined ? (
            <Box>
              <Typography variant="overline" color="text.secondary">Tool result</Typography>
              <CodeBlock>{pretty(entry.toolResult)}</CodeBlock>
            </Box>
          ) : null}
        </Stack>
      </AccordionDetails>
    </Accordion>
  );
}

export function MonitorView({ status, onRefresh }: { status: Status | null; onRefresh: () => void }) {
  const [text, setText] = useState('turn on the kitchen lights');
  const [result, setResult] = useState<ProbeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [entries, setEntries] = useState<TraceEntry[]>([]);
  const [live, setLive] = useState(true);
  const [note, setNote] = useState<string | null>(null);

  const run = useCallback(async () => {
    const value = text.trim();
    if (!value) return;
    setBusy(true);
    setError(null);
    try {
      setResult(await probe(value));
      onRefresh();
    } catch (problem) {
      setError(errorMessage(problem));
    } finally {
      setBusy(false);
    }
  }, [text, onRefresh]);

  const loadTrace = useCallback(async () => {
    try {
      const payload = await getTrace(50);
      setEntries(payload.items);
    } catch {
      /* the status poll reports connectivity problems already */
    }
  }, []);

  useEffect(() => {
    void loadTrace();
    if (!live) return;
    const timer = setInterval(() => void loadTrace(), 2500);
    return () => clearInterval(timer);
  }, [live, loadTrace]);

  const tiles = useMemo(() => {
    const stats = status?.stats ?? {};
    return [
      { label: 'requests', value: compact(stats.requests as number | undefined) },
      { label: 'tool calls', value: compact(stats.toolCalls as number | undefined) },
      { label: 'forwarded', value: compact(stats.forwarded as number | undefined) },
      { label: 'passed through', value: compact(stats.bypassed as number | undefined) },
      { label: 'clarified', value: compact(stats.clarifications as number | undefined) },
      { label: 'confirmed', value: compact(stats.confirmations as number | undefined) },
      { label: 'errors', value: compact(stats.errors as number | undefined) },
      { label: 'average decision', value: ms(status?.decision.averageMs) },
    ];
  }, [status]);

  const breaker = status?.decision.breaker;

  return (
    <Stack spacing={2.5}>
      <Stack direction={{ xs: 'column', lg: 'row' }} spacing={2.5} sx={{ alignItems: 'stretch' }}>
        <Card sx={{ flex: { lg: '1 1 60%' } }}>
          <CardContent>
            <Typography variant="h6" gutterBottom>
              Try a request
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              Runs the full decision path without executing anything. Same gates as a real turn.
            </Typography>
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
              <TextField
                value={text}
                onChange={(event) => setText(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void run();
                }}
                placeholder="turn on the kitchen lights"
                slotProps={{ htmlInput: { 'aria-label': 'Request to decide' } }}
              />
              <Button
                variant="contained"
                onClick={() => void run()}
                disabled={busy || !text.trim()}
                startIcon={busy ? <CircularProgress size={16} color="inherit" /> : <PlayArrowIcon />}
                sx={{ flexShrink: 0, minWidth: 132 }}
              >
                Decide
              </Button>
            </Stack>
            <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap',  mt: 1.5 }}>
              {SAMPLES.map((sample) => (
                <Chip
                  key={sample}
                  label={sample}
                  variant="outlined"
                  onClick={() => {
                    setText(sample);
                    setNote(null);
                  }}
                  sx={{ height: 'auto', py: 0.5, '& .MuiChip-label': { whiteSpace: 'normal', fontSize: 12 } }}
                />
              ))}
            </Stack>
            {error ? (
              <Alert severity="error" sx={{ mt: 2 }}>
                {error}
              </Alert>
            ) : null}
            {result ? <ProbeResult result={result} /> : null}
          </CardContent>
        </Card>

        <Card sx={{ flex: { lg: '1 1 40%' } }}>
          <CardContent>
            <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between',  mb: 2 }}>
              <Typography variant="h6">Since start</Typography>
              <Chip
                variant="outlined"
                label={status?.decision.fastPath.ready ? 'fast path ready' : 'forwarding only'}
                color={status?.decision.fastPath.ready ? 'success' : 'default'}
              />
            </Stack>
            <Box sx={{ display: 'grid', gap: 1, gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))' }}>
              {tiles.map((tile) => (
                <StatTile key={tile.label} label={tile.label} value={tile.value} />
              ))}
            </Box>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 2 }}>
              {status?.decision.fastPath.reason ?? 'Waiting for the server…'}
            </Typography>
            {breaker?.open ? (
              <Alert
                severity="warning"
                sx={{ mt: 2 }}
                action={
                  <Button
                    color="inherit"
                    size="small"
                    onClick={async () => {
                      await resetBreaker();
                      onRefresh();
                    }}
                  >
                    Reset
                  </Button>
                }
              >
                Circuit breaker open — {breaker.failures} failures. Requests are being forwarded.
              </Alert>
            ) : null}
            <Divider sx={{ my: 2 }} />
            <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
              <Button
                size="small"
                variant="outlined"
                onClick={async () => {
                  setNote(null);
                  try {
                    const payload = await refreshCatalog();
                    const catalog = (payload as unknown as { catalog?: { entities?: number } }).catalog;
                    setNote(`Catalog refreshed: ${catalog?.entities ?? 0} entities.`);
                    onRefresh();
                  } catch (problem) {
                    setNote(`Catalog refresh failed: ${errorMessage(problem)}`);
                  }
                }}
              >
                Refresh catalog
              </Button>
              <Button
                size="small"
                variant="text"
                onClick={async () => {
                  await clearTrace();
                  void loadTrace();
                  onRefresh();
                }}
              >
                Clear decisions
              </Button>
              <Button
                size="small"
                variant="text"
                startIcon={<DownloadIcon />}
                onClick={async () => {
                  try {
                    const name = await downloadDebugBundle();
                    setNote(`Debug bundle saved as ${name}`);
                  } catch (error) {
                    setNote(`Export failed: ${errorMessage(error)}`);
                  }
                }}
              >
                Export debug logs
              </Button>
            </Stack>
            {note ? (
              <Alert severity={note.includes('failed') ? 'error' : 'success'} sx={{ mt: 1.5 }}>
                {note}
              </Alert>
            ) : null}
            {status?.catalog.note ? (
              <Typography variant="caption" color="text.disabled" sx={{ display: 'block', mt: 1 }}>
                {status.catalog.note}
              </Typography>
            ) : null}
          </CardContent>
        </Card>
      </Stack>

      <Card>
        <CardContent>
          <Stack direction="row" spacing={2} sx={{ alignItems: 'center',  mb: 2 }}>
            <BoltIcon fontSize="small" color="primary" />
            <Typography variant="h6" sx={{ flex: 1 }}>
              Decisions
            </Typography>
            <FormControlLabel
              control={<Switch checked={live} onChange={(event) => setLive(event.target.checked)} />}
              label="live"
              slotProps={{ typography: { variant: 'body2' } }}
            />
          </Stack>
          {entries.length === 0 ? (
            <Typography variant="body2" color="text.secondary">
              No turns yet. Send something to Home Assistant, or try a request above.
            </Typography>
          ) : (
            entries.map((entry) => <TraceRow key={entry.id} entry={entry} />)
          )}
        </CardContent>
      </Card>
    </Stack>
  );
}
