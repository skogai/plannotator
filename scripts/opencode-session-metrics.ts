#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

type JsonObject = Record<string, unknown>;

type Tokens = {
  input: number;
  output: number;
  reasoning: number;
  cache: {
    read: number;
    write: number;
  };
  total?: number;
};

type SessionSpec = {
  label: string;
  sessionID: string;
};

type Args = {
  db?: string;
  outDir: string;
  list: boolean;
  find?: string;
  limit: number;
  sessions: SessionSpec[];
};

const DEFAULT_LIMIT = 12;

function usage(exitCode = 1): never {
  console.log(`Usage:
  bun scripts/opencode-session-metrics.ts --list
  bun scripts/opencode-session-metrics.ts --find METRIC_RUN_...
  bun scripts/opencode-session-metrics.ts baseline=ses_xxx plannotator=ses_yyy

Options:
  --db <path>       OpenCode SQLite DB. Defaults to common XDG paths.
  --out <dir>       Output directory. Default: debug/opencode-session-metrics
  --find <text>     Find sessions whose message/tool JSON contains text.
  --limit <n>       Session count for --list. Default: ${DEFAULT_LIMIT}

This only reads finished OpenCode sessions. It does not automate OpenCode.`);
  process.exit(exitCode);
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    outDir: path.resolve("debug/opencode-session-metrics"),
    list: false,
    limit: DEFAULT_LIMIT,
    sessions: [],
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") usage(0);
    if (arg === "--list") {
      args.list = true;
      continue;
    }
    if (arg === "--find") {
      args.find = argv[++i];
      if (!args.find) usage();
      continue;
    }
    if (arg === "--db") {
      args.db = argv[++i];
      if (!args.db) usage();
      continue;
    }
    if (arg === "--out") {
      const out = argv[++i];
      if (!out) usage();
      args.outDir = path.resolve(out);
      continue;
    }
    if (arg === "--limit") {
      const limit = Number(argv[++i]);
      if (!Number.isInteger(limit) || limit <= 0) usage();
      args.limit = limit;
      continue;
    }

    const eq = arg.indexOf("=");
    if (eq === -1) usage();
    const label = arg.slice(0, eq).trim();
    const sessionID = arg.slice(eq + 1).trim();
    if (!label || !sessionID) usage();
    args.sessions.push({ label, sessionID });
  }

  if (!args.list && !args.find && args.sessions.length === 0) usage();
  return args;
}

function xdgDataHome() {
  return process.env.XDG_DATA_HOME || path.join(homedir(), ".local", "share");
}

function resolveDbPath(input?: string) {
  if (input) {
    if (path.isAbsolute(input)) return input;
    return path.resolve(input);
  }

  const opencodeDb = process.env.OPENCODE_DB;
  const root = path.join(xdgDataHome(), "opencode");
  const candidates = [
    opencodeDb ? (path.isAbsolute(opencodeDb) ? opencodeDb : path.join(root, opencodeDb)) : undefined,
    path.join(root, "opencode.db"),
    path.join(root, "opencode-prod.db"),
    path.join(root, "opencode-latest.db"),
    path.join(root, "opencode-beta.db"),
    path.join(root, "opencode-local.db"),
  ].filter(Boolean) as string[];

  const found = candidates.find((item) => existsSync(item));
  if (!found) {
    throw new Error(`Could not find OpenCode DB. Tried:\n${candidates.map((item) => `  ${item}`).join("\n")}`);
  }
  return found;
}

