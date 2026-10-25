import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { KeyImages } from "../src/render/images.js";
import { hsvToRgb, kelvinToRgb, lightColor, toggleKey, toHex } from "../src/render/keys.js";
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

describe("key colours", () => {
	it("converts hue and saturation the way the strip means them", () => {
		assert.equal(toHex(hsvToRgb(0, 100)), "#ff0000");
		assert.equal(toHex(hsvToRgb(120, 100)), "#00ff00");
		assert.equal(toHex(hsvToRgb(240, 100)), "#0000ff");
		assert.equal(toHex(hsvToRgb(360, 100)), "#ff0000");
		// Saturation 0 is white, not grey: brightness is the strip's own, separate setting.
		assert.equal(toHex(hsvToRgb(200, 0)), "#ffffff");
	});

	it("runs colour temperature from warm to cool", () => {
		const [warmR, , warmB] = kelvinToRgb(2500);
		const [coolR, , coolB] = kelvinToRgb(9000);
		assert.ok(warmR > warmB, "2500K should be orange");
		assert.ok(coolB > coolR, "9000K should be blue-ish");
		assert.equal(toHex(kelvinToRgb(6600)), "#ffffff");
	});

	it("reads the strip's mode: an effect, white, or a colour", () => {
		assert.deepEqual(lightColor(info({ lighting_effect: { enable: 1 } })), { kind: "effect" });
		assert.deepEqual(lightColor(info({ color_temp: 6600 })), { kind: "solid", rgb: kelvinToRgb(6600) });
		assert.deepEqual(lightColor(info({ hue: 240, saturation: 100 })), { kind: "solid", rgb: hsvToRgb(240, 100) });
	});
});

describe("toggle key", () => {
	it("draws the strip's colour while it is on", () => {
		assert.match(toggleKey(info({ hue: 240 })), /stroke="#0000ff"/);
		assert.match(toggleKey(info({ lighting_effect: { enable: true } })), /url\(#rainbow\)/);
	});

	it("draws no colour while off or unknown", () => {
		for (const image of [toggleKey(info({ device_on: false, hue: 240 })), toggleKey(undefined)]) {
			assert.doesNotMatch(image, /#0000ff|rainbow/);
		}
	});

	it("changes with brightness, so a dimmed strip redraws its key", () => {
		assert.notEqual(toggleKey(info({ brightness: 20 })), toggleKey(info({ brightness: 90 })));
	});
});

describe("KeyImages", () => {
	it("sends an image once, and again after the key reappears", async () => {
		const sent: string[] = [];
		const key = { id: "a", setImage: async (image?: string) => void sent.push(image ?? "") };
		const images = new KeyImages();

		await images.show(key, "one");
		await images.show(key, "one");
		await images.show(key, "two");
		images.forget("a");
		await images.show(key, "two");

		const url = (svg: string): string => `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
		assert.deepEqual(sent, [url("one"), url("two"), url("two")]);
	});
});
