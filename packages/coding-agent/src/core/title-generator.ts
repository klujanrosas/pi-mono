/**
 * Auto session title generation.
 *
 * Calls a small Anthropic model (default: claude-opus-4-7) to produce a
 * short terminal-tab title from the recent conversation. Designed to run
 * after every `agent_end` and to be safe to abort mid-flight.
 *
 * The generator never throws: failures resolve to `null` so the caller can
 * leave the existing title untouched.
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { type AssistantMessage, completeSimple, type Message, type Model } from "@mariozechner/pi-ai";
import { serializeConversation } from "./compaction/utils.js";
import { convertToLlm } from "./messages.js";
import type { ModelRegistry } from "./model-registry.js";
import type { SessionManager } from "./session-manager.js";

/** Model id used by the auto-title generator. */
export const AUTO_TITLE_MODEL_ID = "claude-opus-4-7";
/** Provider id used by the auto-title generator. */
export const AUTO_TITLE_PROVIDER_ID = "anthropic";
/** Maximum length, in characters, of a generated title. */
export const AUTO_TITLE_MAX_CHARS = 48;
/**
 * Maximum number of characters of conversation context fed to the model.
 * Keeps requests cheap and fast; the most recent exchanges matter more
 * than older history for picking a good title.
 */
export const AUTO_TITLE_CONTEXT_CHARS = 6000;

export const AUTO_TITLE_SYSTEM_PROMPT =
	"You name terminal tabs for an interactive coding session. " +
	"Reply with EXACTLY one short title, 3 to 6 words, Title Case, no quotes, no punctuation, no emoji, no trailing period. " +
	"Describe the active task, not the tools or the assistant. " +
	"If a current title is supplied and still describes the work, repeat it verbatim. " +
	"Output ONLY the title on a single line. No prefixes such as 'Title:'.";

export interface GenerateSessionTitleOptions {
	/** Model to call. Should be claude-opus-4-7 from anthropic in production. */
	model: Model<any>;
	/** API key (typically a refreshed Anthropic OAuth access token). */
	apiKey: string;
	/** Optional headers (provider-specific). */
	headers?: Record<string, string>;
	/** Recent agent messages. Older messages are dropped to fit budget. */
	messages: AgentMessage[];
	/** Existing session title, if any. Empty string treated as no title. */
	currentTitle?: string;
	/** Abort signal to cancel the request. */
	signal?: AbortSignal;
}

export interface GenerateSessionTitleResult {
	/** Sanitized title returned by the model. Always non-empty. */
	title: string;
	/** True when `title` differs (after trimming) from `currentTitle`. */
	changed: boolean;
}

/**
 * Generate a short terminal-tab title for the current session.
 *
 * Returns `null` on any failure (network error, empty response, no usable
 * messages). Callers should leave the existing title in place when this
 * returns `null`.
 */
export async function generateSessionTitle(
	options: GenerateSessionTitleOptions,
): Promise<GenerateSessionTitleResult | null> {
	const { model, apiKey, headers, messages, currentTitle, signal } = options;
	if (signal?.aborted) {
		return null;
	}
	if (!Array.isArray(messages) || messages.length === 0) {
		return null;
	}

	const llmMessages = convertToLlm(messages);
	if (llmMessages.length === 0) {
		return null;
	}

	const conversationText = truncateConversation(serializeConversation(llmMessages), AUTO_TITLE_CONTEXT_CHARS);
	if (!conversationText.trim()) {
		return null;
	}

	const trimmedCurrent = currentTitle?.trim() ?? "";
	const promptParts: string[] = [];
	if (trimmedCurrent) {
		promptParts.push(`<current-title>${trimmedCurrent}</current-title>`);
	}
	promptParts.push(`<conversation>\n${conversationText}\n</conversation>`);
	promptParts.push(
		trimmedCurrent
			? "Reply with the new title, or repeat the existing title verbatim if it still fits."
			: "Reply with the new title.",
	);
	const promptText = promptParts.join("\n\n");

	const userMessages: Message[] = [
		{
			role: "user",
			content: [{ type: "text", text: promptText }],
			timestamp: Date.now(),
		},
	];

	let response: AssistantMessage;
	try {
		response = await completeSimple(
			model,
			{ systemPrompt: AUTO_TITLE_SYSTEM_PROMPT, messages: userMessages },
			{
				maxTokens: 64,
				apiKey,
				headers,
				signal,
				...(model.reasoning ? { reasoning: "minimal" as const } : {}),
			},
		);
	} catch {
		return null;
	}

	if (response.stopReason === "error" || response.stopReason === "aborted") {
		return null;
	}

	const rawText = response.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("");
	const title = sanitizeTitle(rawText);
	if (!title) {
		return null;
	}

	return {
		title,
		changed: title !== trimmedCurrent,
	};
}

