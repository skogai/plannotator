/**
 * Pi SDK provider — Node.js variant.
 *
 * Identical to pi-sdk.ts except PiProcess uses child_process.spawn()
 * instead of Bun.spawn(). Everything else (PiSDKProvider, PiSDKSession,
 * mapPiEvent) is re-exported from the Bun version unchanged.
 *
 * Used by the Pi extension which runs under jiti (Node.js).
 */

import { spawn, type ChildProcess } from "node:child_process";
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
import { registerProviderFactory } from "../provider.ts";
import { listPiForkCandidates } from "./pi-sdk.ts";

// Re-export mapPiEvent from shared (runtime-agnostic)
export { mapPiEvent } from "./pi-events.ts";

const PROVIDER_NAME = "pi-sdk";

// ---------------------------------------------------------------------------
// JSONL subprocess wrapper (Node.js)
// ---------------------------------------------------------------------------

type EventListener = (event: Record<string, unknown>) => void;

class PiProcessNode {
	private proc: ChildProcess | null = null;
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
		this.proc = spawn(piPath, ["--mode", "rpc"], {
			cwd,
			stdio: ["pipe", "pipe", "pipe"],
		});
		this._alive = true;

		this.readStream();

		this.proc.on("exit", () => {
			this._alive = false;
			for (const [, pending] of this.pendingRequests) {
				pending.reject(new Error("Pi process exited unexpectedly"));
			}
			this.pendingRequests.clear();
			for (const listener of this.listeners) {
				listener({ type: "process_exited" });
			}
		});
	}

	private readStream(): void {
		if (!this.proc?.stdout) return;

		this.proc.stdout.on("data", (chunk: Buffer) => {
			this.buffer += chunk.toString();
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
		});
	}

	private routeMessage(msg: Record<string, unknown>): void {
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

		for (const listener of this.listeners) {
			listener(msg);
		}
	}

	send(command: Record<string, unknown>): void {
		if (!this.proc?.stdin || this.proc.stdin.destroyed) return;
		this.proc.stdin.write(`${JSON.stringify(command)}\n`);
	}

	sendAndWait(
		command: Record<string, unknown>,
	): Promise<Record<string, unknown>> {
		const id = `req_${++this.nextId}`;
		return new Promise((resolve, reject) => {
			this.pendingRequests.set(id, { resolve, reject });
			this.send({ ...command, id });
		});
	}

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
// Provider (identical to pi-sdk.ts, using PiProcessNode)
// ---------------------------------------------------------------------------

export class PiSDKNodeProvider implements AIProvider {
	readonly name = PROVIDER_NAME;
	readonly capabilities: AIProviderCapabilities = {
		// See pi-sdk.ts for rationale. Pi RPC supports fork/switch_session;
		// the resolver chooses fork_by_id vs resume_by_id based on whether
		// a user-message entryId is available on the launch metadata.
		fork: true,
		resume: true,
		streaming: true,
		tools: true,
	};
	models?: Array<{ id: string; label: string; default?: boolean }>;

	private config: PiSDKConfig;
	private sessions = new Map<string, PiSDKNodeSession>();

	constructor(config: PiSDKConfig) {
		this.config = config;
	}

	async createSession(options: CreateSessionOptions): Promise<PiSDKNodeSession> {
		const session = new PiSDKNodeSession({
			systemPrompt: buildSystemPrompt(options.context),
			cwd: options.cwd ?? this.config.cwd ?? process.cwd(),
			parentSessionId: null,
			piExecutablePath: this.config.piExecutablePath ?? "pi",
			model: options.model ?? this.config.model,
		});
		this.sessions.set(session.id, session);
		return session;
	}