function parseJson(value: unknown): JsonObject {
  if (!value) return {};
  if (typeof value === "object") return value as JsonObject;
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function number(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function string(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function tokensFromSession(row: JsonObject): Tokens {
  return {
    input: number(row.tokens_input),
    output: number(row.tokens_output),
    reasoning: number(row.tokens_reasoning),
    cache: {
      read: number(row.tokens_cache_read),
      write: number(row.tokens_cache_write),
    },
  };
}

function tokensFromData(data: JsonObject): Tokens {
  const cache = parseJson(data.cache);
  return {
    input: number(data.input),
    output: number(data.output),
    reasoning: number(data.reasoning),
    cache: {
      read: number(cache.read),
      write: number(cache.write),
    },
    total: data.total === undefined ? undefined : number(data.total),
  };
}

function tokensFromMessage(data: JsonObject): Tokens {
  return tokensFromData(parseJson(data.tokens));
}

function addTokens(left: Tokens, right: Tokens): Tokens {
  return {
    input: left.input + right.input,
    output: left.output + right.output,
    reasoning: left.reasoning + right.reasoning,
    cache: {
      read: left.cache.read + right.cache.read,
      write: left.cache.write + right.cache.write,
    },
    total: (left.total ?? 0) + (right.total ?? 0) || undefined,
  };
}

function totalTokens(tokens: Tokens) {
  return tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write;
}

function money(value: number) {
  return `$${value.toFixed(6)}`;
}

function fmtInt(value: number) {
  return Math.round(value).toLocaleString("en-US");
}

function fmtDate(ms: unknown) {
  return number(ms) ? new Date(number(ms)).toISOString() : undefined;
}

function listSessions(db: Database, limit: number) {
  const rows = db
    .query(
      `select id, title, directory, agent, model, cost, tokens_input, tokens_output,
              tokens_reasoning, tokens_cache_read, tokens_cache_write,
              time_created, time_updated
         from session
        order by time_updated desc
        limit ?`,
    )
    .all(limit) as JsonObject[];

  for (const row of rows) {
    const tokens = tokensFromSession(row);
    console.log(
      [
        row.id,
        fmtDate(row.time_updated),
        money(number(row.cost)),
        `in=${fmtInt(tokens.input)}`,
        `out=${fmtInt(tokens.output)}`,
        `cache_read=${fmtInt(tokens.cache.read)}`,
        string(row.title) ?? "",
      ].join("\t"),
    );
  }
}

function findSessions(db: Database, marker: string, limit: number) {
  const rows = db
    .query(
      `select distinct s.id, s.title, s.directory, s.agent, s.model, s.cost,
              s.tokens_input, s.tokens_output, s.tokens_reasoning,
              s.tokens_cache_read, s.tokens_cache_write,
              s.time_created, s.time_updated
         from session s
         left join message m on m.session_id = s.id
         left join part p on p.session_id = s.id
        where m.data like ?
           or p.data like ?
           or s.title like ?
        order by s.time_updated desc
        limit ?`,
    )
    .all(`%${marker}%`, `%${marker}%`, `%${marker}%`, limit) as JsonObject[];

  if (rows.length === 0) {
    console.log(`No sessions found for marker: ${marker}`);
    return;
  }

  for (const row of rows) {
    const tokens = tokensFromSession(row);
    console.log(
      [
        row.id,
        fmtDate(row.time_updated),
        money(number(row.cost)),
        `in=${fmtInt(tokens.input)}`,
        `out=${fmtInt(tokens.output)}`,
        `cache_read=${fmtInt(tokens.cache.read)}`,
        string(row.title) ?? "",
      ].join("\t"),
    );
  }
}

function summarizeSession(db: Database, spec: SessionSpec) {
  const session = db
    .query(
      `select id, project_id, workspace_id, parent_id, slug, directory, path, title,
              version, cost, tokens_input, tokens_output, tokens_reasoning,
              tokens_cache_read, tokens_cache_write, agent, model,
              time_created, time_updated, time_compacting, time_archived
         from session
        where id = ?`,
    )
    .get(spec.sessionID) as JsonObject | null;

  if (!session) throw new Error(`Session not found: ${spec.sessionID}`);

  const messages = db
    .query(`select id, time_created, time_updated, data from message where session_id = ? order by time_created, id`)
    .all(spec.sessionID) as JsonObject[];

  const parts = db
    .query(
      `select id, message_id, time_created, time_updated, data
         from part
        where session_id = ?
        order by time_created, id`,
    )
    .all(spec.sessionID) as JsonObject[];

  const messagesByID = new Map<string, JsonObject>();
  for (const row of messages) messagesByID.set(String(row.id), parseJson(row.data));

  const assistantCalls = [];
  const userMessages = [];
  const toolCalls = [];
  const stepFinishes = [];
  const toolUsage: Record<string, number> = {};
  const messageRoleCounts: Record<string, number> = {};
  const modelUsage: Record<string, { calls: number; cost: number; tokens: Tokens }> = {};

  for (const row of messages) {
    const data = parseJson(row.data);
    const role = string(data.role) ?? "unknown";
    messageRoleCounts[role] = (messageRoleCounts[role] ?? 0) + 1;

    if (role === "user") {
      userMessages.push({
        id: row.id,
        agent: string(data.agent),
        model: parseJson(data.model),
        tools: data.tools,
        time: {
          created: fmtDate(row.time_created),
          updated: fmtDate(row.time_updated),
        },
      });
    }

    if (role === "assistant") {
      const tokens = tokensFromMessage(data);
      const cost = number(data.cost);
      const providerID = string(data.providerID) ?? "unknown";
      const modelID = string(data.modelID) ?? "unknown";
      const key = `${providerID}/${modelID}`;
      modelUsage[key] ??= {
        calls: 0,
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      };
      modelUsage[key].calls++;
      modelUsage[key].cost += cost;
      modelUsage[key].tokens = addTokens(modelUsage[key].tokens, tokens);
      assistantCalls.push({
        id: row.id,
        parentID: data.parentID,
        agent: string(data.agent),
        providerID,
        modelID,
        variant: string(data.variant),
        finish: string(data.finish),
        cost,
        tokens,
        time: {
          created: fmtDate(row.time_created),
          updated: fmtDate(row.time_updated),
          completed: fmtDate(parseJson(data.time).completed),
        },
      });
    }
  }

  for (const row of parts) {
    const data = parseJson(row.data);
    if (data.type === "tool") {
      const tool = string(data.tool) ?? "unknown";
      const state = parseJson(data.state);
      toolUsage[tool] = (toolUsage[tool] ?? 0) + 1;
      toolCalls.push({
        id: row.id,
        messageID: row.message_id,
        assistantAgent: string(messagesByID.get(String(row.message_id))?.agent),
        tool,
        callID: string(data.callID),
        status: string(state.status),
        title: string(state.title),
        hasError: state.status === "error",
        error: string(state.error),
        time: {
          created: fmtDate(row.time_created),
          updated: fmtDate(row.time_updated),
          start: fmtDate(parseJson(state.time).start),
          end: fmtDate(parseJson(state.time).end),
        },
      });
    }

    if (data.type === "step-finish") {
      stepFinishes.push({
        id: row.id,
        messageID: row.message_id,
        assistantAgent: string(messagesByID.get(String(row.message_id))?.agent),
        reason: string(data.reason),
        cost: number(data.cost),
        tokens: tokensFromData(parseJson(data.tokens)),
        time: {
          created: fmtDate(row.time_created),
          updated: fmtDate(row.time_updated),
        },
      });
    }
  }

  const sessionTokens = tokensFromSession(session);
  const submitPlanCalls = toolCalls.filter((call) => call.tool === "submit_plan").length;

  return {
    label: spec.label,
    session: {
      id: session.id,
      title: session.title,
      directory: session.directory,
      path: session.path,
      parentID: session.parent_id,
      agent: session.agent,
      model: parseJson(session.model),
      version: session.version,
      cost: number(session.cost),
      tokens: sessionTokens,
      totalTokens: totalTokens(sessionTokens),
      time: {
        created: fmtDate(session.time_created),
        updated: fmtDate(session.time_updated),
        compacting: fmtDate(session.time_compacting),
        archived: fmtDate(session.time_archived),
      },
    },
    counts: {
      messages: messages.length,
      roles: messageRoleCounts,
      assistantCalls: assistantCalls.length,
      userMessages: userMessages.length,
      parts: parts.length,
      toolCalls: toolCalls.length,
      submitPlanCalls,
      stepFinishes: stepFinishes.length,
    },
    ratios: {
      cacheReadRate:
        sessionTokens.input + sessionTokens.cache.read + sessionTokens.cache.write > 0
          ? sessionTokens.cache.read / (sessionTokens.input + sessionTokens.cache.read + sessionTokens.cache.write)
          : 0,
      costPerAssistantCall: assistantCalls.length ? number(session.cost) / assistantCalls.length : 0,
      tokensPerAssistantCall: assistantCalls.length ? totalTokens(sessionTokens) / assistantCalls.length : 0,
    },
    modelUsage,
    toolUsage,
    assistantCalls,
    stepFinishes,
    toolCalls,
    userMessages,
    notes: [
      "OpenCode DB stores normalized session/message usage. It does not store raw provider usage payloads.",
      "Background calls that do not create assistant messages, such as title generation, may be missing here.",
      "Cache read/write numbers are only present when the provider reports them and OpenCode maps them.",
    ],
  };
}

function diffReport(items: ReturnType<typeof summarizeSession>[]) {
  if (items.length !== 2) return undefined;
  const [a, b] = items;
  return {
    from: a.label,
    to: b.label,
    costDelta: b.session.cost - a.session.cost,
    tokenDelta: {
      input: b.session.tokens.input - a.session.tokens.input,
      output: b.session.tokens.output - a.session.tokens.output,
      reasoning: b.session.tokens.reasoning - a.session.tokens.reasoning,
      cacheRead: b.session.tokens.cache.read - a.session.tokens.cache.read,
      cacheWrite: b.session.tokens.cache.write - a.session.tokens.cache.write,
      total: b.session.totalTokens - a.session.totalTokens,
    },
    countDelta: {
      messages: b.counts.messages - a.counts.messages,
      assistantCalls: b.counts.assistantCalls - a.counts.assistantCalls,
      toolCalls: b.counts.toolCalls - a.counts.toolCalls,
      submitPlanCalls: b.counts.submitPlanCalls - a.counts.submitPlanCalls,
      stepFinishes: b.counts.stepFinishes - a.counts.stepFinishes,
    },
  };
}

function markdownReport(report: { generatedAt: string; dbPath: string; sessions: ReturnType<typeof summarizeSession>[] }) {
  const lines = [
    "# OpenCode Session Metrics",
    "",
    `Generated: ${report.generatedAt}`,
    `DB: ${report.dbPath}`,
    "",
    "## Summary",
    "",
    "| label | session | cost | input | output | reasoning | cache read | cache write | assistant calls | tools | submit_plan |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];

  for (const item of report.sessions) {
    lines.push(
      [
        `| ${item.label}`,
        String(item.session.id),
        money(item.session.cost),
        fmtInt(item.session.tokens.input),
        fmtInt(item.session.tokens.output),
        fmtInt(item.session.tokens.reasoning),
        fmtInt(item.session.tokens.cache.read),
        fmtInt(item.session.tokens.cache.write),
        fmtInt(item.counts.assistantCalls),
        fmtInt(item.counts.toolCalls),
        fmtInt(item.counts.submitPlanCalls),
      ].join(" | ") + " |",
    );
  }

  const diff = diffReport(report.sessions);
  if (diff) {
    lines.push(
      "",
      "## Delta",
      "",
      `Compared ${diff.from} -> ${diff.to}.`,
      "",
      `Cost delta: ${money(diff.costDelta)}`,
      `Total token delta: ${fmtInt(diff.tokenDelta.total)}`,
      `Assistant call delta: ${fmtInt(diff.countDelta.assistantCalls)}`,
      `Tool call delta: ${fmtInt(diff.countDelta.toolCalls)}`,
      `submit_plan delta: ${fmtInt(diff.countDelta.submitPlanCalls)}`,
    );
  }

  lines.push(
    "",
    "## Limits",
    "",
    "- This reads OpenCode's local DB.",
    "- It does not include hidden background calls unless OpenCode stored them as session messages.",
    "- Use provider/OpenCode Go billing rows for final dollar truth if available.",
    "",
  );

  return lines.join("\n");
}

const args = parseArgs(Bun.argv.slice(2));
const dbPath = resolveDbPath(args.db);
const db = new Database(dbPath, { readonly: true });

if (args.list) {
  listSessions(db, args.limit);
  db.close();
  process.exit(0);
}

if (args.find) {
  findSessions(db, args.find, args.limit);
  db.close();
  process.exit(0);
}

const generatedAt = new Date().toISOString();
const report = {
  generatedAt,
  dbPath,
  sessions: args.sessions.map((spec) => summarizeSession(db, spec)),
};
const withDiff = { ...report, diff: diffReport(report.sessions) };
db.close();

mkdirSync(args.outDir, { recursive: true });
const stamp = generatedAt.replace(/[:.]/g, "-");
const jsonPath = path.join(args.outDir, `${stamp}.json`);
const mdPath = path.join(args.outDir, `${stamp}.md`);
writeFileSync(jsonPath, JSON.stringify(withDiff, null, 2));
writeFileSync(mdPath, markdownReport(report));

console.log(`Wrote ${jsonPath}`);
console.log(`Wrote ${mdPath}`);