/**
 * Trim and clean a model-produced title.
 *
 * - Takes the first non-empty line.
 * - Strips wrapping quotes/backticks.
 * - Drops a leading "Title:" / "Tab:" prefix the model sometimes adds.
 * - Removes trailing terminal punctuation.
 * - Caps length at AUTO_TITLE_MAX_CHARS.
 *
 * Exported for testing.
 */
export function sanitizeTitle(raw: string): string {
	if (!raw) return "";
	const firstLine = raw.split(/\r?\n/).find((line) => line.trim().length > 0);
	if (!firstLine) return "";
	let title = firstLine.trim();
	title = title.replace(/^(?:title|tab|session|name)\s*[:-]\s*/i, "").trim();
	title = title.replace(/^[\s"'`*_]+|[\s"'`*_]+$/g, "");
	title = title.replace(/\s+/g, " ");
	title = title.replace(/[.,;:!?\u3002\uFF0E]+$/g, "").trim();
	if (title.length > AUTO_TITLE_MAX_CHARS) {
		title = title.slice(0, AUTO_TITLE_MAX_CHARS).trim();
	}
	return title;
}

/**
 * Keep the tail of the conversation so the model focuses on recent context.
 * Exported for testing.
 */
export function truncateConversation(text: string, maxChars: number): string {
	if (text.length <= maxChars) {
		return text;
	}
	return `[... earlier conversation truncated]\n\n${text.slice(text.length - maxChars)}`;
}

export interface AutoTitleCycleOptions {
	sessionManager: SessionManager;
	modelRegistry: ModelRegistry;
	messages: AgentMessage[];
	signal?: AbortSignal;
	/** Override the model id (for tests). Defaults to AUTO_TITLE_MODEL_ID. */
	modelId?: string;
	/** Override the provider id (for tests). Defaults to AUTO_TITLE_PROVIDER_ID. */
	providerId?: string;
}

export type AutoTitleCycleResult =
	| { status: "applied"; title: string; previousTitle: string | undefined }
	| { status: "unchanged"; title: string }
	| { status: "skipped"; reason: AutoTitleSkipReason };

export type AutoTitleSkipReason =
	| "no-messages"
	| "manual-name-set"
	| "model-missing"
	| "no-oauth"
	| "auth-unavailable"
	| "aborted"
	| "generation-failed";

/**
 * Run a single auto-title cycle: check eligibility, call the generator, and
 * persist the result. Returns a structured outcome so callers (and tests) can
 * react. Never throws.
 */
export async function runAutoTitleCycle(options: AutoTitleCycleOptions): Promise<AutoTitleCycleResult> {
	const {
		sessionManager,
		modelRegistry,
		messages,
		signal,
		modelId = AUTO_TITLE_MODEL_ID,
		providerId = AUTO_TITLE_PROVIDER_ID,
	} = options;

	if (signal?.aborted) {
		return { status: "skipped", reason: "aborted" };
	}
	if (!messages || messages.length === 0) {
		return { status: "skipped", reason: "no-messages" };
	}

	const source = sessionManager.getSessionNameSource();
	if (source !== undefined && source !== "auto") {
		return { status: "skipped", reason: "manual-name-set" };
	}

	const model = modelRegistry.find(providerId, modelId);
	if (!model) {
		return { status: "skipped", reason: "model-missing" };
	}
	if (!modelRegistry.isUsingOAuth(model)) {
		return { status: "skipped", reason: "no-oauth" };
	}

	const auth = await modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok || !auth.apiKey) {
		return { status: "skipped", reason: "auth-unavailable" };
	}

	if (signal?.aborted) {
		return { status: "skipped", reason: "aborted" };
	}

	const previousTitle = sessionManager.getSessionName();
	const result = await generateSessionTitle({
		model,
		apiKey: auth.apiKey,
		headers: auth.headers,
		messages,
		currentTitle: previousTitle,
		signal,
	});

	if (!result) {
		return { status: "skipped", reason: "generation-failed" };
	}
	if (signal?.aborted) {
		return { status: "skipped", reason: "aborted" };
	}

	// Re-check the source so a manual /name issued mid-flight wins the race.
	const sourceAfter = sessionManager.getSessionNameSource();
	if (sourceAfter !== undefined && sourceAfter !== "auto") {
		return { status: "skipped", reason: "manual-name-set" };
	}

	if (!result.changed) {
		return { status: "unchanged", title: result.title };
	}

	sessionManager.appendSessionInfo(result.title, "auto");
	return { status: "applied", title: result.title, previousTitle };
}
