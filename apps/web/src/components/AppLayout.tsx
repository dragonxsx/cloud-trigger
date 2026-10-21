import { Box } from '@mantine/core';
import { ThemedLayoutContextProvider } from '@refinedev/mantine';
import type { MouseEvent, ReactNode } from 'react';

import { AppHeader } from './AppHeader';
import { AppSider } from './AppSider';

const skipToContent = (event: MouseEvent<HTMLAnchorElement>) => {
  const main = document.getElementById('content');
  if (!main) {
    return;
  }
  event.preventDefault();
  main.focus();
  main.scrollIntoView({ block: 'start' });
};

export function AppLayout({ children }: { children: ReactNode }) {
  return (
    <ThemedLayoutContextProvider>
      <a href="#content" className="ct-skip-link" onClick={skipToContent}>
        Skip to content
      </a>
      <Box sx={{ display: 'flex', minHeight: '100vh' }}>
        <AppSider />
        <Box sx={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 }}>
          <AppHeader />
          <Box
            component="main"
            id="content"
            tabIndex={-1}
            sx={(theme) => ({
              flex: 1,
              minWidth: 0,
              padding: theme.spacing.md,
              [theme.fn.largerThan('sm')]: { padding: theme.spacing.lg },
            })}
          >
            {children}
          </Box>
        </Box>
      </Box>
    </ThemedLayoutContextProvider>
  );
}
