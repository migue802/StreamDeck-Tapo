import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { Redraws, REDRAW_INTERVAL_MS } from "../src/render/redraw.js";
import { TapoError } from "../src/tapo/client.js";
import type { TapoClient } from "../src/tapo/client.js";
import { DeviceState, POLL_MAX_MS, POLL_MS } from "../src/tapo/state.js";
import type { DeviceInfo } from "../src/tapo/types.js";

const info = (overrides: Partial<DeviceInfo> = {}): DeviceInfo => ({
	device_id: "id",
	model: "L900",
	fw_ver: "1.0",
	nickname: "",
	ssid: "",
	rssi: -50,
	device_on: true,
	brightness: 50,
	hue: 0,
	saturation: 100,
	color_temp: 0,
	...overrides,
});

/** Lets the promise chains started by a timer run to completion. */
async function settle(): Promise<void> {
	for (let i = 0; i < 10; i++) {
		await Promise.resolve();
	}
}

/** A fake strip whose answer the test can change, counting how often it is asked. */
function strip(): { client: TapoClient; reads: () => number; answer: (next: () => DeviceInfo) => void } {
	let reads = 0;
	let answer = (): DeviceInfo => info();
	const client = {
		getInfo: async () => {
			reads++;
			return answer();
		},
		setInfo: async () => undefined,
	} as unknown as TapoClient;
	return { client, reads: () => reads, answer: (next) => (answer = next) };
}

describe("DeviceState polling", () => {
	beforeEach(() => mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 }));
	afterEach(() => mock.timers.reset());

	it("reads the strip only while something is subscribed", async () => {
		const fake = strip();
		const state = new DeviceState(() => fake.client);

		mock.timers.tick(POLL_MS * 3);
		await settle();
		assert.equal(fake.reads(), 0, "nothing subscribed, nothing read");

		const unsubscribe = state.subscribe(() => undefined);
		for (let i = 0; i < 3; i++) {
			mock.timers.tick(POLL_MS);
			await settle();
		}
		assert.equal(fake.reads(), 3);

		unsubscribe();
		mock.timers.tick(POLL_MS * 3);
		await settle();
		assert.equal(fake.reads(), 3, "polling stops with the last subscriber");
	});

	it("broadcasts a change made elsewhere, and stays quiet when nothing visible changed", async () => {
		const fake = strip();
		const state = new DeviceState(() => fake.client);
		const seen: Array<boolean | undefined> = [];
		state.subscribe((reading) => seen.push(reading?.device_on));

		mock.timers.tick(POLL_MS);
		await settle();
		// Only the Wi-Fi signal moved: not worth redrawing any key for.
		fake.answer(() => info({ rssi: -70 }));
		mock.timers.tick(POLL_MS);
		await settle();
		// Switched off from the Tapo app.
		fake.answer(() => info({ device_on: false }));
		mock.timers.tick(POLL_MS);
		await settle();

		assert.deepEqual(seen, [true, false]);
	});

	it("does not read back over a write that just happened", async () => {
		const fake = strip();
		const state = new DeviceState(() => fake.client);
		state.subscribe(() => undefined);
		await state.get();
		const before = fake.reads();

		mock.timers.tick(POLL_MS - 500);
		await state.set({ brightness: 80 });
		mock.timers.tick(500);
		await settle();

		assert.equal(fake.reads(), before, "the poll found the cache fresh from the write");
	});

	it("backs off from an unreachable strip, shows it as unknown, and recovers", async () => {
		const fake = strip();
		const health: unknown[] = [];
		const state = new DeviceState(() => fake.client, { onPollHealth: (err) => health.push(err) });
		const seen: Array<DeviceInfo | undefined> = [];
		state.subscribe((reading) => seen.push(reading));

		mock.timers.tick(POLL_MS);
		await settle();
		assert.equal(seen.length, 1);

		fake.answer(() => {
			throw new TapoError("Cannot reach the device", "network");
		});
		// Failures at 5s, then 10s, 20s, 40s, and from there every 60s.
		let elapsed = 0;
		for (const wait of [POLL_MS, POLL_MS * 2, POLL_MS * 4, POLL_MS * 8, POLL_MAX_MS, POLL_MAX_MS]) {
			mock.timers.tick(wait);
			elapsed += wait;
			await settle();
		}
		assert.equal(fake.reads(), 1 + 6, `six failed reads over ${elapsed / 1000}s`);
		assert.equal(health.length, 1, "logged once, not on every failure");
		assert.equal(seen.at(-1), undefined, "the keys show the strip as unknown");

		fake.answer(() => info());
		mock.timers.tick(POLL_MAX_MS);
		await settle();
		assert.equal(health.length, 2);
		assert.equal(health[1], undefined, "recovery is reported");
		assert.equal(seen.at(-1)?.device_on, true);

		mock.timers.tick(POLL_MS);
		await settle();
		assert.equal(fake.reads(), 1 + 6 + 2, "back to the normal interval");
	});

	it("waits quietly while the strip is not configured", async () => {
		const health: unknown[] = [];
		const state = new DeviceState(
			() => {
				throw new TapoError("not configured", "config");
			},
			{ onPollHealth: (err) => health.push(err) },
		);
		state.subscribe(() => undefined);

		mock.timers.tick(POLL_MS * 4);
		await settle();
		assert.deepEqual(health, []);
	});
});

describe("Redraws", () => {
	beforeEach(() => mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 }));
	afterEach(() => mock.timers.reset());

	it("keeps a fast dial within ten updates a second and still ends on its last value", async () => {
		const redraws = new Redraws();
		const drawn: number[] = [];

		// A second of a fast turn: a tick every 10ms.
		for (let value = 1; value <= 100; value++) {
			redraws.request("dial", async () => void drawn.push(value));
			mock.timers.tick(10);
		}
		mock.timers.tick(REDRAW_INTERVAL_MS);
		await settle();

		assert.ok(drawn.length <= 11, `drew ${drawn.length} times`);
		assert.equal(drawn[0], 1, "the first tick draws at once");
		assert.equal(drawn.at(-1), 100, "the final value is never dropped");
	});

	it("keeps instances independent, and drops a forgotten one's pending redraw", async () => {
		const redraws = new Redraws();
		const drawn: string[] = [];

		redraws.request("a", async () => void drawn.push("a1"));
		redraws.request("b", async () => void drawn.push("b1"));
		redraws.request("a", async () => void drawn.push("a2"));
		redraws.forget("a");
		mock.timers.tick(REDRAW_INTERVAL_MS);
		await settle();

		assert.deepEqual(drawn, ["a1", "b1"]);
	});
});
