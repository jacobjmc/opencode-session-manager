import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin/tool";
import type {
  Session,
  Message,
  UserMessage,
  AssistantMessage,
  Part,
  TextPart,
  ToolPart,
  Todo,
  OpencodeClient,
} from "@opencode-ai/sdk";

// ── Constants ───────────────────────────────────────────────────────────────

const SEARCH_TIMEOUT_MS = 60_000;
const MAX_SESSIONS_TO_SCAN = 50;
const DEFAULT_LIST_LIMIT = 20;

// ── SDK Data Helpers ────────────────────────────────────────────────────────

function isUserMessage(msg: Message): msg is UserMessage {
  return msg.role === "user";
}

function isAssistantMessage(msg: Message): msg is AssistantMessage {
  return msg.role === "assistant";
}

function getAgent(msg: Message): string | undefined {
  if (isUserMessage(msg)) return msg.agent;
  if (isAssistantMessage(msg)) return msg.mode;
  return undefined;
}

function getModel(msg: Message): string | undefined {
  if (isUserMessage(msg)) {
    return msg.model ? `${msg.model.providerID}/${msg.model.modelID}` : undefined;
  }
  if (isAssistantMessage(msg)) {
    return msg.providerID && msg.modelID
      ? `${msg.providerID}/${msg.modelID}`
      : undefined;
  }
  return undefined;
}

// ── SDK API Layer ───────────────────────────────────────────────────────────

async function listSessions(
  client: OpencodeClient,
  directory?: string
): Promise<Session[]> {
  const query = directory ? { directory } : {};
  const result = await client.session.list({ query });
  if (!result.data) return [];

  const sessions = result.data
    .filter((s) => !s.parentID)
    .sort((a, b) => b.time.updated - a.time.updated);

  return sessions;
}

async function listSessionsAllScopes(client: OpencodeClient): Promise<Session[]> {
  try {
    const projectResult = await client.project.list({ query: {} });
    const projects = projectResult.data ?? [];
    const directories = Array.from(
      new Set(projects.map((project) => project.worktree).filter(Boolean))
    );

    if (directories.length === 0) {
      return await listSessions(client, undefined);
    }

    const settled = await Promise.allSettled(
      directories.map((directory) => client.session.list({ query: { directory } }))
    );

    const merged = new Map<string, Session>();
    for (const result of settled) {
      if (result.status !== "fulfilled") continue;
      const sessions = result.value.data ?? [];
      for (const session of sessions) {
        const existing = merged.get(session.id);
        if (!existing || existing.time.updated < session.time.updated) {
          merged.set(session.id, session);
        }
      }
    }

    return Array.from(merged.values())
      .filter((s) => !s.parentID)
      .sort((a, b) => b.time.updated - a.time.updated);
  } catch {
    return await listSessions(client, undefined);
  }
}

function parseDateStart(input: string): number | undefined {
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(input);
  const date = new Date(dateOnly ? `${input}T00:00:00` : input);
  const ms = date.getTime();
  return Number.isNaN(ms) ? undefined : ms;
}

function parseDateEnd(input: string): number | undefined {
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(input);
  const date = new Date(dateOnly ? `${input}T23:59:59.999` : input);
  const ms = date.getTime();
  return Number.isNaN(ms) ? undefined : ms;
}

async function getSession(
  client: OpencodeClient,
  sessionID: string
): Promise<Session | null> {
  const result = await client.session.get({
    path: { id: sessionID },
  });
  return result.data ?? null;
}

async function getMessages(
  client: OpencodeClient,
  sessionID: string,
  limit?: number
): Promise<Array<{ info: Message; parts: Part[] }>> {
  const result = await client.session.messages({
    path: { id: sessionID },
    query: { limit },
  });
  return result.data ?? [];
}

async function getTodos(
  client: OpencodeClient,
  sessionID: string
): Promise<Todo[]> {
  const result = await client.session.todo({
    path: { id: sessionID },
  });
  return result.data ?? [];
}

// ── Session Info ────────────────────────────────────────────────────────────

interface SessionInfo {
  id: string;
  title?: string;
  message_count: number;
  first_message?: Date;
  last_message?: Date;
  agents_used: string[];
  models_used: string[];
  has_todos: boolean;
  todos?: Todo[];
}

