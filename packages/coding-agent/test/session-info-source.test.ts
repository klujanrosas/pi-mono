/**
 * Tests for the `source` field on SessionInfoEntry.
 *
 * Covers default behaviour, explicit auto/user values, persistence to/from
 * disk, and back-compat with legacy entries that lack the field.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type SessionInfoEntry, SessionManager } from "../src/core/session-manager.js";

let tempDir: string;

beforeEach(() => {
	tempDir = join(tmpdir(), `pi-session-info-source-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(tempDir, { recursive: true });
});

afterEach(() => {
	rmSync(tempDir, { recursive: true, force: true });
});

describe("SessionManager.appendSessionInfo source field", () => {
	it("defaults to source='user' when omitted", () => {
		const mgr = SessionManager.inMemory();
		mgr.appendSessionInfo("My Session");
		const entries = mgr.getEntries().filter((e): e is SessionInfoEntry => e.type === "session_info");
		expect(entries).toHaveLength(1);
		expect(entries[0].name).toBe("My Session");
		expect(entries[0].source).toBe("user");
	});

	it("records explicit source='user'", () => {
		const mgr = SessionManager.inMemory();
		mgr.appendSessionInfo("Manual Name", "user");
		const entry = mgr.getEntries().find((e): e is SessionInfoEntry => e.type === "session_info");
		expect(entry?.source).toBe("user");
	});

	it("records explicit source='auto'", () => {
		const mgr = SessionManager.inMemory();
		mgr.appendSessionInfo("Auto Name", "auto");
		const entry = mgr.getEntries().find((e): e is SessionInfoEntry => e.type === "session_info");
		expect(entry?.source).toBe("auto");
	});

	it("trims whitespace from the name regardless of source", () => {
		const mgr = SessionManager.inMemory();
		mgr.appendSessionInfo("   Spaced Name   ", "auto");
		const entry = mgr.getEntries().find((e): e is SessionInfoEntry => e.type === "session_info");
		expect(entry?.name).toBe("Spaced Name");
	});
});

describe("SessionManager.getSessionNameSource", () => {
	it("returns undefined when no session_info entry exists", () => {
		const mgr = SessionManager.inMemory();
		expect(mgr.getSessionNameSource()).toBeUndefined();
	});

	it("returns 'user' for the latest user-sourced entry", () => {
		const mgr = SessionManager.inMemory();
		mgr.appendSessionInfo("Name", "user");
		expect(mgr.getSessionNameSource()).toBe("user");
	});

	it("returns 'auto' for the latest auto-sourced entry", () => {
		const mgr = SessionManager.inMemory();
		mgr.appendSessionInfo("Name", "auto");
		expect(mgr.getSessionNameSource()).toBe("auto");
	});

	it("returns the source of the LATEST entry (auto then user)", () => {
		const mgr = SessionManager.inMemory();
		mgr.appendSessionInfo("Auto Name", "auto");
		mgr.appendSessionInfo("Manual Name", "user");
		expect(mgr.getSessionNameSource()).toBe("user");
		expect(mgr.getSessionName()).toBe("Manual Name");
	});

	it("returns the source of the LATEST entry (user then auto)", () => {
		const mgr = SessionManager.inMemory();
		mgr.appendSessionInfo("Manual Name", "user");
		mgr.appendSessionInfo("Auto Name", "auto");
		expect(mgr.getSessionNameSource()).toBe("auto");
		expect(mgr.getSessionName()).toBe("Auto Name");
	});

	it("treats a legacy on-disk entry without `source` as 'user' for safety", () => {
		const path = join(tempDir, `legacy-${Date.now()}.jsonl`);
		const lines = [
			{ type: "session", id: "s1", version: 3, timestamp: new Date().toISOString(), cwd: tempDir },
			{
				type: "session_info",
				id: "legacy-1",
				parentId: null,
				timestamp: new Date().toISOString(),
				name: "Legacy",
			},
		];
		writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`, "utf8");
		const mgr = SessionManager.open(path);
		expect(mgr.getSessionName()).toBe("Legacy");
		expect(mgr.getSessionNameSource()).toBe("user");
	});

	it("returns the most recent source even when an earlier entry was a clear", () => {
		const mgr = SessionManager.inMemory();
		mgr.appendSessionInfo("First", "auto");
		mgr.appendSessionInfo("", "user"); // explicit clear
		expect(mgr.getSessionName()).toBeUndefined();
		expect(mgr.getSessionNameSource()).toBe("user");
	});
});

describe("SessionInfoEntry persistence on disk", () => {
	function createSessionFile(): string {
		const path = join(tempDir, `session-${Date.now()}.jsonl`);
		writeFileSync(
			path,
			`${JSON.stringify({
				type: "session",
				id: "test-session",
				version: 3,
				timestamp: new Date().toISOString(),
				cwd: tempDir,
			})}\n`,
			"utf8",
		);

		// SessionManager only persists once it has seen at least one assistant message.
		const seed = SessionManager.open(path);
		seed.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "seed" }],
			api: "faux",
			provider: "faux",
			model: "faux",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		});

		return path;
	}

	it("round-trips source='auto' through SessionManager.open()", () => {
		const path = createSessionFile();
		const mgr = SessionManager.open(path);
		mgr.appendSessionInfo("Auto Generated Title", "auto");

		// Reopen and check
		const reopened = SessionManager.open(path);
		expect(reopened.getSessionName()).toBe("Auto Generated Title");
		expect(reopened.getSessionNameSource()).toBe("auto");

		// Verify on disk
		const lines = readFileSync(path, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		const infoEntries = lines.filter((entry: { type?: string }) => entry?.type === "session_info");
		expect(infoEntries).toHaveLength(1);
		expect(infoEntries[0]).toMatchObject({ name: "Auto Generated Title", source: "auto" });
	});

	it("round-trips source='user' through SessionManager.open()", () => {
		const path = createSessionFile();
		const mgr = SessionManager.open(path);
		mgr.appendSessionInfo("Hand Written", "user");

		const reopened = SessionManager.open(path);
		expect(reopened.getSessionName()).toBe("Hand Written");
		expect(reopened.getSessionNameSource()).toBe("user");
	});

	it("treats sessions written before the source field as user-sourced", () => {
		const path = createSessionFile();
		// Append a legacy session_info entry by hand (no source field).
		const legacyEntry = {
			type: "session_info",
			id: "legacy-1",
			parentId: null,
			timestamp: new Date().toISOString(),
			name: "Legacy Manual Title",
		};
		writeFileSync(path, `${readFileSync(path, "utf8")}${JSON.stringify(legacyEntry)}\n`, "utf8");

		const mgr = SessionManager.open(path);
		expect(mgr.getSessionName()).toBe("Legacy Manual Title");
		expect(mgr.getSessionNameSource()).toBe("user");
	});

	it("preserves the latest auto title when reopening even if older user entries exist", () => {
		const path = createSessionFile();
		const mgr = SessionManager.open(path);
		mgr.appendSessionInfo("Old Manual", "user");
		mgr.appendSessionInfo("Newer Auto", "auto");

		const reopened = SessionManager.open(path);
		expect(reopened.getSessionName()).toBe("Newer Auto");
		expect(reopened.getSessionNameSource()).toBe("auto");
	});
});
