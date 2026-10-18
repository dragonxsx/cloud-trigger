import { type IncomingMessage, type ServerResponse, createServer } from 'node:http';

export interface RecordedRequest {
  readonly method: string | undefined;
  readonly url: string | undefined;
  readonly headers: IncomingMessage['headers'];
  readonly body: string;
}

export type TestRequestHandler = (
  request: RecordedRequest,
  response: ServerResponse,
) => void | Promise<void>;

export interface TestHttpServer {
  readonly url: string;
  readonly requests: readonly RecordedRequest[];
  readonly close: () => Promise<void>;
}

const readBody = async (req: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }

  return Buffer.concat(chunks).toString('utf8');
};

export async function startTestHttpServer(handler: TestRequestHandler): Promise<TestHttpServer> {
  const requests: RecordedRequest[] = [];
  const server = createServer((req, res) => {
    const respond = async () => {
      const body = await readBody(req);
      const recorded = { method: req.method, url: req.url, headers: req.headers, body };
      requests.push(recorded);
      await handler(recorded, res);
    };
    void respond();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Expected a TCP address');
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