async function getSessionInfo(
  client: OpencodeClient,
  session: Session
): Promise<SessionInfo> {
  const [messages, todos] = await Promise.all([
    getMessages(client, session.id),
    getTodos(client, session.id),
  ]);

  const agentsSet = new Set<string>();
  const modelsSet = new Set<string>();
  let firstTime: number | undefined;
  let lastTime: number | undefined;

  for (const { info } of messages) {
    const agent = getAgent(info);
    if (agent) agentsSet.add(agent);
    const model = getModel(info);
    if (model) modelsSet.add(model);

    const created = info.time.created;
    if (firstTime === undefined || created < firstTime) firstTime = created;
    if (lastTime === undefined || created > lastTime) lastTime = created;
  }

  return {
    id: session.id,
    title: session.title,
    message_count: messages.length,
    first_message: firstTime !== undefined ? new Date(firstTime) : undefined,
    last_message: lastTime !== undefined ? new Date(lastTime) : undefined,
    agents_used: Array.from(agentsSet),
    models_used: Array.from(modelsSet),
    has_todos: todos.length > 0,
    todos: todos.length > 0 ? todos : undefined,
  };
}

// ── Formatting ──────────────────────────────────────────────────────────────

function formatDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

function truncateText(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + "...";
}

function formatSessionList(infos: SessionInfo[]): string {
  if (infos.length === 0) return "No sessions found.";

  const lines: string[] = [];
  lines.push("| Session ID | Title | Messages | First | Last | Agents |");
  lines.push("|------------|-------|----------|-------|------|--------|");

  for (const info of infos) {
    const title = info.title ?? "(untitled)";
    const first = info.first_message ? formatDate(info.first_message) : "-";
    const last = info.last_message ? formatDate(info.last_message) : "-";
    const agents = info.agents_used.length > 0 ? info.agents_used.join(", ") : "-";
    lines.push(`| ${info.id} | ${title} | ${info.message_count} | ${first} | ${last} | ${agents} |`);
  }

  return lines.join("\n");
}

function isTextPart(part: Part): part is TextPart {
  return part.type === "text";
}

function isToolPart(part: Part): part is ToolPart {
  return part.type === "tool";
}

function formatMessages(
  messages: Array<{ info: Message; parts: Part[] }>,
  includeTodos?: boolean,
  todos?: Todo[]
): string {
  if (messages.length === 0) return "No messages found.";

  const lines: string[] = [];

  for (const { info, parts } of messages) {
    const timestamp = formatDate(new Date(info.time.created));
    const agent = getAgent(info);
    const agentLabel = agent ? ` [${agent}]` : "";
    const model = getModel(info);
    const modelLabel = model ? ` (${model})` : "";
    lines.push(`--- ${info.role}${agentLabel}${modelLabel} @ ${timestamp} ---`);

    for (const part of parts) {
      if (isTextPart(part) && part.text) {
        lines.push(part.text);
      } else if (part.type === "reasoning" && "text" in part) {
        lines.push(`[thinking] ${truncateText(String(part.text), 200)}`);
      } else if (isToolPart(part)) {
        const toolName = part.tool ?? "unknown";
        const inputStr = "input" in part.state
          ? truncateText(JSON.stringify(part.state.input), 100)
          : "";
        if (part.state.status === "completed") {
          lines.push(`[tool: ${toolName}] ${inputStr}`);
          lines.push(`  -> ${truncateText(part.state.output, 200)}`);
        } else if (part.state.status === "error" && "error" in part.state) {
          lines.push(`[tool: ${toolName}] ${inputStr}`);
          lines.push(`  -> ERROR: ${truncateText(part.state.error, 200)}`);
        } else {
          lines.push(`[tool: ${toolName}] ${inputStr}`);
        }
      }
    }
    lines.push("");
  }

  if (includeTodos && todos && todos.length > 0) {
    lines.push("--- Todos ---");
    for (const todo of todos) {
      const marker = todo.status === "completed" ? "x" : " ";
      const priority = todo.priority ? ` (${todo.priority})` : "";
      lines.push(`[${marker}] ${todo.content}${priority}`);
    }
  }

  return lines.join("\n");
}

function formatSessionInfo(info: SessionInfo): string {
  const lines: string[] = [];
  lines.push(`**Session ID:** ${info.id}`);
  lines.push(`**Title:** ${info.title ?? "(untitled)"}`);
  lines.push(`**Message Count:** ${info.message_count}`);

  if (info.first_message) {
    lines.push(`**First Message:** ${formatDate(info.first_message)}`);
  }
  if (info.last_message) {
    lines.push(`**Last Message:** ${formatDate(info.last_message)}`);
  }
  if (info.first_message && info.last_message) {
    const durationMs = info.last_message.getTime() - info.first_message.getTime();
    const minutes = Math.floor(durationMs / 60_000);
    const hours = Math.floor(minutes / 60);
    const remainingMins = minutes % 60;
    const durationStr = hours > 0 ? `${hours}h ${remainingMins}m` : `${minutes}m`;
    lines.push(`**Duration:** ${durationStr}`);
  }

  lines.push(`**Agents Used:** ${info.agents_used.length > 0 ? info.agents_used.join(", ") : "none"}`);
  lines.push(`**Models Used:** ${info.models_used.length > 0 ? info.models_used.join(", ") : "none"}`);

  if (info.has_todos && info.todos) {
    const completed = info.todos.filter((t) => t.status === "completed").length;
    lines.push(`**Todos:** ${info.todos.length} total, ${completed} completed`);
  } else {
    lines.push(`**Todos:** none`);
  }

  return lines.join("\n");
}

