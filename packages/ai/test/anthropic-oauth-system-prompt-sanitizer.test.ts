import { describe, expect, it } from "vitest";
import { sanitizeSystemPromptForOAuth } from "../src/providers/anthropic.js";

/**
 * Unit tests for the OAuth system-prompt sanitizer.
 *
 * When pi sends a request using a Claude Pro/Max OAuth token, the system
 * prompt must not identify the caller as a third-party harness. The sanitizer
 * strips pi's two default identity markers:
 *   1. The "operating inside pi, a coding agent harness" opening line.
 *   2. The "Pi documentation (read only ...)" section and its bullet list.
 *
 * Everything else — project context, custom prompts, skills, tool lists,
 * date/cwd footers — is left untouched.
 */
describe("sanitizeSystemPromptForOAuth", () => {
	const FULL_PROMPT = [
		"You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.",
		"",
		"Available tools:",
		"- read: Read a file",
		"- bash: Execute a bash command",
		"",
		"In addition to the tools above, you may have access to other custom tools depending on the project.",
		"",
		"Guidelines:",
		"- Be concise in your responses",
		"- Show file paths clearly when working with files",
		"",
		"Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):",
		"- Main documentation: /abs/path/to/readme.md",
		"- Additional docs: /abs/path/to/docs",
		"- Examples: /abs/path/to/examples (extensions, custom tools, SDK)",
		"- When asked about: extensions (docs/extensions.md, examples/extensions/), themes (docs/themes.md), skills (docs/skills.md), prompt templates (docs/prompt-templates.md), TUI components (docs/tui.md), keybindings (docs/keybindings.md), SDK integrations (docs/sdk.md), custom providers (docs/custom-provider.md), adding models (docs/models.md), pi packages (docs/packages.md)",
		"- When working on pi topics, read the docs and examples, and follow .md cross-references before implementing",
		"- Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)",
		"Current date: 2026-04-19",
		"Current working directory: /Users/test/project",
	].join("\n");

	it("removes the pi identity opening line", () => {
		const out = sanitizeSystemPromptForOAuth(FULL_PROMPT);
		expect(out).not.toMatch(/operating inside pi/);
		expect(out).not.toMatch(/coding agent harness/);
		expect(out.startsWith("Available tools:")).toBe(true);
	});

	it("removes the Pi documentation section and all of its bullets", () => {
		const out = sanitizeSystemPromptForOAuth(FULL_PROMPT);
		expect(out).not.toMatch(/Pi documentation/);
		expect(out).not.toMatch(/Additional docs:/);
		expect(out).not.toMatch(/When working on pi topics/);
		expect(out).not.toMatch(/Always read pi \.md files/);
	});

	it("preserves generic content after the Pi documentation section", () => {
		const out = sanitizeSystemPromptForOAuth(FULL_PROMPT);
		expect(out).toContain("Available tools:");
		expect(out).toContain("- bash: Execute a bash command");
		expect(out).toContain("Guidelines:");
		expect(out).toContain("Be concise in your responses");
		expect(out).toContain("Current date: 2026-04-19");
		expect(out).toContain("Current working directory: /Users/test/project");
	});

	it("collapses oversized whitespace gaps left by removals", () => {
		const out = sanitizeSystemPromptForOAuth(FULL_PROMPT);
		expect(out).not.toMatch(/\n{3,}/);
	});

	it("leaves user-provided AGENTS.md-style project context untouched", () => {
		const promptWithContext = [
			FULL_PROMPT,
			"",
			"# Project Context",
			"",
			"Project-specific instructions and guidelines:",
			"",
			"## AGENTS.md",
			"",
			"Do not use emojis. Run npm run check after every change.",
		].join("\n");

		const out = sanitizeSystemPromptForOAuth(promptWithContext);
		expect(out).toContain("# Project Context");
		expect(out).toContain("## AGENTS.md");
		expect(out).toContain("Do not use emojis. Run npm run check after every change.");
	});

	it("is a no-op on a custom prompt that never mentions pi", () => {
		const custom = [
			"You are a helpful assistant.",
			"",
			"Follow these rules:",
			"- Be concise.",
			"Current date: 2026-04-19",
		].join("\n");

		expect(sanitizeSystemPromptForOAuth(custom)).toBe(custom);
	});

	it("returns empty string unchanged", () => {
		expect(sanitizeSystemPromptForOAuth("")).toBe("");
	});

	it("does not match only-bullets (no anchor header) by accident", () => {
		const pseudo = [
			"Some other section:",
			"- Unrelated bullet",
			"- Another bullet mentioning pi somewhere in its body text",
			"",
			"Current date: 2026-04-19",
		].join("\n");

		// None of this should be touched because the "Pi documentation" anchor is
		// absent.
		expect(sanitizeSystemPromptForOAuth(pseudo)).toBe(pseudo);
	});
});
