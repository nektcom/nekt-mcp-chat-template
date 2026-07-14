'use client';

import { useChat } from '@ai-sdk/react';
import type { UIMessage } from 'ai';
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

type Session = { id: string; messages: UIMessage[] };

/**
 * First ~80 chars of the first user message — the host uses this as the
 * session title in its list.
 */
function deriveTitle(messages: UIMessage[]): string {
  const firstUser = messages.find((m) => m.role === 'user');
  const text = firstUser?.parts
    .map((p) => (p.type === 'text' ? p.text : ''))
    .join(' ')
    .trim();
  if (!text) return 'New chat';
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}

/**
 * Stream errors can carry an upstream gateway's raw HTML error page (e.g. an
 * ngrok ERR_NGROK_3004 when the dev server is down or mid-recompile). Don't dump
 * that wall of markup into the chat — show a concise, friendly line instead.
 */
function friendlyError(message?: string): string {
  const m = (message ?? '').trim();
  if (!m) return 'Something went wrong. Please try again.';
  if (m.startsWith('<') || /<!doctype|<html/i.test(m)) {
    return 'The assistant is temporarily unavailable. Please try again in a moment.';
  }
  return m.length > 300 ? `${m.slice(0, 300)}…` : m;
}

/**
 * Rotating status lines shown (shimmering) while the agent is working — the
 * reasoning text streams too fast to register, and during tool calls there's no
 * text at all, so this keeps the "something is happening" signal alive. Swap
 * these freely; keep them short.
 */
const THINKING_PHRASES = [
  'Thinking…',
  'Analyzing your data…',
  'Querying your tables…',
  'Processing the information…',
  'Organizing the results…',
  'Cross-checking the information…',
  'Fetching the numbers…',
  'Interpreting your question…',
  'Building the query…',
  'Reviewing the results…',
  'Connecting the dots…',
  'Digging through the data…',
  'Calculating the metrics…',
  'Summarizing the findings…',
  'Verifying the details…',
  'Preparing the answer…',
  'Filtering what matters…',
  'Double-checking the totals…',
  'Structuring the analysis…',
  'Gathering the context…',
  'Adding the finishing touches…',
  'Almost there…',
];

/**
 * Shimmering status line that cycles through THINKING_PHRASES every few seconds.
 * Rendered only while the chat is busy, so the interval lives exactly as long as
 * the agent is working (and resets to the first phrase on each new turn).
 */
function ThinkingIndicator() {
  const [idx, setIdx] = useState(0);
  useEffect(() => {
    const id = setInterval(
      () => setIdx((i) => (i + 1) % THINKING_PHRASES.length),
      4500,
    );
    return () => clearInterval(id);
  }, []);
  return (
    <div className="thinking-shimmer text-sm italic" aria-live="polite">
      {THINKING_PHRASES[idx]}
    </div>
  );
}

/**
 * Origins allowed to inject MCP credentials when this app runs inside an
 * <iframe>. Comma-separated, e.g. "https://app.lovable.app,https://lovable.dev".
 * Inlined at build time (NEXT_PUBLIC_). A message from any other origin is
 * ignored, so a hostile parent frame can neither inject nor probe credentials.
 */