// ── Search ──────────────────────────────────────────────────────────────────

interface SearchResult {
  session_id: string;
  message_id: string;
  role: string;
  excerpt: string;
  match_count: number;
  timestamp?: number;
}

function formatSearchResults(results: SearchResult[]): string {
  if (results.length === 0) return "No matches found.";

  const lines: string[] = [];
  lines.push(`Found ${results.length} match(es):\n`);

  for (const result of results) {
    const timestamp = result.timestamp ? formatDate(new Date(result.timestamp)) : "unknown";
    lines.push(`**Session:** ${result.session_id}`);
    lines.push(`**Message:** ${result.message_id} (${result.role}) @ ${timestamp}`);
    lines.push(`**Matches:** ${result.match_count}`);
    lines.push(`**Excerpt:** ${result.excerpt}`);
    lines.push("");
  }

  return lines.join("\n");
}

async function searchInSession(
  client: OpencodeClient,
  sessionID: string,
  query: string,
  caseSensitive: boolean,
  maxResults: number
): Promise<SearchResult[]> {
  const messages = await getMessages(client, sessionID);
  const results: SearchResult[] = [];
  const normalizedQuery = caseSensitive ? query : query.toLowerCase();

  for (const { info, parts } of messages) {
    if (results.length >= maxResults) break;

    for (const part of parts) {
      if (results.length >= maxResults) break;
      if (!isTextPart(part) || !part.text) continue;

      const text = caseSensitive ? part.text : part.text.toLowerCase();
      let matchCount = 0;
      let firstIndex = -1;
      let searchFrom = 0;

      while (true) {
        const idx = text.indexOf(normalizedQuery, searchFrom);
        if (idx === -1) break;
        matchCount++;
        if (firstIndex === -1) firstIndex = idx;
        searchFrom = idx + 1;
      }

      if (matchCount > 0) {
        const contextStart = Math.max(0, firstIndex - 50);
        const contextEnd = Math.min(part.text.length, firstIndex + normalizedQuery.length + 50);
        const excerpt =
          (contextStart > 0 ? "..." : "") +
          part.text.slice(contextStart, contextEnd) +
          (contextEnd < part.text.length ? "..." : "");

        results.push({
          session_id: sessionID,
          message_id: info.id,
          role: info.role,
          excerpt,
          match_count: matchCount,
          timestamp: info.time.created,
        });
      }
    }
  }

  return results;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err as Error); }
    );
  });
}

// ── Plugin Export ───────────────────────────────────────────────────────────

