import { createMCPClient } from '@ai-sdk/mcp';

/**
 * The streamable-HTTP transport opens a long-lived inbound GET SSE stream on
 * start() for server-initiated messages. Under Node's fetch (undici, HTTP/1.1)
 * that streaming GET wedges the connection pool, and every subsequent request
 * POST — including the very first `tools/list` — hangs indefinitely. (curl
 * doesn't show this because it negotiates HTTP/2 multiplexing.)
 *
 * We don't need server-initiated messages here: listing and calling tools are
 * plain request/response over POST. So we short-circuit the inbound GET with a
 * 405, which the SDK treats as "server doesn't support the inbound stream" and
 * skips — leaving the POST path, which works fine, untouched.
 */
const httpOnlyFetch: typeof fetch = (input, init) => {
  if ((init?.method ?? 'GET') === 'GET') {
    return Promise.resolve(new Response(null, { status: 405, statusText: 'Method Not Allowed' }));
  }
  return fetch(input, init);
};

/**
 * Open an MCP client over HTTP using a bearer token.
 *
 * Runs only on the server. The token is used solely to build the
 * Authorization header for the MCP server — it is never sent to the LLM
 * and never reaches the client bundle.
 */
export function openMcpClient(url: string, token: string) {
  return createMCPClient({
    transport: {
      type: 'http',
      url,
      headers: { Authorization: `Bearer ${token}` },
      fetch: httpOnlyFetch,
    },
  });
}