const ALLOWED_PARENT_ORIGINS = (process.env.NEXT_PUBLIC_ALLOWED_PARENT_ORIGINS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// Whether we're rendered inside an <iframe>. Read via useSyncExternalStore so
// the server (and first hydration render) sees `null` — framing unknown — and
// the client resolves it to a boolean without a hydration mismatch. Framing
// never changes after load, so the subscription is a no-op.
const subscribeFraming = () => () => {};
const getFramingSnapshot = (): boolean => window.self !== window.top;
const getFramingServerSnapshot = (): boolean | null => null;

export default function Home() {
  // Connection state — token lives only here, for this browser session.
  // Pre-filled from NEXT_PUBLIC_ env vars when present. These are inlined as
  // literals at build time, so server and client render identical initial
  // values (no hydration mismatch).
  const [url, setUrl] = useState(process.env.NEXT_PUBLIC_MCP_SERVER_URL ?? '');
  const [token, setToken] = useState(process.env.NEXT_PUBLIC_MCP_TOKEN ?? '');
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // null for one render tick (server + first hydration), then the resolved
  // boolean. Avoids flashing the manual form before we know we're in an iframe.
  const embedded = useSyncExternalStore(
    subscribeFraming,
    getFramingSnapshot,
    getFramingServerSnapshot,
  );

  // The conversation currently shown. Its `id` is the persisted session id and
  // is used as <Chat>'s key, so opening another session remounts the chat with
  // fresh history. `null` until we either start a blank one or the host restores
  // one. Created lazily once connected (see effect below).
  const [session, setSession] = useState<Session | null>(null);
  // The verified parent origin (captured from the first trusted message). We
  // post session updates back to exactly this origin rather than '*'.
  const [hostOrigin, setHostOrigin] = useState<string | null>(null);

  // The single source of connection truth — used by both the manual form and
  // the postMessage path. Takes the values explicitly rather than reading state
  // so the message handler doesn't race React's async setState.
  const connect = useCallback(async (connUrl: string, connToken: string) => {
    setConnecting(true);
    setError(null);
    try {
      const res = await fetch('/api/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: connUrl, token: connToken }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setError(data.error ?? 'Could not connect to the MCP server.');
        return;
      }
      setConnected(true);
      // Ensure there's always a conversation to type into. If the host restored
      // one via mcp-restore-session (before or after this), that wins — we only
      // fill a blank when none exists. Created here, on the connect event,
      // rather than in an effect (which would be a sync setState-in-effect).
      setSession((prev) => prev ?? { id: crypto.randomUUID(), messages: [] });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error');
    } finally {
      setConnecting(false);
    }
  }, []);

  function handleConnect(e: React.FormEvent) {
    e.preventDefault();
    void connect(url, token);
  }

  // When embedded, accept MCP credentials from a whitelisted parent window via
  // postMessage and connect automatically — the user never sees the form.
  useEffect(() => {
    if (!embedded) return;

    function onMessage(event: MessageEvent) {
      // Only look at our own messages; ignore React DevTools / Next HMR / noise.
      const type = event.data?.type;
      if (
        type !== 'mcp-credentials' &&
        type !== 'mcp-restore-session' &&
        type !== 'mcp-new-session'
      ) {
        return;
      }
      // Trust messages only from a configured parent origin. Without this, any
      // site that frames us (or a nested hostile frame) could inject creds or
      // overwrite the open conversation.
      if (!ALLOWED_PARENT_ORIGINS.includes(event.origin)) {
        console.warn(
          '[mcp-chat] IGNORED: origin not whitelisted. Add it to NEXT_PUBLIC_ALLOWED_PARENT_ORIGINS.',
          { received: event.origin, allowed: ALLOWED_PARENT_ORIGINS },
        );
        return;
      }
      setHostOrigin(event.origin);

      // Open / switch to a saved session: replace the conversation with its
      // stored history. The remount (key={session.id}) gives the chat hook a
      // clean slate seeded with these messages.
      if (type === 'mcp-restore-session') {
        const { sessionId, messages } = event.data;
        if (typeof sessionId !== 'string' || !sessionId) {
          console.warn('[mcp-chat] IGNORED restore: missing sessionId', event.data);
          return;
        }
        setSession({ id: sessionId, messages: Array.isArray(messages) ? messages : [] });
        return;
      }

      // Start a brand-new, empty conversation. We mint the id; the host learns
      // it from the first `mcp-session-updated` we send back.
      if (type === 'mcp-new-session') {
        setSession({ id: crypto.randomUUID(), messages: [] });
        return;
      }

      // type === 'mcp-credentials'
      console.log('[mcp-chat] credentials message from origin:', event.origin);
      const { url: nextUrl, token: nextToken } = event.data;
      if (typeof nextUrl !== 'string' || typeof nextToken !== 'string' || !nextUrl || !nextToken) {
        console.warn(
          '[mcp-chat] IGNORED: url/token missing or not strings — parent likely sent empty env vars.',
          { url: nextUrl, tokenLen: typeof nextToken === 'string' ? nextToken.length : nextToken },
        );
        return;
      }
      console.log('[mcp-chat] credentials accepted, connecting…');
      setUrl(nextUrl);
      setToken(nextToken);
      void connect(nextUrl, nextToken);
    }

    window.addEventListener('message', onMessage);
    console.log('[mcp-chat] embedded; ready ping sent. allowed parent origins:', ALLOWED_PARENT_ORIGINS);
    // Tell the parent we're mounted and listening. This closes the race where
    // the parent posts on the iframe's `load` event before this listener is
    // attached: the parent can instead wait for this ping, then reply with the
    // credentials. The ping carries no secret, so a '*' target origin is fine.
    window.parent.postMessage({ type: 'mcp-chat-ready' }, '*');

    return () => window.removeEventListener('message', onMessage);
  }, [embedded, connect]);

  if (!connected) {
    // Framing unknown for one render tick — render a neutral placeholder so the
    // server and first client render agree (no hydration mismatch).
    if (embedded === null) {
      return <main className="min-h-screen" />;
    }

    // Embedded: wait for the parent to inject credentials; no manual form.
    if (embedded) {
      return (
        <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-3 p-6 text-center">
          <h1 className="text-2xl font-semibold">MCP Chat</h1>
          {error ? (
            <p className="text-sm text-red-600">{error}</p>
          ) : (
            <p className="text-sm text-gray-500">
              {connecting ? 'Connecting…' : 'Waiting for connection…'}
            </p>
          )}
        </main>
      );
    }

    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-6 p-6">
        <div>
          <h1 className="text-2xl font-semibold">MCP Chat</h1>
          <p className="mt-1 text-sm text-gray-500">
            Connect to an MCP server, then chat with its tools.
          </p>
        </div>
        <form onSubmit={handleConnect} className="flex flex-col gap-3">
          {/* Password-manager extensions (Keeper, etc.) inject a <keeper-lock>
              child node into these labels before hydration, causing a benign
              mismatch. suppressHydrationWarning must sit on the parent where the
              injected node appears, not on the input itself. */}
          <label
            className="flex flex-col gap-1 text-sm"
            suppressHydrationWarning
          >
            <span className="font-medium">MCP server URL</span>
            <input
              type="url"
              required
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://your-mcp-server.com/mcp"
              className="rounded border border-gray-300 px-3 py-2 dark:border-gray-700 dark:bg-gray-900"
            />
          </label>
          <label
            className="flex flex-col gap-1 text-sm"
            suppressHydrationWarning
          >
            <span className="font-medium">Token</span>
            <input
              type="password"
              required
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="Bearer token"
              className="rounded border border-gray-300 px-3 py-2 dark:border-gray-700 dark:bg-gray-900"
            />
          </label>
          <button
            type="submit"
            disabled={connecting}
            className="rounded bg-black px-4 py-2 font-medium text-white disabled:opacity-50 dark:bg-white dark:text-black"
          >
            {connecting ? 'Connecting…' : 'Connect'}
          </button>
          {error && <p className="text-sm text-red-600">{error}</p>}
        </form>
      </main>
    );
  }

  // Connected but the session hasn't been created yet (one render tick).
  if (!session) {
    return <main className="min-h-screen" />;
  }

  return (
    <Chat
      key={session.id}
      url={url}
      token={token}
      sessionId={session.id}
      initialMessages={session.messages}
      hostOrigin={hostOrigin}
    />
  );
}

