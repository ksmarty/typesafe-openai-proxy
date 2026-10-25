import { Component, type ErrorInfo, type ReactNode } from 'react';
import Alert from '@mui/material/Alert';
import AlertTitle from '@mui/material/AlertTitle';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
  stack?: string;
}

/**
 * React unmounts the whole tree when a render throws, which leaves a blank page — the worst
 * possible failure for a dashboard you open to find out why something is wrong. Catch it, say
 * what happened, and offer the one action that helps: reload.
 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    this.setState({ error, stack: info.componentStack ?? undefined });
    // Keep the console honest even though the UI recovered.
    console.error('dashboard crashed', error, info.componentStack);
  }

  override render(): ReactNode {
    const { error, stack } = this.state;
    if (!error) return this.props.children;
    return (
      <Box sx={{ p: { xs: 2, md: 4 }, bgcolor: 'background.default', minHeight: '100dvh' }}>
        <Stack spacing={2} sx={{ maxWidth: 760, mx: 'auto' }}>
          <Alert severity="error">
            <AlertTitle>The dashboard hit an error</AlertTitle>
            The proxy itself keeps running — `/v1/chat/completions` is unaffected. Reloading
            usually clears this.
          </Alert>
          <Typography variant="subtitle2">What happened</Typography>
          <Box
            component="pre"
            sx={{
              m: 0,
              p: 2,
              borderRadius: 2,
              bgcolor: 'background.paper',
              border: 1,
              borderColor: 'divider',
              fontSize: 12.5,
              overflow: 'auto',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            {error.message}
            {stack ? `\n${stack.trim()}` : ''}
          </Box>
          <Stack direction="row" spacing={1}>
            <Button variant="contained" onClick={() => window.location.reload()}>
              Reload
            </Button>
            <Button
              variant="outlined"
              onClick={() => {
                this.setState({ error: null, stack: undefined });
              }}
            >
              Try again
            </Button>
          </Stack>
        </Stack>
      </Box>
    );
  }
}
