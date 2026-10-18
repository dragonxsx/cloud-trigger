import type {
  Transport,
  TransportSendOptions,
} from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

type MessageHandler = NonNullable<Transport['onmessage']>;

export interface TransportLike {
  onclose?: (() => void) | undefined;
  onerror?: ((error: Error) => void) | undefined;
  onmessage?: MessageHandler | undefined;
  start(): Promise<void>;
  send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void>;
  close(): Promise<void>;
}

export class TransportBridge implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: MessageHandler;

  constructor(private readonly inner: TransportLike) {
    Object.assign(inner, {
      onclose: () => this.onclose?.(),
      onerror: (error: Error) => this.onerror?.(error),
      onmessage: ((message, extra) => this.onmessage?.(message, extra)) satisfies MessageHandler,
    });
  }

  start(): Promise<void> {
    return this.inner.start();
  }

  send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    return this.inner.send(message, options);
  }

  close(): Promise<void> {
    return this.inner.close();
  }
}
