import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

const {
	discoverNotes,
	planGeneration,
	noteHash,
	run,
	MIN_BODY_LENGTH,
} = require("../generateSummaries");

const longBody = (label) =>
	`# ${label}\n\n${"Lorem ipsum dolor sit amet. ".repeat(40)}`;

let tmpDir;
let notesDir;
let cacheFile;
let outputFile;

const writeNote = (folder, name, content) => {
	const dir = path.join(notesDir, folder);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, `${name}.md`), content);
};

const okResponse = (text) => ({
	ok: true,
	status: 200,
	json: async () => ({ content: [{ type: "text", text }] }),
});

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "summaries-test-"));
	notesDir = path.join(tmpDir, "notes");
	cacheFile = path.join(tmpDir, ".cache", "summaries.json");
	outputFile = path.join(tmpDir, "_data", "summaries.json");
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("discoverNotes", () => {
	it("finds notes in summary folders and keys them by filePathStem", () => {
		writeNote("NPCs", "Elincia Flowers", `---\n{"dg-publish":true}\n---\n${longBody("Elincia")}`);
		writeNote("Sessions", "Session 1", longBody("Session"));

		const notes = discoverNotes(notesDir);
		expect(notes).toHaveLength(1);
		expect(notes[0].key).toBe("/notes/NPCs/Elincia Flowers");
		expect(notes[0].title).toBe("Elincia Flowers");
		expect(notes[0].hash).toBe(noteHash(notes[0].body));
	});

	it("skips notes with short bodies", () => {
		writeNote("NPCs", "Barry", "A short note.");
		expect("A short note.".length).toBeLessThan(MIN_BODY_LENGTH);
		expect(discoverNotes(notesDir)).toHaveLength(0);
	});

	it("parses frontmatter containing wiki-link \\| aliases", () => {
		writeNote(
			"NPCs",
			"Linked",
			`---\nrelated: "[[NPCs/Other\\|Other]]"\n---\n${longBody("Linked")}`,
		);
		expect(discoverNotes(notesDir)).toHaveLength(1);
	});
});

describe("planGeneration", () => {
	it("reuses cache entries with matching hashes and regenerates the rest", () => {
		const notes = [
			{ key: "/notes/NPCs/A", hash: "h1" },
			{ key: "/notes/NPCs/B", hash: "h2" },
		];
		const cache = {
			"/notes/NPCs/A": { hash: "h1", summary: "cached A" },
			"/notes/NPCs/B": { hash: "stale", summary: "cached B" },
		};
		const { reusable, toGenerate } = planGeneration(notes, cache);
		expect(Object.keys(reusable)).toEqual(["/notes/NPCs/A"]);
		expect(toGenerate.map((n) => n.key)).toEqual(["/notes/NPCs/B"]);
	});
});

describe("run", () => {
	it("generates summaries for new notes and caches them", async () => {
		writeNote("NPCs", "Elincia Flowers", longBody("Elincia"));
		const fetchImpl = vi.fn(async () => okResponse("A summary."));

		const result = await run({
			notesDir,
			cacheFile,
			outputFile,
			apiKey: "test-key",
			fetchImpl,
			log: () => {},
		});

		expect(result).toEqual({ generated: 1, failed: 0, total: 1 });
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		const output = JSON.parse(fs.readFileSync(outputFile, "utf8"));
		expect(output["/notes/NPCs/Elincia Flowers"]).toEqual({ summary: "A summary." });
		// Cache keeps the hash so the next build can skip this note.
		const cache = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
		expect(cache["/notes/NPCs/Elincia Flowers"].hash).toBeTruthy();
	});

	it("makes no API calls when nothing has changed", async () => {
		writeNote("NPCs", "Elincia Flowers", longBody("Elincia"));
		const fetchImpl = vi.fn(async () => okResponse("A summary."));
		const opts = { notesDir, cacheFile, outputFile, apiKey: "test-key", fetchImpl, log: () => {} };

		await run(opts);
		const second = await run(opts);

		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect(second).toEqual({ generated: 0, failed: 0, total: 1 });
	});

	it("reuses a stale summary when the API fails", async () => {
		writeNote("NPCs", "Elincia Flowers", longBody("Elincia"));
		fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
		fs.writeFileSync(
			cacheFile,
			JSON.stringify({ "/notes/NPCs/Elincia Flowers": { hash: "stale", summary: "Old summary." } }),
		);
		const fetchImpl = vi.fn(async () => ({ ok: false, status: 400, statusText: "Bad Request" }));

		const result = await run({ notesDir, cacheFile, outputFile, apiKey: "test-key", fetchImpl, log: () => {} });

		expect(result).toEqual({ generated: 0, failed: 1, total: 1 });
		const output = JSON.parse(fs.readFileSync(outputFile, "utf8"));
		expect(output["/notes/NPCs/Elincia Flowers"]).toEqual({ summary: "Old summary." });
	});

	it("emits cached summaries without API calls when no key is set", async () => {
		writeNote("NPCs", "Elincia Flowers", longBody("Elincia"));
		fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
		fs.writeFileSync(
			cacheFile,
			JSON.stringify({ "/notes/NPCs/Elincia Flowers": { hash: "stale", summary: "Old summary." } }),
		);
		const fetchImpl = vi.fn();

		const result = await run({ notesDir, cacheFile, outputFile, apiKey: undefined, fetchImpl, log: () => {} });

		expect(fetchImpl).not.toHaveBeenCalled();
		expect(result.total).toBe(1);
		const output = JSON.parse(fs.readFileSync(outputFile, "utf8"));
		expect(output["/notes/NPCs/Elincia Flowers"]).toEqual({ summary: "Old summary." });
	});
});
