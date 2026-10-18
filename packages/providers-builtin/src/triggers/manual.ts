import { defineTrigger } from '@cloud-trigger/core';
import { z } from 'zod';

export const manualTrigger = defineTrigger({
  type: 'manual',
  displayName: 'Manual only',
  description: 'Never fires on its own; runs only when started from the API, the UI or a workflow.',
  configSchema: z.object({}),
  nextFireAt: () => null,
  describe: () => 'Manual only',
});