/**
 * Renders one "process" part of an assistant turn — a reasoning block or a tool
 * call. Text answers are rendered separately by the caller.
 */
function ProcessPart({ part }: { part: UIMessage['parts'][number] }) {
  // The model's thinking. Shown muted/italic to set it apart from the answer.
  if (part.type === 'reasoning') {
    return (
      <div className="my-1 whitespace-pre-wrap border-l-2 border-gray-300 pl-3 text-sm italic text-gray-500 dark:border-gray-700 dark:text-gray-400">
        {part.text}
      </div>
    );
  }
  // MCP tools surface as `dynamic-tool` parts; statically typed tools would be
  // `tool-<name>`. A quiet, collapsed one-liner; expanded, the input/result sit
  // in muted, height-capped boxes so a large result can't dominate the chat.
  if (part.type === 'dynamic-tool' || part.type.startsWith('tool-')) {
    const p = part as {
      type: string;
      toolName?: string;
      state?: string;
      input?: unknown;
      output?: unknown;
      errorText?: string;
    };
    const name = p.toolName ?? part.type.replace(/^tool-/, '');
    const table = extractTable(p.output);
    const isError = p.state === 'output-error' || p.errorText != null;
    const isRunning = !isError && p.state !== 'output-available';
    const hasInput =
      p.input != null &&
      (typeof p.input !== 'object' || Object.keys(p.input as object).length > 0);
    return (
      <details className="group/tool my-1">
        <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded px-1 py-0.5 text-xs text-gray-500 hover:bg-gray-100 [&::-webkit-details-marker]:hidden dark:text-gray-400 dark:hover:bg-gray-900">
          <span className="text-[10px] text-gray-400 transition-transform group-open/tool:rotate-90">
            ▶
          </span>
          <span className="font-mono">{name}</span>
          {isRunning && <span className="text-gray-400">· running…</span>}
          {isError && <span className="text-red-500">· error</span>}
          {table && (
            <span className="text-gray-400">
              · {table.data.length}×{table.columns.length}
              {table.truncated ? ' (truncated)' : ''}
            </span>
          )}
        </summary>

        <div className="mt-1.5 ml-1.5 space-y-2 border-l border-gray-200 pl-3 dark:border-gray-800">
          {hasInput && (
            <div>
              <div className="mb-0.5 text-[10px] font-medium uppercase tracking-wide text-gray-400">
                Input
              </div>
              <pre className="overflow-x-auto rounded bg-gray-50 p-2 text-xs text-gray-600 dark:bg-gray-900 dark:text-gray-300">
                {JSON.stringify(p.input, null, 2)}
              </pre>
            </div>
          )}
          <div>
            <div className="mb-0.5 text-[10px] font-medium uppercase tracking-wide text-gray-400">
              {isError ? 'Error' : 'Result'}
            </div>
            {isError ? (
              <pre className="overflow-x-auto rounded bg-red-50 p-2 text-xs text-red-600 dark:bg-red-950/30 dark:text-red-300">
                {p.errorText ?? JSON.stringify(p.output, null, 2)}
              </pre>
            ) : table ? (
              <>
                <TableView table={table} />
                <details className="mt-1">
                  <summary className="cursor-pointer text-[10px] text-gray-400">
                    Raw JSON
                  </summary>
                  <pre className="mt-1 overflow-x-auto rounded bg-gray-50 p-2 text-xs text-gray-600 dark:bg-gray-900 dark:text-gray-300">
                    {JSON.stringify(p.output, null, 2)}
                  </pre>
                </details>
              </>
            ) : (
              <pre className="overflow-x-auto rounded bg-gray-50 p-2 text-xs text-gray-600 dark:bg-gray-900 dark:text-gray-300">
                {JSON.stringify(p.output, null, 2)}
              </pre>
            )}
          </div>
        </div>
      </details>
    );
  }
  return null;
}