export const SessionManager: Plugin = async (ctx) => {
  const client = ctx.client;

  return {
    tool: {
      session_list: tool({
        description:
          "List recent sessions for the current project. Returns a markdown table with session ID, title, message count, first/last message timestamps, and agents used. Use this to discover sessions before reading or searching them.",
        args: {
          limit: tool.schema
            .number()
            .optional()
            .describe("Maximum number of sessions to return (default: 20)"),
          from_date: tool.schema
            .string()
            .optional()
            .describe("Filter sessions from this date (ISO 8601 format, e.g. 2026-02-01)"),
          to_date: tool.schema
            .string()
            .optional()
            .describe("Filter sessions until this date (ISO 8601 format, e.g. 2026-02-09)"),
          project_path: tool.schema
            .string()
            .optional()
            .describe("Override project path for scoping (defaults to current project directory)"),
          all_scopes: tool.schema
            .boolean()
            .optional()
            .describe("List sessions across all workspaces (ignores project_path)"),
        },
        async execute(args, context) {
          try {
            const directory = args.all_scopes ? undefined : (args.project_path ?? context.directory);
            const limit = args.limit ?? DEFAULT_LIST_LIMIT;
            let sessions = args.all_scopes
              ? await listSessionsAllScopes(client)
              : await listSessions(client, directory);

            if (args.from_date) {
              const fromMs = parseDateStart(args.from_date);
              if (fromMs !== undefined) {
                sessions = sessions.filter((s) => s.time.updated >= fromMs);
              }
            }
            if (args.to_date) {
              const toMs = parseDateEnd(args.to_date);
              if (toMs !== undefined) {
                sessions = sessions.filter((s) => s.time.updated <= toMs);
              }
            }

            sessions = sessions.slice(0, limit);

            const infos: SessionInfo[] = [];
            for (const session of sessions) {
              const info = await getSessionInfo(client, session);
              infos.push(info);
            }

            return formatSessionList(infos);
          } catch (e) {
            return `Error listing sessions: ${e instanceof Error ? e.message : String(e)}`;
          }
        },
      }),

      session_read: tool({
        description:
          "Read all messages from a specific session. Returns chronological messages with role, agent, timestamp, and content. Tool invocations are shown with truncated inputs/outputs. Use session_list first to find session IDs.",
        args: {
          session_id: tool.schema
            .string()
            .describe("Session ID to read (e.g. ses_3d008e17dffe...)"),
          include_todos: tool.schema
            .boolean()
            .optional()
            .describe("Include the session's todo list in output (default: false)"),
          limit: tool.schema
            .number()
            .optional()
            .describe("Maximum number of messages to return"),
        },
        async execute(args) {
          try {
            const messages = await getMessages(client, args.session_id, args.limit);
            if (messages.length === 0) {
              return `Session not found or has no messages: ${args.session_id}`;
            }

            let todos: Todo[] | undefined;
            if (args.include_todos) {
              todos = await getTodos(client, args.session_id);
            }

            const result = formatMessages(messages, args.include_todos, todos);
            return result;
          } catch (e) {
            return `Error reading session: ${e instanceof Error ? e.message : String(e)}`;
          }
        },
      }),

      session_search: tool({
        description:
          "Search for text across sessions. Returns matching excerpts with surrounding context. Scoped to the current project by default. Use all_scopes to search across all workspaces, or session_id to search within one session.",
        args: {
          query: tool.schema
            .string()
            .describe("Text to search for (substring match)"),
          session_id: tool.schema
            .string()
            .optional()
            .describe("Search only within this specific session ID"),
          case_sensitive: tool.schema
            .boolean()
            .optional()
            .describe("Enable case-sensitive search (default: false)"),
          limit: tool.schema
            .number()
            .optional()
            .describe("Maximum number of results to return (default: 20)"),
          all_scopes: tool.schema
            .boolean()
            .optional()
            .describe("Search across all workspaces (ignored when session_id is provided)"),
        },
        async execute(args, context) {
          try {
            const caseSensitive = args.case_sensitive ?? false;
            const limit = args.limit ?? 20;

            if (args.session_id) {
              const results = await withTimeout(
                searchInSession(client, args.session_id, args.query, caseSensitive, limit),
                SEARCH_TIMEOUT_MS,
                "session_search"
              );
              return formatSearchResults(results);
            }

            const sessions = args.all_scopes
              ? await listSessionsAllScopes(client)
              : await listSessions(client, context.directory);
            const sessionsToScan = sessions.slice(0, MAX_SESSIONS_TO_SCAN);
            const allResults: SearchResult[] = [];

            const searchPromise = (async () => {
              for (const session of sessionsToScan) {
                if (allResults.length >= limit) break;
                const remaining = limit - allResults.length;
                const results = await searchInSession(client, session.id, args.query, caseSensitive, remaining);
                allResults.push(...results);
              }
              return allResults;
            })();

            await withTimeout(searchPromise, SEARCH_TIMEOUT_MS, "session_search");

            let output = formatSearchResults(allResults.slice(0, limit));
            if (sessions.length > MAX_SESSIONS_TO_SCAN) {
              output += `\n\n(Searched ${MAX_SESSIONS_TO_SCAN} of ${sessions.length} sessions)`;
            }
            return output;
          } catch (e) {
            return `Error searching sessions: ${e instanceof Error ? e.message : String(e)}`;
          }
        },
      }),

      session_info: tool({
        description:
          "Get metadata and statistics for a specific session. Returns session ID, title, message count, date range, duration, agents and models used, and todo counts.",
        args: {
          session_id: tool.schema
            .string()
            .describe("Session ID to get info for"),
        },
        async execute(args) {
          try {
            const session = await getSession(client, args.session_id);
            if (!session) {
              return `Session not found: ${args.session_id}`;
            }
            const info = await getSessionInfo(client, session);
            return formatSessionInfo(info);
          } catch (e) {
            return `Error getting session info: ${e instanceof Error ? e.message : String(e)}`;
          }
        },
      }),
    },
  };
};
