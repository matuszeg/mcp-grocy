/**
 * Bidirectional in-memory Transport pair for MCP Client ↔ Server tests (no sockets).
 */

import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

export function createLinkedTransports(): [Transport, Transport] {
  const clientTransport: Transport = {
    start: async () => {},
    close: async () => {},
    send: async () => {},
  };
  const serverTransport: Transport = {
    start: async () => {},
    close: async () => {},
    send: async () => {},
  };

  clientTransport.send = async (message: JSONRPCMessage) => {
    queueMicrotask(() => {
      serverTransport.onmessage?.(message);
    });
  };
  serverTransport.send = async (message: JSONRPCMessage) => {
    queueMicrotask(() => {
      clientTransport.onmessage?.(message);
    });
  };

  return [clientTransport, serverTransport];
}