/**
 * Collapsible wrapper around an assistant turn's reasoning + tool calls. Open
 * while the model is working so the steps are visible live; once the turn
 * finishes it auto-collapses to a one-line summary the user can re-expand —
 * matching Claude. State is adjusted from the changed `streaming` prop during
 * render (the sanctioned pattern, not an effect), so it stays user-toggleable.
 */
function ProcessDisclosure({
  streaming,
  children,
}: {
  streaming: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(streaming);
  const [prevStreaming, setPrevStreaming] = useState(streaming);
  if (streaming !== prevStreaming) {
    setPrevStreaming(streaming);
    setOpen(streaming);
  }
  return (
    <details
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
      className="group/think my-1"
    >
      <summary className="flex w-fit cursor-pointer list-none items-center gap-1.5 text-sm text-gray-400 [&::-webkit-details-marker]:hidden">
        <span>{streaming ? 'Thinking…' : 'Reasoning'}</span>
        <span className="text-[10px] transition-transform group-open/think:rotate-90">▶</span>
      </summary>
      <div className="mt-2 space-y-1">{children}</div>
    </details>
  );
}

function Chat({
  url,
  token,
  sessionId,
  initialMessages,
  hostOrigin,
}: {
  url: string;
  token: string;
  sessionId: string;
  initialMessages: UIMessage[];
  hostOrigin: string | null;
}) {
  const [input, setInput] = useState('');
  const { messages, sendMessage, status, error } = useChat({
    id: sessionId,
    messages: initialMessages,
    // After each turn, hand the full up-to-date history to the host so it can
    // persist the session + messages (`messages` already includes the user
    // prompt and the assistant reply). The host upserts by sessionId.
    onFinish: ({ messages, isError, isAbort }) => {
      // Don't persist a half-finished turn — a stream that errored or was
      // aborted leaves an incomplete history the host shouldn't save.
      if (isError || isAbort) return;
      if (typeof window === 'undefined' || window.parent === window) return;
      // Only surface to a verified host origin. Falling back to '*' would
      // broadcast the (potentially sensitive) conversation to any framing page.
      // hostOrigin is set from the first trusted message, which always precedes
      // a finished turn, so this should never drop a legitimate update.
      if (!hostOrigin) {
        console.warn('[mcp-chat] no verified host origin; skipping session surface.');
        return;
      }
      window.parent.postMessage(
        { type: 'mcp-session-updated', sessionId, title: deriveTitle(messages), messages },
        hostOrigin,
      );
    },
  });
  const busy = status === 'submitted' || status === 'streaming';

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text) return;
    // url + token ride along on every request so the server can rebuild the
    // MCP client. They never touch the LLM or the client bundle.
    sendMessage({ text }, { body: { url, token } });
    setInput('');
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-2xl flex-col p-4">
      <div className="flex-1 space-y-4 pb-4">
        {messages.map((message) => {
          // User messages: right-aligned bubble with the plain text they typed.
          if (message.role === 'user') {
            const text = message.parts
              .map((p) => (p.type === 'text' ? p.text : ''))
              .join('');
            return (
              <div key={message.id} className="flex justify-end">
                <div className="max-w-[80%] whitespace-pre-wrap rounded-2xl bg-gray-100 px-4 py-2 text-sm dark:bg-gray-800">
                  {text}
                </div>
              </div>
            );
          }
          // Assistant messages: reasoning + tool calls collapse into a one-line
          // disclosure (open while working, auto-collapsed after the answer);
          // the final text answer always shows below.
          const lastId = messages[messages.length - 1]?.id;
          const streaming = busy && message.id === lastId;
          const processParts = message.parts.filter(
            (p) =>
              p.type === 'reasoning' ||
              p.type === 'dynamic-tool' ||
              p.type.startsWith('tool-'),
          );
          const answerParts = message.parts.filter((p) => p.type === 'text');
          return (
            <div key={message.id}>
              {processParts.length > 0 && (
                <ProcessDisclosure streaming={streaming}>
                  {processParts.map((part, i) => (
                    <ProcessPart key={i} part={part} />
                  ))}
                </ProcessDisclosure>
              )}
              {answerParts.map((part, i) => (
                <div key={i}>
                  <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD}>
                    {(part as { text: string }).text}
                  </ReactMarkdown>
                </div>
              ))}
            </div>
          );
        })}
        {busy && <ThinkingIndicator />}
        {error && (
          <div className="rounded border border-red-300 bg-red-50 p-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/40">
            {friendlyError(error.message)}
          </div>
        )}
      </div>

      <form
        onSubmit={handleSubmit}
        className="sticky bottom-0 mt-4 flex gap-2 bg-background py-3"
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="How can I help you?"
          disabled={busy}
          className="flex-1 rounded border border-gray-300 px-3 py-2 disabled:opacity-50 dark:border-gray-700 dark:bg-gray-900"
        />
        <button
          type="submit"
          disabled={busy}
          className="rounded bg-black px-4 py-2 font-medium text-white disabled:opacity-50 dark:bg-white dark:text-black"
        >
          Send
        </button>
      </form>
    </main>
  );
}

