import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { type ConnectionTestResult, defineConnection, err, ok, toError } from '@cloud-trigger/core';

import { AwsConnectionConfig, clientCache, resolveClientConfig } from './shared.js';

const stsClient = clientCache((config) => new STSClient(config));

export const awsConnection = defineConnection({
  type: 'aws',
  displayName: 'AWS account',
  description: 'Region, endpoint and credentials shared by SQS, SNS and EventBridge targets.',
  configSchema: AwsConnectionConfig,
  async test(config, { secrets, signal }): Promise<ConnectionTestResult> {
    const clientConfig = await resolveClientConfig(config, secrets);
    if (clientConfig.isErr()) {
      return err({ message: clientConfig.error.message });
    }
    try {
      const identity = await stsClient(clientConfig.value).send(new GetCallerIdentityCommand({}), {
        abortSignal: signal,
      });

      return ok({
        message: `Authenticated as ${identity.Arn ?? 'unknown'} in ${clientConfig.value.region}`,
      });
    } catch (error: unknown) {
      return err({ message: toError(error).message });
    }
  },
});
