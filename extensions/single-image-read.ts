import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const IMAGE_PATH_PATTERN = /\.(?:bmp|gif|jpe?g|png|webp)$/i;

function isImageRead(event: { toolName: string; input: unknown }): boolean {
	if (event.toolName !== "read" || !event.input || typeof event.input !== "object") return false;
	const path = (event.input as { path?: unknown }).path;
	return typeof path === "string" && IMAGE_PATH_PATTERN.test(path);
}

export default function singleImageRead(pi: ExtensionAPI) {
	let imageReadsThisTurn = 0;

	pi.on("turn_start", () => {
		imageReadsThisTurn = 0;
	});

	pi.on("tool_call", (event) => {
		if (!isImageRead(event)) return;
		imageReadsThisTurn += 1;
		if (imageReadsThisTurn === 1) return;

		return {
			block: true,
			reason: "Only one image may be read per assistant turn. Inspect the first image, then read another image on the next turn.",
		};
	});
}