/**
 * Tailwind classes for ReactMarkdown — keeps prose, tables, lists, and code
 * legible without pulling in @tailwindcss/typography. The model is now told to
 * emit markdown tables for tabular results, so the table styling here is what
 * the user actually sees for daily-users / breakdown-style answers.
 */
const MD: Components = {
  p: ({ children }) => <p className="my-2 whitespace-pre-wrap">{children}</p>,
  strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  ul: ({ children }) => <ul className="my-2 list-disc pl-6">{children}</ul>,
  ol: ({ children }) => <ol className="my-2 list-decimal pl-6">{children}</ol>,
  li: ({ children }) => <li className="my-0.5">{children}</li>,
  h1: ({ children }) => <h1 className="my-2 text-lg font-semibold">{children}</h1>,
  h2: ({ children }) => <h2 className="my-2 text-base font-semibold">{children}</h2>,
  h3: ({ children }) => <h3 className="my-2 text-sm font-semibold">{children}</h3>,
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer" className="text-blue-600 underline dark:text-blue-400">
      {children}
    </a>
  ),
  code: ({ children }) => (
    <code className="rounded bg-gray-100 px-1 py-0.5 text-xs dark:bg-gray-800">{children}</code>
  ),
  pre: ({ children }) => (
    <pre className="my-2 overflow-x-auto rounded bg-gray-100 p-2 text-xs dark:bg-gray-900">{children}</pre>
  ),
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto rounded border border-gray-200 dark:border-gray-800">
      <table className="min-w-full border-collapse text-xs">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-gray-50 dark:bg-gray-900">{children}</thead>,
  tr: ({ children }) => <tr className="even:bg-gray-50/50 dark:even:bg-gray-900/40">{children}</tr>,
  th: ({ children }) => (
    <th className="whitespace-nowrap border-b border-gray-200 px-2 py-1 text-left font-medium dark:border-gray-800">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="whitespace-nowrap border-b border-gray-100 px-2 py-1 dark:border-gray-800">{children}</td>
  ),
  blockquote: ({ children }) => (
    <blockquote className="my-2 border-l-2 border-gray-300 pl-3 italic text-gray-600 dark:border-gray-700 dark:text-gray-400">
      {children}
    </blockquote>
  ),
};

