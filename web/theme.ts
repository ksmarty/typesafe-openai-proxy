import { createTheme } from '@mui/material/styles';

const mono = 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace';

export const theme = createTheme({
  palette: {
    mode: 'dark',
    primary: { main: '#5eead4', contrastText: '#06241f' },
    secondary: { main: '#a78bfa' },
    background: { default: '#0a0f1c', paper: '#111a2b' },
    divider: 'rgba(148, 189, 209, 0.16)',
    success: { main: '#34d399' },
    warning: { main: '#fbbf24' },
    error: { main: '#f87171' },
    info: { main: '#60a5fa' },
  },
  shape: { borderRadius: 12 },
  typography: {
    fontFamily:
      'Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
    h4: { fontWeight: 700, letterSpacing: '-0.02em' },
    h5: { fontWeight: 700, letterSpacing: '-0.01em' },
    h6: { fontWeight: 650 },
    button: { textTransform: 'none', fontWeight: 600 },
    overline: { letterSpacing: '0.08em', fontWeight: 700 },
  },
  components: {
    MuiPaper: { styleOverrides: { root: { backgroundImage: 'none' } } },
    MuiButton: { defaultProps: { disableElevation: true } },
    MuiCard: {
      styleOverrides: {
        root: { border: '1px solid rgba(148, 189, 209, 0.14)', backgroundImage: 'none' },
      },
    },
    MuiAppBar: {
      styleOverrides: {
        root: { backgroundImage: 'none', backdropFilter: 'blur(8px)' },
      },
    },
    MuiChip: { defaultProps: { size: 'small' } },
    MuiTextField: { defaultProps: { size: 'small', fullWidth: true } },
    MuiTooltip: { defaultProps: { arrow: true } },
  },
});

export const monoFont = mono;
