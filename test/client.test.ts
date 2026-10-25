import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { userHash } from "../src/tapo/klap.js";
import { TapoClient, TapoError } from "../src/tapo/client.js";
import type { DeviceInfo } from "../src/tapo/types.js";

const EMAIL = "test@example.com";
const PASSWORD = "hunter2";

// Resolved from the working directory: the tests run from a build output directory
// that does not contain the mock script itself.
const MOCK = path.resolve(process.cwd(), "test", "mock_device.py");

/** Boots a mock device, waiting until it reports it is listening. */
async function startDevice(port: number, extraArgs: string[] = []): Promise<ChildProcess> {
	const proc = spawn(
		"python",
		[MOCK, "--port", String(port), "--email", EMAIL, "--password", PASSWORD, ...extraArgs],
		{ stdio: ["ignore", "pipe", "pipe"] },
	);

	let stderr = "";
	proc.stderr!.on("data", (d: Buffer) => (stderr += d.toString()));

	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`mock device did not start. stderr:\n${stderr}`)), 10000);
		proc.stdout!.on("data", (d: Buffer) => {
			if (d.toString().includes("mock device on")) {
				clearTimeout(timer);
				resolve();
			}
		});
		proc.on("exit", (code) => {
			clearTimeout(timer);
			reject(new Error(`mock device exited early (${code}). stderr:\n${stderr}`));
		});
	});

	return proc;
}

describe("TapoClient against a mock KLAP device", () => {
	let device: ChildProcess;
	const port = 9971;

	before(async () => {
		device = await startDevice(port);
	});
	after(() => device?.kill());

	it("completes the handshake and reads device info", async () => {
		const client = new TapoClient(`127.0.0.1:${port}`, userHash(EMAIL, PASSWORD));
		await client.login();
		assert.equal(client.isConnected, true);

		const info = await client.getInfo();
		assert.equal(info.model, "L900-5");
		assert.equal(typeof info.device_on, "boolean");
	});

	it("writes state that reads back", async () => {
		const client = new TapoClient(`127.0.0.1:${port}`, userHash(EMAIL, PASSWORD));
		await client.setInfo({ device_on: true, brightness: 73 });

		const info = await client.getInfo();
		assert.equal(info.device_on, true);
		assert.equal(info.brightness, 73);
	});

	it("logs in lazily on the first request", async () => {
		const client = new TapoClient(`127.0.0.1:${port}`, userHash(EMAIL, PASSWORD));
		assert.equal(client.isConnected, false);
		await client.getInfo();
		assert.equal(client.isConnected, true);
	});

	it("rejects a wrong password without retrying", async () => {
		const client = new TapoClient(`127.0.0.1:${port}`, userHash(EMAIL, "wrong-password"));
		await assert.rejects(
			() => client.getInfo(),
			(err: unknown) => err instanceof TapoError && err.kind === "auth",
		);
	});

	it("reports an unreachable device as a network error", async () => {
		// Port 9 is the discard service; nothing is listening in the test environment.
		const client = new TapoClient("127.0.0.1:9", userHash(EMAIL, PASSWORD));
		await assert.rejects(
			() => client.getInfo(),
			(err: unknown) => err instanceof TapoError && err.kind === "network",
		);
	});

	it("serializes concurrent requests so the sequence stays ordered", async () => {
		const client = new TapoClient(`127.0.0.1:${port}`, userHash(EMAIL, PASSWORD));
		await client.login();

		// Fired together; if the sequence raced, the device would reject some of these.
		const results = await Promise.all(
			Array.from({ length: 12 }, (_, i) => client.setInfo({ brightness: i + 1 }).then(() => "ok")),
		);
		assert.deepEqual(results, Array(12).fill("ok"));

		const info = await client.getInfo();
		assert.equal(info.brightness, 12);
	});

	it("survives one failure and keeps serving later requests", async () => {
		const client = new TapoClient(`127.0.0.1:${port}`, userHash(EMAIL, PASSWORD));
		await client.login();

		await assert.rejects(() => client.request("no_such_method"));
		// A poisoned queue would make this hang or reject too.
		const info = await client.getInfo();
		assert.equal(info.model, "L900-5");
	});
});

describe("session recovery", () => {
	it("re-handshakes and retries when the session lapses", async () => {
		const port = 9972;
		const device = await startDevice(port, ["--expire-after", "1"]);
		try {
			const client = new TapoClient(`127.0.0.1:${port}`, userHash(EMAIL, PASSWORD));

			const first = await client.getInfo();
			assert.equal(first.model, "L900-5");

			// The device has now dropped the session. The client should notice and recover.
			const second = await client.getInfo();
			assert.equal(second.model, "L900-5");
		} finally {
			device.kill();
		}
	});
});

describe("session cookie", () => {
	it("sends TP_SESSIONID on requests", async () => {
		const port = 9973;
		const device = await startDevice(port, ["--require-cookie"]);
		try {
			const client = new TapoClient(`127.0.0.1:${port}`, userHash(EMAIL, PASSWORD));
			const info: DeviceInfo = await client.getInfo();
			assert.equal(info.model, "L900-5");
		} finally {
			device.kill();
		}
	});
});
