/**
 * Pi SDK provider — bridges Plannotator's AI layer with Pi's coding agent.
 *
 * Spawns `pi --mode rpc` as a subprocess and communicates via JSONL over
 * stdio. No Pi SDK is imported — this is a thin protocol adapter.
 *
 * One subprocess per session. The user must have the `pi` CLI installed.
 */

import { BaseSession } from "../base-session.ts";
import { buildEffectivePrompt, buildSystemPrompt } from "../context.ts";
import type {
	AIMessage,
	AIProvider,
	AIProviderCapabilities,
	CreateSessionOptions,
	ForkCandidate,
	PiSDKConfig,
} from "../types.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROVIDER_NAME = "pi-sdk";

// ---------------------------------------------------------------------------
// JSONL subprocess wrapper
// ---------------------------------------------------------------------------

type EventListener = (event: Record<string, unknown>) => void;

class PiProcess {
	private proc: ReturnType<typeof Bun.spawn> | null = null;
	private listeners: EventListener[] = [];
	private pendingRequests = new Map<
		string,
		{
			resolve: (data: Record<string, unknown>) => void;
			reject: (err: Error) => void;
		}
	>();
	private nextId = 0;
	private buffer = "";
	private _alive = false;

	async spawn(piPath: string, cwd: string): Promise<void> {
		this.proc = Bun.spawn([piPath, "--mode", "rpc"], {
			cwd,
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		this._alive = true;

		this.readStream();

		this.proc.exited.then(() => {
			this._alive = false;
			for (const [, pending] of this.pendingRequests) {
				pending.reject(new Error("Pi process exited unexpectedly"));
			}
			this.pendingRequests.clear();
			// Signal active query listeners so the drain loop exits with an error
			for (const listener of this.listeners) {
				listener({ type: "process_exited" });
			}
		});
	}

	private async readStream(): Promise<void> {
		if (!this.proc?.stdout || typeof this.proc.stdout === "number") return;
		const reader = (this.proc.stdout as ReadableStream<Uint8Array>).getReader();
		const decoder = new TextDecoder();

		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				this.buffer += decoder.decode(value, { stream: true });
				const lines = this.buffer.split("\n");
				this.buffer = lines.pop() ?? "";

				for (const line of lines) {
					const trimmed = line.replace(/\r$/, "");
					if (!trimmed) continue;
					try {
						const parsed = JSON.parse(trimmed);
						this.routeMessage(parsed);
					} catch {
						// Ignore malformed lines
					}
				}
			}
		} catch {
			// Stream closed
		}
	}

	private routeMessage(msg: Record<string, unknown>): void {
		// Response to a command we sent
		if (msg.type === "response" && typeof msg.id === "string") {
			const pending = this.pendingRequests.get(msg.id);
			if (pending) {
				this.pendingRequests.delete(msg.id);
				if (msg.success === false) {
					pending.reject(new Error((msg.error as string) ?? "RPC error"));
				} else {
					pending.resolve((msg.data as Record<string, unknown>) ?? {});
				}
				return;
			}
		}

		// Agent event — forward to listeners
		for (const listener of this.listeners) {
			listener(msg);
		}
	}

	/** Send a command without waiting for a response. */
	send(command: Record<string, unknown>): void {
		if (!this.proc?.stdin || typeof this.proc.stdin === "number") return;
		// Bun.spawn stdin is a FileSink with .write(), not a WritableStream
		const sink = this.proc.stdin as { write(data: string): void; flush(): void };
		sink.write(`${JSON.stringify(command)}\n`);
		sink.flush();
	}

	/** Send a command and wait for the correlated response. */
	sendAndWait(
		command: Record<string, unknown>,
	): Promise<Record<string, unknown>> {
		const id = `req_${++this.nextId}`;
		return new Promise((resolve, reject) => {
			this.pendingRequests.set(id, { resolve, reject });
			this.send({ ...command, id });
		});
	}

	/** Register a listener for agent events (non-response messages). */
	onEvent(listener: EventListener): () => void {
		this.listeners.push(listener);
		return () => {
			const idx = this.listeners.indexOf(listener);
			if (idx >= 0) this.listeners.splice(idx, 1);
		};
	}

	get alive(): boolean {
		return this._alive;
	}

