/**
 * Unit + integration tests for the auto session title generator.
 *
 * Covers:
 * - sanitizeTitle / truncateConversation pure helpers
 * - generateSessionTitle against the faux provider (success, abort, error)
 * - runAutoTitleCycle orchestration: skip reasons, manual override, persistence
 *
 * No real provider APIs or network calls.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FauxResponseStep, fauxAssistantMessage, type Model, registerFauxProvider } from "@mariozechner/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { SessionManager } from "../src/core/session-manager.js";
import {
	AUTO_TITLE_MAX_CHARS,
	AUTO_TITLE_MODEL_ID,
	AUTO_TITLE_PROVIDER_ID,
	type AutoTitleCycleResult,
	generateSessionTitle,
	runAutoTitleCycle,
	sanitizeTitle,
	truncateConversation,
} from "../src/core/title-generator.js";

const FAR_FUTURE = Date.now() + 1_000_000_000;

function createAssistantUserPair(userText: string, assistantText: string) {
	return [
		{
			role: "user" as const,
			content: [{ type: "text" as const, text: userText }],
			timestamp: Date.now(),
		},
		{
			role: "assistant" as const,
			content: [{ type: "text" as const, text: assistantText }],
			api: "faux",
			provider: AUTO_TITLE_PROVIDER_ID,
			model: AUTO_TITLE_MODEL_ID,
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop" as const,
			timestamp: Date.now(),
		},
	];
}

interface TestRig {
	authStorage: AuthStorage;
	modelRegistry: ModelRegistry;
	sessionManager: SessionManager;
	model: Model<string>;
	setResponses: (responses: FauxResponseStep[]) => void;
	cleanup: () => void;
}

function createRig(options: { withOAuth?: boolean; sessionManager?: SessionManager } = {}): TestRig {
	const withOAuth = options.withOAuth ?? true;
	const faux = registerFauxProvider({
		provider: AUTO_TITLE_PROVIDER_ID,
		models: [
			{
				id: AUTO_TITLE_MODEL_ID,
				name: "Claude Opus 4.7 (faux)",
				reasoning: true,
				input: ["text", "image"],
				cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
				contextWindow: 200000,
				maxTokens: 8192,
			},
		],
	});

	const authStorage = AuthStorage.inMemory();
	if (withOAuth) {
		authStorage.set(AUTO_TITLE_PROVIDER_ID, {
			type: "oauth",
			access: "test-access-token",
			refresh: "test-refresh-token",
			expires: FAR_FUTURE,
		});
	}

	const modelRegistry = ModelRegistry.inMemory(authStorage);
	const fauxModel = faux.getModel();
	modelRegistry.registerProvider(AUTO_TITLE_PROVIDER_ID, {
		baseUrl: fauxModel.baseUrl,
		apiKey: "fallback-test-key",
		api: faux.api,
		models: faux.models.map((m) => ({
			id: m.id,
			name: m.name,
			api: m.api,
			reasoning: m.reasoning,
			input: m.input,
			cost: m.cost,
			contextWindow: m.contextWindow,
			maxTokens: m.maxTokens,
			baseUrl: m.baseUrl,
		})),
	});

	const model = modelRegistry.find(AUTO_TITLE_PROVIDER_ID, AUTO_TITLE_MODEL_ID);
	if (!model) throw new Error("Failed to register faux anthropic model for tests");

	return {
		authStorage,
		modelRegistry,
		sessionManager: options.sessionManager ?? SessionManager.inMemory(),
		model,
		setResponses: faux.setResponses,
		cleanup: () => faux.unregister(),
	};
}

describe("sanitizeTitle", () => {
	it("returns empty string for empty/whitespace input", () => {
		expect(sanitizeTitle("")).toBe("");
		expect(sanitizeTitle("   ")).toBe("");
		expect(sanitizeTitle("\n\n\n")).toBe("");
	});

	it("trims whitespace", () => {
		expect(sanitizeTitle("  Refactor auth flow  ")).toBe("Refactor auth flow");
	});

	it("uses only the first non-empty line", () => {
		expect(sanitizeTitle("\n\nRefactor auth flow\nExtra commentary")).toBe("Refactor auth flow");
	});

	it("strips wrapping quotes, backticks, asterisks, underscores", () => {
		expect(sanitizeTitle('"Refactor auth flow"')).toBe("Refactor auth flow");
		expect(sanitizeTitle("`Refactor auth flow`")).toBe("Refactor auth flow");
		expect(sanitizeTitle("**Refactor auth flow**")).toBe("Refactor auth flow");
		expect(sanitizeTitle("'Refactor auth flow'")).toBe("Refactor auth flow");
	});

	it("strips a leading 'Title:' / 'Tab:' / 'Session:' prefix", () => {
		expect(sanitizeTitle("Title: Refactor auth flow")).toBe("Refactor auth flow");
		expect(sanitizeTitle("Tab - Refactor auth flow")).toBe("Refactor auth flow");
		expect(sanitizeTitle("session: refactor")).toBe("refactor");
		expect(sanitizeTitle("Name: Pick a path")).toBe("Pick a path");
	});

	it("collapses internal whitespace", () => {
		expect(sanitizeTitle("Refactor   auth\tflow")).toBe("Refactor auth flow");
	});

	it("strips trailing punctuation", () => {
		expect(sanitizeTitle("Refactor auth flow.")).toBe("Refactor auth flow");
		expect(sanitizeTitle("Refactor!?.")).toBe("Refactor");
	});

	it("caps length at AUTO_TITLE_MAX_CHARS", () => {
		const long = "X".repeat(AUTO_TITLE_MAX_CHARS + 20);
		const sanitized = sanitizeTitle(long);
		expect(sanitized.length).toBeLessThanOrEqual(AUTO_TITLE_MAX_CHARS);
	});

	it("handles models echoing the prefix and quotes together", () => {
		expect(sanitizeTitle('Title: "Implement title generator"')).toBe("Implement title generator");
	});
});

describe("truncateConversation", () => {
	it("returns input unchanged when within limit", () => {
		expect(truncateConversation("hello world", 100)).toBe("hello world");
	});

	it("keeps the tail when exceeding the limit", () => {
		const input = "abcdefghij".repeat(50); // 500 chars
		const result = truncateConversation(input, 100);
		expect(result.length).toBeGreaterThan(100);
		expect(result.startsWith("[... earlier conversation truncated]")).toBe(true);
		expect(result.endsWith(input.slice(-100))).toBe(true);
	});
});

describe("generateSessionTitle", () => {
	let rig: TestRig;

	beforeEach(() => {
		rig = createRig();
	});

	afterEach(() => {
		rig.cleanup();
	});

	it("returns null when messages is empty", async () => {
		const result = await generateSessionTitle({
			model: rig.model,
			apiKey: "key",
			messages: [],
		});
		expect(result).toBeNull();
	});

	it("returns null when signal already aborted", async () => {
		const abort = new AbortController();
		abort.abort();
		const result = await generateSessionTitle({
			model: rig.model,
			apiKey: "key",
			messages: createAssistantUserPair("hi", "hello"),
			signal: abort.signal,
		});
		expect(result).toBeNull();
	});

	it("returns null when the conversation has no extractable text", async () => {
		const result = await generateSessionTitle({
			model: rig.model,
			apiKey: "key",
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: "" }],
					timestamp: Date.now(),
				},
			],
		});
		expect(result).toBeNull();
	});

	it("returns null when the provider responds with an error", async () => {
		rig.setResponses([fauxAssistantMessage("boom", { stopReason: "error", errorMessage: "bad" })]);
		const result = await generateSessionTitle({
			model: rig.model,
			apiKey: "key",
			messages: createAssistantUserPair("debug auth flow", "ok"),
		});
		expect(result).toBeNull();
	});

	it("returns sanitized title and changed=true on first success", async () => {
		rig.setResponses([fauxAssistantMessage('"Debug Auth Flow"\n')]);
		const result = await generateSessionTitle({
			model: rig.model,
			apiKey: "key",
			messages: createAssistantUserPair("debug auth flow", "ok"),
		});
		expect(result).toEqual({ title: "Debug Auth Flow", changed: true });
	});

	it("returns changed=false when the model echoes the current title", async () => {
		rig.setResponses([fauxAssistantMessage("Debug Auth Flow")]);
		const result = await generateSessionTitle({
			model: rig.model,
			apiKey: "key",
			messages: createAssistantUserPair("more work", "still on auth"),
			currentTitle: "Debug Auth Flow",
		});
		expect(result).toEqual({ title: "Debug Auth Flow", changed: false });
	});

	it("includes the current title in the prompt when provided", async () => {
		let observedSystem: string | undefined;
		let observedUserText: string | undefined;
		rig.setResponses([
			(context) => {
				observedSystem = context.systemPrompt;
				const userMsg = context.messages[0];
				if (userMsg?.role === "user" && Array.isArray(userMsg.content)) {
					const textBlock = userMsg.content.find((c): c is { type: "text"; text: string } => c.type === "text");
					observedUserText = textBlock?.text;
				}
				return fauxAssistantMessage("Refactor Title Generator");
			},
		]);
		await generateSessionTitle({
			model: rig.model,
			apiKey: "key",
			messages: createAssistantUserPair("refactor", "done"),
			currentTitle: "Old Title",
		});
		expect(observedSystem).toContain("terminal tabs");
		expect(observedUserText).toContain("<current-title>Old Title</current-title>");
		expect(observedUserText).toContain("<conversation>");
		expect(observedUserText).toContain("repeat the existing title verbatim");
	});

	it("does not include current-title block when none is provided", async () => {
		let observedUserText: string | undefined;
		rig.setResponses([
			(context) => {
				const userMsg = context.messages[0];
				if (userMsg?.role === "user" && Array.isArray(userMsg.content)) {
					const textBlock = userMsg.content.find((c): c is { type: "text"; text: string } => c.type === "text");
					observedUserText = textBlock?.text;
				}
				return fauxAssistantMessage("First Title");
			},
		]);
		await generateSessionTitle({
			model: rig.model,
			apiKey: "key",
			messages: createAssistantUserPair("hi", "hello"),
		});
		expect(observedUserText).not.toContain("<current-title>");
		expect(observedUserText).toContain("<conversation>");
	});
});

describe("runAutoTitleCycle", () => {
	let rig: TestRig;

	afterEach(() => {
		rig?.cleanup();
	});

	it("skips with no-messages when message list is empty", async () => {
		rig = createRig();
		const result = await runAutoTitleCycle({
			sessionManager: rig.sessionManager,
			modelRegistry: rig.modelRegistry,
			messages: [],
		});
		expect(result).toEqual({ status: "skipped", reason: "no-messages" });
	});

	it("skips with aborted when signal is already aborted", async () => {
		rig = createRig();
		const abort = new AbortController();
		abort.abort();
		const result = await runAutoTitleCycle({
			sessionManager: rig.sessionManager,
			modelRegistry: rig.modelRegistry,
			messages: createAssistantUserPair("hi", "hello"),
			signal: abort.signal,
		});
		expect(result).toEqual({ status: "skipped", reason: "aborted" });
	});

	it("skips with manual-name-set when latest session_info is user-sourced", async () => {
		rig = createRig();
		rig.sessionManager.appendSessionInfo("Hand Picked", "user");
		rig.setResponses([fauxAssistantMessage("Should Not Apply")]);
		const result = await runAutoTitleCycle({
			sessionManager: rig.sessionManager,
			modelRegistry: rig.modelRegistry,
			messages: createAssistantUserPair("hi", "hello"),
		});
		expect(result).toEqual({ status: "skipped", reason: "manual-name-set" });
		// Manual name preserved
		expect(rig.sessionManager.getSessionName()).toBe("Hand Picked");
	});

	it("treats omitted source on legacy entries as user", async () => {
		const tempDir = join(tmpdir(), `pi-title-legacy-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		try {
			const path = join(tempDir, "session.jsonl");
			const lines = [
				{ type: "session", id: "s1", version: 3, timestamp: new Date().toISOString(), cwd: tempDir },
				{
					type: "session_info",
					id: "legacy-1",
					parentId: null,
					timestamp: new Date().toISOString(),
					name: "Legacy Name",
				},
			];
			writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`, "utf8");
			rig = createRig({ sessionManager: SessionManager.open(path) });
			rig.setResponses([fauxAssistantMessage("Should Not Apply")]);
			const result = await runAutoTitleCycle({
				sessionManager: rig.sessionManager,
				modelRegistry: rig.modelRegistry,
				messages: createAssistantUserPair("hi", "hello"),
			});
			expect(result).toEqual({ status: "skipped", reason: "manual-name-set" });
			expect(rig.sessionManager.getSessionName()).toBe("Legacy Name");
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("skips with model-missing when the requested model is not registered", async () => {
		rig = createRig();
		const result = await runAutoTitleCycle({
			sessionManager: rig.sessionManager,
			modelRegistry: rig.modelRegistry,
			messages: createAssistantUserPair("hi", "hello"),
			modelId: "model-does-not-exist",
		});
		expect(result).toEqual({ status: "skipped", reason: "model-missing" });
	});

	it("skips with no-oauth when the provider has no OAuth credential", async () => {
		rig = createRig({ withOAuth: false });
		rig.setResponses([fauxAssistantMessage("Whatever")]);
		const result = await runAutoTitleCycle({
			sessionManager: rig.sessionManager,
			modelRegistry: rig.modelRegistry,
			messages: createAssistantUserPair("hi", "hello"),
		});
		expect(result).toEqual({ status: "skipped", reason: "no-oauth" });
	});

	it("skips with generation-failed when the provider returns an error", async () => {
		rig = createRig();
		rig.setResponses([fauxAssistantMessage("boom", { stopReason: "error", errorMessage: "bad" })]);
		const result = await runAutoTitleCycle({
			sessionManager: rig.sessionManager,
			modelRegistry: rig.modelRegistry,
			messages: createAssistantUserPair("hi", "hello"),
		});
		expect(result).toEqual({ status: "skipped", reason: "generation-failed" });
		expect(rig.sessionManager.getSessionName()).toBeUndefined();
	});

	it("applies the title and persists an auto-sourced session_info entry on first success", async () => {
		rig = createRig();
		rig.setResponses([fauxAssistantMessage('"Wire Auto Titles"')]);
		const result = await runAutoTitleCycle({
			sessionManager: rig.sessionManager,
			modelRegistry: rig.modelRegistry,
			messages: createAssistantUserPair("plan auto title feature", "ok"),
		});
		expect(result).toEqual({
			status: "applied",
			title: "Wire Auto Titles",
			previousTitle: undefined,
		} satisfies AutoTitleCycleResult);
		expect(rig.sessionManager.getSessionName()).toBe("Wire Auto Titles");
		expect(rig.sessionManager.getSessionNameSource()).toBe("auto");
	});

	it("returns unchanged when the model returns the same title we already have", async () => {
		rig = createRig();
		rig.sessionManager.appendSessionInfo("Stable Title", "auto");
		rig.setResponses([fauxAssistantMessage("Stable Title")]);
		const result = await runAutoTitleCycle({
			sessionManager: rig.sessionManager,
			modelRegistry: rig.modelRegistry,
			messages: createAssistantUserPair("more work", "still"),
		});
		expect(result).toEqual({ status: "unchanged", title: "Stable Title" });
		// No new session_info entry was appended.
		const infoEntries = rig.sessionManager.getEntries().filter((e) => e.type === "session_info");
		expect(infoEntries).toHaveLength(1);
	});

	it("replaces an existing auto-sourced title when the topic drifts", async () => {
		rig = createRig();
		rig.sessionManager.appendSessionInfo("Initial Title", "auto");
		rig.setResponses([fauxAssistantMessage("Brand New Topic")]);
		const result = await runAutoTitleCycle({
			sessionManager: rig.sessionManager,
			modelRegistry: rig.modelRegistry,
			messages: createAssistantUserPair("switch tasks", "ack"),
		});
		expect(result).toEqual({
			status: "applied",
			title: "Brand New Topic",
			previousTitle: "Initial Title",
		} satisfies AutoTitleCycleResult);
		expect(rig.sessionManager.getSessionName()).toBe("Brand New Topic");
		expect(rig.sessionManager.getSessionNameSource()).toBe("auto");
	});

	it("does not overwrite a manual title set mid-flight", async () => {
		rig = createRig();
		// Resolve the response only after the test marks the session manually.
		let releaseResponse: () => void = () => {};
		const responseGate = new Promise<void>((resolve) => {
			releaseResponse = resolve;
		});
		rig.setResponses([
			async () => {
				await responseGate;
				return fauxAssistantMessage("Auto Generated");
			},
		]);

		const cyclePromise = runAutoTitleCycle({
			sessionManager: rig.sessionManager,
			modelRegistry: rig.modelRegistry,
			messages: createAssistantUserPair("hi", "ok"),
		});

		// User runs /name while the request is in flight.
		rig.sessionManager.appendSessionInfo("User Picked", "user");
		releaseResponse();

		const result = await cyclePromise;
		expect(result).toEqual({ status: "skipped", reason: "manual-name-set" });
		expect(rig.sessionManager.getSessionName()).toBe("User Picked");
		expect(rig.sessionManager.getSessionNameSource()).toBe("user");
	});
});
