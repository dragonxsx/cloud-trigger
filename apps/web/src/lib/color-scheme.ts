import { createContext, useContext } from 'react';

import { bestEffortStorage } from './storage';

export type ColorScheme = 'light' | 'dark';
export type ColorSchemePreference = 'system' | ColorScheme;

export const THEME_STORAGE_KEY = 'cloud-trigger.theme-override';

export const parseStoredScheme = (raw: string | null): ColorScheme | undefined =>
  raw === '"light"' ? 'light' : raw === '"dark"' ? 'dark' : undefined;

const systemScheme = (): ColorScheme =>
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';

export const initialColorScheme = (): ColorScheme =>
  parseStoredScheme(bestEffortStorage.get(THEME_STORAGE_KEY)) ?? systemScheme();

export const applyColorScheme = (scheme: ColorScheme): void => {
  document.documentElement.dataset['theme'] = scheme;
};

interface ColorSchemePreferenceValue {
  readonly preference: ColorSchemePreference;
  readonly setPreference: (preference: ColorSchemePreference) => void;
}

export const ColorSchemePreferenceContext = createContext<ColorSchemePreferenceValue>({
  preference: 'system',
  setPreference: () => undefined,
});

export const useColorSchemePreference = (): ColorSchemePreferenceValue =>
  useContext(ColorSchemePreferenceContext);
