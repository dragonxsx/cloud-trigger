import { useEffect } from 'react';
import { useLocation } from 'react-router';

export const APP_TITLE = 'Cloud Trigger';

export const pageTitle = (...parts: readonly (string | undefined)[]): string =>
  [...parts.filter((part): part is string => part !== undefined && part !== ''), APP_TITLE].join(
    ' · ',
  );

export function usePageTitle(...parts: readonly (string | undefined)[]): void {
  const location = useLocation();
  const title = parts.some((part) => part !== undefined && part !== '')
    ? pageTitle(...parts)
    : undefined;
  const navigation = location.key;
  useEffect(() => {
    if (title !== undefined && navigation !== '') {
      document.title = title;
    }
  }, [title, navigation]);
}
