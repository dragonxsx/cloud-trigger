import type { MantineThemeOverride } from '@mantine/core';
import { RefineThemes } from '@refinedev/mantine';

const signal: [string, string, string, string, string, string, string, string, string, string] = [
  '#eef3ff',
  '#dce5fd',
  '#b6c8f6',
  '#8ea9f0',
  '#6b8eea',
  '#557de7',
  '#2a5bd7',
  '#2049b8',
  '#1a3f9f',
  '#0f3286',
];

export const buildTheme = (colorScheme: 'light' | 'dark'): MantineThemeOverride => ({
  ...RefineThemes.Blue,
  colorScheme,
  colors: { signal },
  primaryColor: 'signal',
  primaryShade: { light: 6, dark: 4 },
  fontFamily: '"Hanken Grotesk Variable", system-ui, sans-serif',
  fontFamilyMonospace: '"JetBrains Mono Variable", ui-monospace, monospace',
  headings: { fontFamily: '"Hanken Grotesk Variable", system-ui, sans-serif', fontWeight: 650 },
  defaultRadius: 'sm',
  fontSizes: { xs: 12, sm: 13, md: 15, lg: 17, xl: 20 },
  globalStyles: (theme) => ({
    body: {
      background: theme.colorScheme === 'dark' ? '#10151d' : '#f5f7fa',
      color: theme.colorScheme === 'dark' ? '#e6ebf2' : '#18212f',
      fontFeatureSettings: '"tnum" 1',
    },
  }),
});