/**
 * Most Nekt MCP tools that return tabular results (execute_sql,
 * get_table_preview, …) follow the same shape under structuredContent:
 *   { columns: string[], data: unknown[][], data_truncated?: boolean }
 * Detect that shape and surface it so we can render a real table; everything
 * else falls back to raw JSON.
 */
type Table = {
  columns: string[];
  data: unknown[][];
  truncated: boolean;
};

function extractTable(output: unknown): Table | null {
  if (!output || typeof output !== 'object') return null;
  const sc = (output as { structuredContent?: unknown }).structuredContent;
  if (!sc || typeof sc !== 'object') return null;
  const cols = (sc as { columns?: unknown }).columns;
  const data = (sc as { data?: unknown }).data;
  if (!Array.isArray(cols) || !cols.every((c) => typeof c === 'string')) {
    return null;
  }
  if (!Array.isArray(data) || !data.every((r) => Array.isArray(r))) return null;
  return {
    columns: cols as string[],
    data: data as unknown[][],
    truncated: (sc as { data_truncated?: boolean }).data_truncated === true,
  };
}

function TableView({ table }: { table: Table }) {
  // overflow-x-auto on the wrapper + whitespace-nowrap on cells gives a
  // horizontal scroll inside the chat bubble for wide tables, so a 50-column
  // result doesn't blow out the layout.
  return (
    <div className="mt-1 max-h-64 overflow-auto rounded border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-950">
      <table className="min-w-full border-collapse text-xs">
        <thead className="bg-gray-100/70 dark:bg-gray-900/70">
          <tr>
            {table.columns.map((c) => (
              <th
                key={c}
                className="whitespace-nowrap border-b border-gray-200 px-2 py-1 text-left font-medium dark:border-gray-800"
              >
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.data.map((row, ri) => (
            <tr
              key={ri}
              className="even:bg-gray-50 dark:even:bg-gray-900/40"
            >
              {row.map((cell, ci) => (
                <td
                  key={ci}
                  className="whitespace-nowrap border-b border-gray-100 px-2 py-1 dark:border-gray-800"
                >
                  {cell == null ? (
                    <span className="text-gray-400">—</span>
                  ) : typeof cell === 'object' ? (
                    JSON.stringify(cell)
                  ) : (
                    String(cell)
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
