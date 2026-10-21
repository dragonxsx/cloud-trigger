import type { MantineThemeOverride, Tuple } from '@mantine/core';
import { RefineThemes } from '@refinedev/mantine';

type Scale = Tuple<string, 10>;

const signal: Scale = [
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

const gray: Scale = [
  '#f8f9fb',
  '#f1f3f6',
  '#e8ecf1',
  '#dce2ea',
  '#c9d1dc',
  '#a9b3c1',
  '#5f6b7e',
  '#4a5567',
  '#343d4c',
  '#1f2733',
];

const dark: Scale = [
  '#dfe5ee',
  '#b9c3d1',
  '#93a0b4',
  '#64718a',
  '#3a4658',
  '#2e3949',
  '#273141',
  '#161d27',
  '#10151d',
  '#0b0f15',
];

const focusColor = (scheme: 'light' | 'dark'): string =>
  scheme === 'dark' ? signal[3] : signal[7];

export const buildTheme = (colorScheme: 'light' | 'dark'): MantineThemeOverride => ({
  ...RefineThemes.Blue,
  colorScheme,
  colors: { signal, gray, dark },
  primaryColor: 'signal',
  primaryShade: { light: 6, dark: 7 },
  fontFamily: '"Hanken Grotesk Variable", system-ui, sans-serif',
  fontFamilyMonospace: '"JetBrains Mono Variable", ui-monospace, monospace',
  headings: { fontFamily: '"Hanken Grotesk Variable", system-ui, sans-serif', fontWeight: 650 },
  defaultRadius: 'sm',
  fontSizes: { xs: 12, sm: 13, md: 15, lg: 17, xl: 20 },
  focusRingStyles: {
    styles: (theme) => ({
      outlineOffset: 2,
      outline: `2px solid ${focusColor(theme.colorScheme)}`,
    }),
    inputStyles: (theme) => ({
      outline: 'none',
      borderColor: focusColor(theme.colorScheme),
    }),
  },
  components: {
    ...RefineThemes.Blue.components,
    InputWrapper: {
      styles: (theme) => ({
        required: {
          color: theme.colorScheme === 'dark' ? theme.colors.red[4] : theme.colors.red[8],
        },
      }),
    },
  },
  globalStyles: (theme) => ({
    body: {
      background: theme.colorScheme === 'dark' ? '#10151d' : '#f5f7fa',
      color: theme.colorScheme === 'dark' ? '#e6ebf2' : '#18212f',
      fontFeatureSettings: '"tnum" 1',
    },
  }),
});
