import { Command } from 'commander';
import { z } from 'zod';

import { createApiClient } from './api-client.js';
import { seedDemo } from './seed-demo.js';

const SeedOptions = z.object({ url: z.url(), target: z.url(), apiKey: z.string().min(1) });

const program = new Command('cloud-trigger-demo')
  .description('Create demo connections, groups, jobs and a workflow through the API.')
  .option('--url <url>', 'Cloud Trigger server URL', 'http://localhost:8080')
  .option('--target <url>', 'HTTP echo server the demo jobs call', 'http://localhost:8888')
  .requiredOption(
    '--api-key <key>',
    'API key with admin scope (or CLOUD_TRIGGER_API_KEY)',
    process.env['CLOUD_TRIGGER_API_KEY'],
  )
  .showHelpAfterError()
  .action(async (raw: unknown) => {
    const options = SeedOptions.parse(raw);
    const report = await seedDemo(createApiClient(options.url, { 'x-api-key': options.apiKey }), {
      targetUrl: options.target,
      serverUrl: options.url,
      now: new Date(),
    });
    for (const name of report.created) {
      process.stdout.write(`created  ${name}\n`);
    }
    for (const name of report.existing) {
      process.stdout.write(`exists   ${name}\n`);
    }
  });

program.parseAsync().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
