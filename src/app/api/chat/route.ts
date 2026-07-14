import { convertToModelMessages, stepCountIs, streamText, type UIMessage } from 'ai';
import { openMcpClient } from '@/lib/mcp';
import { chatConfig, LlmConfigError } from '@/lib/models';

export const maxDuration = 60;

/**
 * Default system prompt. Steers the model to explore efficiently and finish
 * with a written answer instead of looping on tool calls until the step cap
 * (which it was doing — generate_sql/execute_sql churn with no prose). Override
 * the whole thing via CHAT_SYSTEM_PROMPT.
 */
const DEFAULT_SYSTEM_PROMPT = `You are a data analyst assistant with access to the user's data warehouse through Nekt tools.

To answer a data question, follow this flow and keep it tight:
1. If you need to learn what's available, call get_relevant_tables_ddl (or get_semantic_context) ONCE to see the relevant tables and columns.
2. Call generate_sql with a clear, specific natural-language question. This Nekt tool returns a correct SQL query for the warehouse — rely on it instead of hand-writing SQL. Cover several metrics in one question rather than asking many narrow ones.
3. Run the returned query with execute_sql and read the results.
Only repeat steps 2-3 if a query errored or a result clearly doesn't answer the question. Do at most 3 generate_sql/execute_sql cycles.

For a relative range like "last 30 days", anchor it to the latest date present in the table, not necessarily today.

As soon as you have data that answers the question, STOP calling tools and write your final answer. Use markdown: bold for key numbers, and a markdown table (\`| col | col |\`) whenever the answer is tabular (e.g. daily breakdowns, per-segment metrics) — do not list rows as bullet points. Briefly call out the insight, not just the numbers. Never end your turn on a tool call with no explanation. If a query failed or the data is insufficient, say so plainly and state what you found.`;

/**
 * Chat with the MCP tools available to the model.
 *
 * The browser sends the conversation plus the MCP url + token. We open a
 * fresh MCP client for this request, expose its tools to the model, stream the
 * answer back, and close the client when the stream settles.
 */
export async function POST(req: Request) {
  const {
    messages,
    url,
    token,
  }: { messages: UIMessage[]; url: string; token: string } = await req.json();

  if (!url || !token) {
    return Response.json({ error: 'Missing MCP url or token' }, { status: 400 });
  }

  // Resolve the LLM from env BEFORE opening the MCP client, so a
  // misconfigured deployment fails fast with an actionable message and never
  // touches the MCP server. See lib/models.ts for the env contract.
  let llm: ReturnType<typeof chatConfig>;
  try {
    llm = chatConfig();
  } catch (error) {
    const message =
      error instanceof LlmConfigError ? error.message : 'Invalid LLM configuration';
    console.error('LLM config error:', error);
    return Response.json({ error: message }, { status: 500 });
  }

  const mcp = await openMcpClient(url, token);
  const tools = await mcp.tools();

  const maxSteps = Number(process.env.CHAT_MAX_STEPS) || 20;

  const result = streamText({
    // Provider, model, and reasoning options all come from env, resolved in
    // lib/models.ts. streamText forwards providerOptions reasoning output as
    // reasoning parts (sendReasoning defaults true), which the UI renders.
    model: llm.model,
    system: process.env.CHAT_SYSTEM_PROMPT || DEFAULT_SYSTEM_PROMPT,
    messages: await convertToModelMessages(messages),
    tools,
    providerOptions: llm.providerOptions,
    // Allow the model to chain many tool calls before answering. A data agent
    // routinely probes semantic context → DDL → table preview → one or more
    // SQL queries, which alone is ~5 steps; a low cap (we had 5) silently halts
    // the loop mid-investigation, leaving tool calls with no final text answer.
    // Override with CHAT_MAX_STEPS as needed.
    stopWhen: stepCountIs(maxSteps),
    // Reserve the final step for the answer. stopWhen only *halts* the loop — if
    // the last step is a tool call we'd end with tool output and no prose (what
    // the user saw, finishReason 'tool-calls'). On the last allowed step
    // (stepNumber is 0-indexed, so steps run 0..maxSteps-1) we hand the model an
    // EMPTY toolset, so it literally cannot call a tool and must synthesise a
    // text answer from what it gathered. We disable tools rather than set
    // toolChoice:'none' on purpose: 'none' still ships the tool declarations
    // with mode NONE, which thinking models (gemini-3.x) can ignore and keep
    // calling tools. An empty toolset is unambiguous. Only fires at the cap; a
    // well-behaved run answers earlier and never reaches it.
    prepareStep: ({ stepNumber }) =>
      stepNumber >= maxSteps - 1 ? { activeTools: [] } : {},
    onFinish: ({ finishReason, steps, text }) => {
      // Diagnostics: if the loop ends with no prose, this tells us why — e.g.
      // finishReason 'tool-calls' at the step cap (model still wanted tools) vs.
      // 'stop' with empty text. Step count vs. maxSteps shows if the cap was hit.
      console.log(
        `chat finished: reason=${finishReason} steps=${steps.length}/${maxSteps} textLen=${text.length}`,
      );
      void mcp.close();
    },
    onError: () => {
      void mcp.close();
    },
  });

  // By default the stream masks every failure as "An error occurred.", which
  // hides real causes (e.g. a model quota 429). Surface the actual message so
  // the UI and logs are diagnosable.
  return result.toUIMessageStreamResponse({
    onError: (error) => {
      console.error('chat stream error:', error);
      if (error == null) return 'Unknown error';
      if (typeof error === 'string') return error;
      if (error instanceof Error) return error.message;
      return JSON.stringify(error);
    },
  });
}
