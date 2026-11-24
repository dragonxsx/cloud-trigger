import { TelemetryShape } from './config/telemetry-config.js';
import { startTelemetry } from './infra/telemetry/sdk.js';

const telemetry = TelemetryShape.safeParse(process.env);
if (telemetry.success) {
  await startTelemetry(telemetry.data).catch((error: unknown) => {
    process.emitWarning(`OpenTelemetry did not start; serving /metrics only. ${String(error)}`, {
      code: 'CLOUD_TRIGGER_TELEMETRY',
    });
  });
}
await import('./server.js');