	async forkSession(options: CreateSessionOptions): Promise<PiSDKNodeSession> {
		const parent = options.context.parent;
		if (!parent?.sessionPath || !parent?.entryId) {
			throw new Error(
				"Pi fork requires `sessionPath` and `entryId` on context.parent. " +
					"The resolver should produce `fork_by_id` only when both are available; " +
					"a launch without `entryId` should produce `resume_by_id` instead.",
			);
		}
		const session = new PiSDKNodeSession({
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

	async resumeSession(sessionPath: string): Promise<PiSDKNodeSession> {
		if (!sessionPath) {
			throw new Error("Pi resumeSession requires a session path.");
		}
		const session = new PiSDKNodeSession({
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

	async fetchModels(): Promise<void> {
		const piPath = this.config.piExecutablePath ?? "pi";
		let proc: PiProcessNode | undefined;
		try {
			proc = new PiProcessNode();
			await proc.spawn(piPath, this.config.cwd ?? process.cwd());
			const data = await Promise.race([
				proc.sendAndWait({ type: "get_available_models" }),
				new Promise<never>((_, reject) =>
					setTimeout(() => reject(new Error("Timeout")), 10_000),
				),
			]);
			const rawModels = (
				data as { models?: Array<{ provider: string; id: string; name?: string }> }
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
// Session (identical to pi-sdk.ts, using PiProcessNode)
// ---------------------------------------------------------------------------

interface SessionConfig {
	systemPrompt: string | null;
	cwd: string;
	parentSessionId: string | null;
	piExecutablePath: string;
	model?: string;
	/** See pi-sdk.ts. Init-time RPC commands run before the first prompt. */
	initialRpcCommands?: Array<Record<string, unknown>>;
}

class PiSDKNodeSession extends BaseSession {
	private config: SessionConfig;
	private process: PiProcessNode | null = null;

	constructor(config: SessionConfig) {
		super({ parentSessionId: config.parentSessionId });
		this.config = config;
	}

	async *query(prompt: string): AsyncIterable<AIMessage> {
		const { mapPiEvent } = await import("./pi-events.ts");

		const started = this.startQuery();
		if (!started) {
			yield BaseSession.BUSY_ERROR;
			return;
		}
		const { gen } = started;

		try {
			if (!this.process || !this.process.alive) {
				this.process = new PiProcessNode();
				await this.process.spawn(this.config.piExecutablePath, this.config.cwd);

				// Init RPC (switch_session / fork) before set_model so the
				// subsequent state applies to the loaded-or-forked session.
				if (this.config.initialRpcCommands?.length) {
					for (const cmd of this.config.initialRpcCommands) {
						try {
							await this.process.sendAndWait(cmd);
						} catch (err) {
							const kind =
								typeof cmd.type === "string" ? cmd.type : "rpc";
							// Kill the subprocess so the next query doesn't
							// land on partial init state (e.g. switch_session
							// applied but fork rejected). See pi-sdk.ts for rationale.
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

				if (this.config.model) {
					const [provider, ...rest] = this.config.model.split("/");
					const modelId = rest.join("/");
					if (provider && modelId) {
						try {
							await this.process.sendAndWait({ type: "set_model", provider, modelId });
						} catch { /* Continue with Pi's default model */ }
					}
				}

				try {
					const state = await this.process.sendAndWait({ type: "get_state" });
					if (typeof state.sessionId === "string") {
						this.resolveId(state.sessionId);
					}
				} catch { /* Continue with placeholder ID */ }

				if (!this.process.alive) {
					yield {
						type: "error",
						error: "Pi process exited during startup. Check that Pi is configured correctly (API keys, models).",
						code: "pi_startup_error",
					};
					return;
				}
			}

			const effectivePrompt = buildEffectivePrompt(
				prompt,
				this.config.systemPrompt,
				this._firstQuerySent,
			);

			const queue: AIMessage[] = [];
			let resolve: (() => void) | null = null;
			let done = false;

			const push = (msg: AIMessage) => { queue.push(msg); resolve?.(); };
			const finish = () => { done = true; resolve?.(); };

			const unsubscribe = this.process.onEvent((event) => {
				const mapped = mapPiEvent(event, this.id);
				for (const msg of mapped) {
					push(msg);
					if (
						msg.type === "result" ||
						(msg.type === "error" && (event.type === "agent_end" || event.type === "process_exited"))
					) {
						finish();
					}
				}
			});

			try {
				await this.process.sendAndWait({ type: "prompt", message: effectivePrompt });
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

			try {
				while (!done || queue.length > 0) {
					if (queue.length > 0) {
						yield queue.shift()!;
					} else {
						await new Promise<void>((r) => { resolve = r; });
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

	killProcess(): void {
		this.process?.kill();
		this.process = null;
	}
}

// ---------------------------------------------------------------------------
// Factory registration
// ---------------------------------------------------------------------------

registerProviderFactory(
	PROVIDER_NAME,
	async (config) => new PiSDKNodeProvider(config as PiSDKConfig),
);
