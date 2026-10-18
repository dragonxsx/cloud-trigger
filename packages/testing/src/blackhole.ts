import { type Socket, createServer } from 'node:net';

export interface BlackholeServer {
  readonly host: string;
  readonly port: number;
  readonly close: () => Promise<void>;
}

export async function startBlackholeServer(): Promise<BlackholeServer> {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Expected a TCP address');
  }

  return {
    host: '127.0.0.1',
    port: address.port,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) {
          socket.destroy();
        }
        server.close(() => resolve());
      }),
  };
}

export const closedPort = async (): Promise<number> => {
  const server = await startBlackholeServer();
  await server.close();

  return server.port;
};
