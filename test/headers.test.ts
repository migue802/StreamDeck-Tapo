import assert from "node:assert/strict";
import net from "node:net";
import { describe, it } from "node:test";
import { userHash } from "../src/tapo/klap.js";
import { TapoClient } from "../src/tapo/client.js";

/**
 * Captures the raw bytes of the next HTTP request sent to a port, so the exact wire
 * format can be asserted on. The connection is closed without answering; the client is
 * expected to report that as a network failure.
 */
function captureRequest(port: number): { ready: Promise<void>; request: Promise<string> } {
	let resolveRequest: (value: string) => void;
	const request = new Promise<string>((resolve) => (resolveRequest = resolve));

	const server = net.createServer((socket) => {
		let data = "";
		socket.on("data", (chunk) => {
			data += chunk.toString("latin1");
			if (data.includes("\r\n\r\n")) {
				resolveRequest(data);
				socket.destroy();
				server.close();
			}
		});
	});

	const ready = new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
	return { ready, request };
}

describe("wire format", () => {
	/**
	 * The strip's HTTP parser matches `Content-Length` case-sensitively and answers 400 to
	 * the lowercase spelling. The fetch specification *requires* lowercased header names, so
	 * a switch back to `fetch` would break every request against real hardware while still
	 * passing tests that use a tolerant mock server. This test is the guard for that.
	 */
	it("sends Content-Length capitalised, as the strip demands", async () => {
		const port = 9961;
		const { ready, request } = captureRequest(port);
		await ready;

		const client = new TapoClient(`127.0.0.1:${port}`, userHash("a@b.com", "pw"));
		await assert.rejects(() => client.login());

		const raw = await request;
		const headers = raw.split("\r\n\r\n")[0].split("\r\n").slice(1);

		const contentLength = headers.find((h) => h.toLowerCase().startsWith("content-length:"));
		assert.ok(contentLength, `no Content-Length header sent. Request was:\n${raw}`);
		assert.ok(
			contentLength.startsWith("Content-Length:"),
			`Content-Length must be canonically capitalised, got: ${contentLength}`,
		);
	});

	it("posts the seed to /app/handshake1 with a 16-byte body", async () => {
		const port = 9962;
		const { ready, request } = captureRequest(port);
		await ready;

		const client = new TapoClient(`127.0.0.1:${port}`, userHash("a@b.com", "pw"));
		await assert.rejects(() => client.login());

		const raw = await request;
		assert.match(raw, /^POST \/app\/handshake1 HTTP\/1\.1\r\n/);
		assert.match(raw, /\r\nContent-Length: 16\r\n/);
	});
});