	kill(): void {
		this._alive = false;
		if (this.proc) {
			this.proc.kill();
			this.proc = null;
		}
		this.listeners.length = 0;
		for (const [, pending] of this.pendingRequests) {
			pending.reject(new Error("Process killed"));
		}
		this.pendingRequests.clear();
	}
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class PiSDKProvider implements AIProvider {
	readonly name = PROVIDER_NAME;
	readonly capabilities: AIProviderCapabilities = {
		// Pi RPC supports both via `switch_session` + `fork` commands
		// (pi/packages/coding-agent/src/modes/rpc/rpc-types.ts:58). The
		// resolver produces `fork_by_id` only when both `sessionPath` and a
		// user-message `entryId` are available on ctx.parent.
		fork: true,
		resume: true,
		streaming: true,
		tools: true,
	};
	models?: Array<{ id: string; label: string; default?: boolean }>;

	private config: PiSDKConfig;
	private sessions = new Map<string, PiSDKSession>();

	constructor(config: PiSDKConfig) {
		this.config = config;
	}

	async createSession(options: CreateSessionOptions): Promise<PiSDKSession> {
		const session = new PiSDKSession({
			systemPrompt: buildSystemPrompt(options.context),
			cwd: options.cwd ?? this.config.cwd ?? process.cwd(),
			parentSessionId: null,
			piExecutablePath: this.config.piExecutablePath ?? "pi",
			model: options.model ?? this.config.model,
		});
		this.sessions.set(session.id, session);
		return session;
	}

	async forkSession(options: CreateSessionOptions): Promise<PiSDKSession> {
		const parent = options.context.parent;
		if (!parent?.sessionPath || !parent?.entryId) {
			throw new Error(
				"Pi fork requires `sessionPath` and `entryId` on context.parent. " +
					"The resolver should produce `fork_by_id` only when both are available; " +
					"a launch without `entryId` should produce `resume_by_id` instead.",
			);
		}
		const session = new PiSDKSession({
			// Fork inherits the parent's conversation history via RPC; no need
			// to inject a system prompt on top.
			systemPrompt: null,
			cwd: options.cwd ?? parent.cwd ?? this.config.cwd ?? process.cwd(),
			parentSessionId: parent.sessionId ?? null,
			piExecutablePath: this.config.piExecutablePath ?? "pi",
			model: options.model ?? this.config.model,
			initialRpcCommands: [
				{ type: "switch_session", sessionPath: parent.sessionPath },
				{ type: "fork", entryId: parent.entryId },
			],
		});
		this.sessions.set(session.id, session);
		return session;
	}

	async resumeSession(sessionPath: string): Promise<PiSDKSession> {
		// Pi's "session id" for our purposes is its JSONL file path — that's
		// what RPC `switch_session` takes. The resolver's `resume_by_id`
		// strategy surfaces the path as `threadId`, and the endpoint layer
		// passes it here.
		if (!sessionPath) {
			throw new Error("Pi resumeSession requires a session path.");
		}
		const session = new PiSDKSession({
			systemPrompt: null,
			cwd: this.config.cwd ?? process.cwd(),
			parentSessionId: null,
			piExecutablePath: this.config.piExecutablePath ?? "pi",
			model: this.config.model,
			initialRpcCommands: [
				{ type: "switch_session", sessionPath },
			],
		});
		this.sessions.set(session.id, session);
		return session;
	}

	async listForkCandidates(cwd: string, limit = 5): Promise<ForkCandidate[]> {
		return listPiForkCandidates(cwd, limit);
	}

	dispose(): void {
		for (const session of this.sessions.values()) {
			session.killProcess();
		}
		this.sessions.clear();
	}

	/** Fetch available models from Pi. Call before registering the provider. */
	async fetchModels(): Promise<void> {
		const piPath = this.config.piExecutablePath ?? "pi";

		let proc: PiProcess | undefined;

		try {
			proc = new PiProcess();
			await proc.spawn(piPath, this.config.cwd ?? process.cwd());

			const data = await Promise.race([
				proc.sendAndWait({ type: "get_available_models" }),
				new Promise<never>((_, reject) =>
					setTimeout(() => reject(new Error("Timeout")), 10_000),
				),
			]);

			const rawModels = (
				data as {
					models?: Array<{ provider: string; id: string; name?: string }>;
				}
			).models;
			if (rawModels && rawModels.length > 0) {
				this.models = rawModels.map((m, i) => ({
					id: `${m.provider}/${m.id}`,
					label: m.name ?? m.id,
					...(i === 0 && { default: true }),
				}));
			}
		} catch {
			// Pi not configured or no models available
		} finally {
			proc?.kill();
		}
	}
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

interface SessionConfig {
	/**
	 * System prompt injected on the first query as a prompt preamble. Set to
	 * null for resume/fork paths — the inherited session history already
	 * contains the relevant context, and prepending the plan/diff again
	 * would confuse the model.
	 */
	systemPrompt: string | null;
	cwd: string;
	parentSessionId: string | null;
	piExecutablePath: string;
	/** Model in "provider/modelId" format, e.g. "anthropic/claude-haiku-4-5". */
	model?: string;
	/**
	 * RPC commands to send immediately after the subprocess spawns, before
	 * the first prompt. Used by fork (`switch_session` then `fork`) and
	 * resume (`switch_session` only). Failures are fatal to the session.
	 */
	initialRpcCommands?: Array<Record<string, unknown>>;
}

class PiSDKSession extends BaseSession {
	private config: SessionConfig;
	private process: PiProcess | null = null;

	constructor(config: SessionConfig) {
		super({ parentSessionId: config.parentSessionId });
		this.config = config;
	}

	async *query(prompt: string): AsyncIterable<AIMessage> {
		const started = this.startQuery();
		if (!started) {
			yield BaseSession.BUSY_ERROR;
			return;
		}
		const { gen } = started;

		try {
			// Lazy-spawn subprocess
			if (!this.process || !this.process.alive) {
				this.process = new PiProcess();
				await this.process.spawn(this.config.piExecutablePath, this.config.cwd);

				// Run init RPC commands first (switch_session / fork) so the
				// subsequent set_model / get_state / prompt all operate against
				// the correct session. Failures here are fatal — the caller
				// asked to fork from a specific anchor and there's no safe
				// way to proceed if that doesn't land.
				if (this.config.initialRpcCommands?.length) {
					for (const cmd of this.config.initialRpcCommands) {
						try {
							await this.process.sendAndWait(cmd);
						} catch (err) {
							const kind =
								typeof cmd.type === "string" ? cmd.type : "rpc";
							// Kill the subprocess so a subsequent query doesn't
							// silently land on whatever partial state the failed
							// init left behind (switch_session applied but fork
							// rejected → prompts go to the wrong session). Next
							// query re-spawns and re-attempts init.
							this.process?.kill();
							this.process = null;
							yield {
								type: "error",
								error: `Pi ${kind} failed: ${err instanceof Error ? err.message : String(err)}`,
								code: "pi_init_error",
							};
							return;
						}
					}
				}

				// Set model if specified (format: "provider/modelId")
				if (this.config.model) {
					const [provider, ...rest] = this.config.model.split("/");
					const modelId = rest.join("/");
					if (provider && modelId) {
						try {
							await this.process.sendAndWait({
								type: "set_model",
								provider,
								modelId,
							});
						} catch {
							// Continue with Pi's default model
						}
					}
				}

				// Get session ID
				try {
					const state = await this.process.sendAndWait({ type: "get_state" });
					if (typeof state.sessionId === "string") {
						this.resolveId(state.sessionId);
					}
				} catch {
					// Continue with placeholder ID
				}

				// If subprocess died during startup, surface the error immediately
				if (!this.process.alive) {
					yield {
						type: "error",
						error:
							"Pi process exited during startup. Check that Pi is configured correctly (API keys, models).",
						code: "pi_startup_error",
					};
					return;
				}
			}

			// Build effective prompt (prepend system prompt on first query)
			const effectivePrompt = buildEffectivePrompt(
				prompt,
				this.config.systemPrompt,
				this._firstQuerySent,
			);

			// Set up async queue to bridge callback events → async iterable
			const queue: AIMessage[] = [];
			let resolve: (() => void) | null = null;
			let done = false;

			const push = (msg: AIMessage) => {
				queue.push(msg);
				resolve?.();
			};

			const finish = () => {
				done = true;
				resolve?.();
			};

			const unsubscribe = this.process.onEvent((event) => {
				const mapped = mapPiEvent(event, this.id);
				for (const msg of mapped) {
					push(msg);
					if (
						msg.type === "result" ||
						(msg.type === "error" &&
							(event.type === "agent_end" || event.type === "process_exited"))
					) {
						finish();
					}
				}
			});

			// Send prompt — use sendAndWait to catch RPC-level rejections
			// (e.g. expired credentials, invalid session)
			try {
				await this.process.sendAndWait({
					type: "prompt",
					message: effectivePrompt,
				});
			} catch (err) {
				unsubscribe();
				yield {
					type: "error",
					error: `Pi rejected prompt: ${err instanceof Error ? err.message : String(err)}`,
					code: "pi_prompt_rejected",
				};
				return;
			}
			this._firstQuerySent = true;

			// Drain queue
			try {
				while (!done || queue.length > 0) {
					if (queue.length > 0) {
						yield queue.shift()!;
					} else {
						await new Promise<void>((r) => {
							resolve = r;
						});
						resolve = null;
					}
				}
			} finally {
				unsubscribe();
			}
		} catch (err) {
			yield {
				type: "error",
				error: err instanceof Error ? err.message : String(err),
				code: "provider_error",
			};
		} finally {
			this.endQuery(gen);
		}
	}

	abort(): void {
		if (this.process?.alive) {
			this.process.send({ type: "abort" });
		}
		super.abort();
	}

	/** Kill the subprocess. Called by the provider on dispose. */
	killProcess(): void {
		this.process?.kill();
		this.process = null;
	}
}

// ---------------------------------------------------------------------------
// Event mapping — shared with pi-sdk-node.ts
// ---------------------------------------------------------------------------

import { mapPiEvent } from "./pi-events.ts";
export { mapPiEvent } from "./pi-events.ts";

// ---------------------------------------------------------------------------
// Fork-candidate scanning — shared with pi-sdk-node.ts
// ---------------------------------------------------------------------------

/**
 * Scan Pi's `~/.pi/agent/sessions/--{cwd-encoded}--/` directory for
 * `.jsonl` session files matching this cwd. For each, extract the last
 * user-message entry id (the anchor Pi's fork RPC requires).
 *
 * If no user entry is found, the candidate falls back to `resume`
 * inheritance (switch-session only, no fork) which Pi's resumeSession
 * handles by setting `initialRpcCommands: [{switch_session}]`.
 */
export async function listPiForkCandidates(
	cwd: string,
	limit = 5,
): Promise<ForkCandidate[]> {
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	const fs = require("node:fs") as typeof import("node:fs");
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	const path = require("node:path") as typeof import("node:path");
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	const os = require("node:os") as typeof import("node:os");

	const safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
	const sessionDir = path.join(os.homedir(), ".pi", "agent", "sessions", safePath);
	if (!fs.existsSync(sessionDir)) return [];

	let names: string[];
	try {
		names = fs.readdirSync(sessionDir).filter((n) => n.endsWith(".jsonl"));
	} catch {
		return [];
	}

	const paths = names
		.map((n) => path.join(sessionDir, n))
		.map((p) => {
			try { return { p, mtime: fs.statSync(p).mtimeMs }; } catch { return null; }
		})
		.filter((x): x is { p: string; mtime: number } => x !== null)
		.sort((a, b) => b.mtime - a.mtime)
		.slice(0, limit);

	const candidates: ForkCandidate[] = [];
	for (const { p, mtime } of paths) {
		const { sessionId, lastUserEntryId, preview } = inspectPiSessionFile(fs, p);
		if (!sessionId) continue;
		candidates.push({
			id: sessionId,
			label: "Pi session",
			lastActiveAt: mtime,
			preview,
			parentFields: lastUserEntryId
				? { sessionId, sessionPath: p, entryId: lastUserEntryId, cwd }
				: { sessionPath: p, cwd },
			inheritance: lastUserEntryId ? "fork" : "resume",
		});
	}
	return candidates;
}

function inspectPiSessionFile(
	fs: typeof import("node:fs"),
	filePath: string,
): { sessionId: string | null; lastUserEntryId: string | null; preview?: string } {
	try {
		const content = fs.readFileSync(filePath, "utf8");
		const lines = content.split("\n").filter((l) => l.trim().length > 0);
		if (lines.length === 0) return { sessionId: null, lastUserEntryId: null };
		let sessionId: string | null = null;
		let lastUserEntryId: string | null = null;
		let preview: string | undefined;
		for (const line of lines) {
			try {
				const entry = JSON.parse(line) as Record<string, unknown>;
				if (!sessionId && entry.type === "session" && typeof entry.id === "string") {
					sessionId = entry.id;
				}
				const msg = entry.message as { role?: string; content?: unknown } | undefined;
				if (msg?.role === "user") {
					if (typeof entry.id === "string") lastUserEntryId = entry.id;
					if (typeof msg.content === "string") {
						preview = msg.content;
					} else if (Array.isArray(msg.content)) {
						for (const block of msg.content) {
							if (
								block && typeof block === "object"
								&& (block as { type?: string }).type === "text"
								&& typeof (block as { text?: string }).text === "string"
							) {
								preview = (block as { text: string }).text;
								break;
							}
						}
					}
				}
			} catch {
				/* skip malformed */
			}
		}
		return {
			sessionId,
			lastUserEntryId,
			preview: preview ? truncate(preview, 120) : undefined,
		};
	} catch {
		return { sessionId: null, lastUserEntryId: null };
	}
}

function truncate(s: string, max: number): string {
	const flat = s.replace(/\s+/g, " ").trim();
	return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
}

// ---------------------------------------------------------------------------
// Factory registration
// ---------------------------------------------------------------------------

import { registerProviderFactory } from "../provider.ts";

registerProviderFactory(
	PROVIDER_NAME,
	async (config) => new PiSDKProvider(config as PiSDKConfig),
);
