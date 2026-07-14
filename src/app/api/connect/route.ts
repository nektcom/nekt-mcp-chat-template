import { openMcpClient } from '@/lib/mcp';

export const maxDuration = 30;

/**
 * Validate an MCP URL + token and report the discovered tools.
 *
 * The "Connect" button calls this. We open the MCP client, list the tools
 * (this is the discovery step), then close the client right away — the chat
 * route opens its own short-lived client per request.
 */
export async function POST(req: Request) {
  let url: string;
  let token: string;
  try {
    ({ url, token } = await req.json());
  } catch {
    return Response.json({ ok: false, error: 'Invalid request body' }, { status: 400 });
  }

  if (!url || !token) {
    return Response.json(
      { ok: false, error: 'Both an MCP server URL and a token are required.' },
      { status: 400 },
    );
  }

  let mcp;
  try {
    mcp = await openMcpClient(url, token);
    const tools = await mcp.tools();
    return Response.json({
      ok: true,
      tools: Object.entries(tools).map(([name, tool]) => ({
        name,
        description: (tool as { description?: string }).description ?? '',
      })),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to connect to MCP server';
    return Response.json({ ok: false, error: message }, { status: 502 });
  } finally {
    await mcp?.close();
  }
}
