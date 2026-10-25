import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TapoClient } from "../src/tapo/client.js";
import { DeviceState } from "../src/tapo/state.js";
import type { DeviceInfo } from "../src/tapo/types.js";

function fakeClient(reading: () => DeviceInfo): TapoClient {
	return {
		getInfo: async () => reading(),
		setInfo: async () => undefined,
	} as unknown as TapoClient;
}

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

describe("DeviceState", () => {
	it("does not rebroadcast a reading that changed nothing", async () => {
		// Every broadcast makes each key send a message to Stream Deck, so an unchanged
		// re-read must stay silent rather than redraw the whole profile.
		const state = new DeviceState(() => fakeClient(() => info()));
		let broadcasts = 0;
		state.subscribe(() => broadcasts++);

		await state.get(true);
		await state.get(true);
		await state.get(true);

		assert.equal(broadcasts, 1);
	});

	it("broadcasts when the strip actually changed", async () => {
		let brightness = 50;
		const state = new DeviceState(() => fakeClient(() => info({ brightness })));
		const seen: Array<number | undefined> = [];
		state.subscribe((reading) => seen.push(reading?.brightness));

		await state.get(true);
		brightness = 70;
		await state.get(true);
		await state.set({ brightness: 80 });
		await state.set({ brightness: 80 });

		assert.deepEqual(seen, [50, 70, 80]);
	});

	it("broadcasts an invalidation once", async () => {
		const state = new DeviceState(() => fakeClient(() => info()));
		const seen: Array<DeviceInfo | undefined> = [];
		await state.get(true);
		state.subscribe((reading) => seen.push(reading));

		state.invalidate();
		state.invalidate();

		assert.deepEqual(seen, [undefined]);
	});
});
