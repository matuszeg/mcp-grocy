import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import http from 'node:http';
import { GrocyMcpServer } from '../src/server/mcp-server.js';
import { startHttpServer } from '../src/server/http-server.js';

type HttpServer = http.Server;

/** Streamable HTTP transport rejects POST without both media types (SDK spec). */
const STREAMABLE_ACCEPT = 'application/json, text/event-stream';

function serverPort(s: HttpServer): number {
  const addr = s.address();
  if (!addr || typeof addr === 'string') {
    throw new Error('Expected TCP listen address');
  }
  return addr.port;
}

/** Avoids rare races where the first request runs before Express routes are fully accepting traffic. */
async function waitUntilHttpServerReady(port: number, maxMs = 3000): Promise<void> {
  const deadline = Date.now() + maxMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`);
      if (res.ok) return;
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(
    `HTTP server on port ${port} did not become ready: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
  );
}

async function closeServer(s: HttpServer): Promise<void> {
  s.closeAllConnections?.();
  await new Promise<void>((resolve, reject) => {
    s.close((err) => (err ? reject(err) : resolve()));
  });
}

describe('startHttpServer', () => {
  let grocy: GrocyMcpServer;
  let httpServer: HttpServer | undefined;

  beforeEach(async () => {
    grocy = await GrocyMcpServer.create();
  });

  afterEach(async () => {
    if (httpServer) {
      await closeServer(httpServer);
      httpServer = undefined;
    }
  });

  it('GET / returns health JSON with endpoint paths', async () => {
    httpServer = await startHttpServer(() => grocy.createMcpServer(), 0, { corsOrigin: '*' });
    const port = serverPort(httpServer);
    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.ok).toBe(true);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.status).toBe('ok');
    expect(json.endpoints).toEqual({
      streamable: '/mcp',
      sse: '/mcp/sse',
      sseMessages: '/mcp/messages',
    });
  });

  it('OPTIONS /mcp returns CORS headers for preflight', async () => {
    httpServer = await startHttpServer(() => grocy.createMcpServer(), 0, {
      corsOrigin: 'https://app.example.com',
    });
    const port = serverPort(httpServer);
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://app.example.com',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type, mcp-session-id',
      },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://app.example.com');
    expect(res.headers.get('access-control-allow-methods')).toContain('POST');
  });

  it('POST /mcp initialize returns JSON-RPC result and Mcp-Session-Id', async () => {
    httpServer = await startHttpServer(() => grocy.createMcpServer(), 0, { corsOrigin: '*' });
    const port = serverPort(httpServer);
    const body = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'vitest-http', version: '1.0.0' },
      },
    };
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        Accept: STREAMABLE_ACCEPT,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    expect(res.ok).toBe(true);
    const session = res.headers.get('mcp-session-id');
    expect(session).toBeTruthy();
    const payload = (await res.json()) as {
      result?: { protocolVersion?: string };
      error?: unknown;
    };
    expect(payload.error).toBeUndefined();
    expect(payload.result?.protocolVersion).toBe('2024-11-05');
  });

  it('POST /mcp with unknown Mcp-Session-Id returns 400', async () => {
    httpServer = await startHttpServer(() => grocy.createMcpServer(), 0, { corsOrigin: '*' });
    const port = serverPort(httpServer);
    const body = {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {},
    };
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        Accept: STREAMABLE_ACCEPT,
        'Content-Type': 'application/json',
        'Mcp-Session-Id': '00000000-0000-4000-8000-000000000000',
      },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(400);
    const err = (await res.json()) as { error?: { message?: string } };
    expect(String(err.error?.message)).toContain('Invalid or expired session ID');
  });

  it('GET /mcp/sse returns event-stream and endpoint event with sessionId', async () => {
    httpServer = await startHttpServer(() => grocy.createMcpServer(), 0, { corsOrigin: '*' });
    const port = serverPort(httpServer);
    await waitUntilHttpServerReady(port);

    const { statusCode, headers, text } = await new Promise<{
      statusCode: number;
      headers: http.IncomingHttpHeaders;
      text: string;
    }>((resolve, reject) => {
      const req = http.get(
        `http://127.0.0.1:${port}/mcp/sse`,
        { headers: { Accept: 'text/event-stream' } },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () =>
            resolve({
              statusCode: res.statusCode ?? 0,
              headers: res.headers,
              text: Buffer.concat(chunks).toString('utf8'),
            }),
          );
          res.on('error', reject);
          setTimeout(() => {
            req.destroy();
            resolve({
              statusCode: res.statusCode ?? 0,
              headers: res.headers,
              text: Buffer.concat(chunks).toString('utf8'),
            });
          }, 1500);
        },
      );
      req.on('error', reject);
    });

    expect(statusCode).toBe(200);
    expect(String(headers['content-type'])).toContain('text/event-stream');
    expect(text).toContain(': connected');
    expect(text).toContain('event: endpoint');
    expect(text).toMatch(/sessionId=[a-f0-9-]{36}/i);
    const m = text.match(/sessionId=([a-f0-9-]{36})/i);
    expect(m).toBeTruthy();
  });

  it('POST /mcp/messages without sessionId returns 400', async () => {
    httpServer = await startHttpServer(() => grocy.createMcpServer(), 0, { corsOrigin: '*' });
    const port = serverPort(httpServer);
    const res = await fetch(`http://127.0.0.1:${port}/mcp/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    });
    expect(res.status).toBe(400);
  });

  it('POST /mcp/messages with unknown sessionId returns 404', async () => {
    httpServer = await startHttpServer(() => grocy.createMcpServer(), 0, { corsOrigin: '*' });
    const port = serverPort(httpServer);
    const res = await fetch(
      `http://127.0.0.1:${port}/mcp/messages?sessionId=00000000-0000-4000-8000-000000000000`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
      },
    );
    expect(res.status).toBe(404);
  });

  it('SSE session accepts JSON-RPC via /mcp/messages after stream opens', async () => {
    httpServer = await startHttpServer(() => grocy.createMcpServer(), 0, { corsOrigin: '*' });
    const port = serverPort(httpServer);

    const sseBuf = await new Promise<string>((resolve, reject) => {
      let buf = '';
      let posted = false;
      const req = http.get(
        `http://127.0.0.1:${port}/mcp/sse`,
        { headers: { Accept: 'text/event-stream' } },
        (res) => {
          res.on('data', (c: Buffer) => {
            buf += c.toString('utf8');
            const match = buf.match(/sessionId=([a-f0-9-]{36})/i);
            if (match && !posted) {
              posted = true;
              const sessionId = match[1]!;
              const initBody = {
                jsonrpc: '2.0',
                id: 10,
                method: 'initialize',
                params: {
                  protocolVersion: '2024-11-05',
                  capabilities: {},
                  clientInfo: { name: 'vitest-sse', version: '1.0.0' },
                },
              };
              void fetch(
                `http://127.0.0.1:${port}/mcp/messages?sessionId=${encodeURIComponent(sessionId)}`,
                {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify(initBody),
                },
              )
                .then(async (postRes) => {
                  expect(postRes.status).toBe(202);
                  expect(await postRes.text()).toBe('Accepted');
                })
                .catch(reject);
            }
          });
          res.on('error', reject);
        },
      );
      req.on('error', reject);
      setTimeout(() => {
        req.destroy();
        resolve(buf);
      }, 2500);
    });

    expect(sseBuf).toMatch(/sessionId=[a-f0-9-]{36}/i);
    expect(sseBuf).toMatch(/"id"\s*:\s*10/);
    expect(sseBuf).toContain('"protocolVersion"');
    expect(sseBuf).toContain('"result"');
  });

  describe('access token gate', () => {
    const secret = 'test-ci-token-xyz';

    it('rejects /mcp without credentials when token is configured', async () => {
      httpServer = await startHttpServer(() => grocy.createMcpServer(), 0, {
        corsOrigin: '*',
        accessToken: secret,
      });
      const port = serverPort(httpServer);
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: { Accept: STREAMABLE_ACCEPT, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 't', version: '1' },
          },
        }),
      });
      expect(res.status).toBe(401);
    });

    it('allows /mcp with Authorization Bearer token', async () => {
      httpServer = await startHttpServer(() => grocy.createMcpServer(), 0, {
        corsOrigin: '*',
        accessToken: secret,
      });
      const port = serverPort(httpServer);
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: {
          Accept: STREAMABLE_ACCEPT,
          'Content-Type': 'application/json',
          Authorization: `Bearer ${secret}`,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 't', version: '1' },
          },
        }),
      });
      expect(res.ok).toBe(true);
      expect(res.headers.get('mcp-session-id')).toBeTruthy();
    });

    it('allows GET /mcp/sse with access_token query', async () => {
      httpServer = await startHttpServer(() => grocy.createMcpServer(), 0, {
        corsOrigin: '*',
        accessToken: secret,
      });
      const port = serverPort(httpServer);
      const res = await fetch(
        `http://127.0.0.1:${port}/mcp/sse?access_token=${encodeURIComponent(secret)}`,
        { headers: { Accept: 'text/event-stream' } },
      );
      expect(res.ok).toBe(true);
    });
  });
});
