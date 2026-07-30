import assert from "node:assert/strict";
import test from "node:test";

import singleImageRead from "../extensions/single-image-read.ts";

function loadHandlers() {
	const handlers = new Map();
	singleImageRead({
		on(name, handler) {
			handlers.set(name, handler);
		},
	});
	return handlers;
}

const read = (path) => ({ toolName: "read", input: { path } });

test("allows one image read and blocks later image reads in the same turn", () => {
	const handlers = loadHandlers();
	handlers.get("turn_start")();

	assert.equal(handlers.get("tool_call")(read("first.png")), undefined);
	assert.deepEqual(handlers.get("tool_call")(read("second.webp")), {
		block: true,
		reason: "Only one image may be read per assistant turn. Inspect the first image, then read another image on the next turn.",
	});
});

test("resets the image allowance on each turn", () => {
	const handlers = loadHandlers();
	handlers.get("turn_start")();
	handlers.get("tool_call")(read("first.jpg"));
	handlers.get("turn_start")();

	assert.equal(handlers.get("tool_call")(read("second.jpeg")), undefined);
});

test("does not count text reads or other tools", () => {
	const handlers = loadHandlers();
	handlers.get("turn_start")();

	assert.equal(handlers.get("tool_call")(read("notes.md")), undefined);
	assert.equal(handlers.get("tool_call")({ toolName: "generate_image", input: { path: "output.png" } }), undefined);
	assert.equal(handlers.get("tool_call")(read("preview.GIF")), undefined);
});
