import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hexToHueSat } from "../src/actions/color.js";

describe("hexToHueSat", () => {
	it("maps the primaries and secondaries onto the hue wheel", () => {
		assert.deepEqual(hexToHueSat("#ff0000"), { hue: 0, saturation: 100 });
		assert.deepEqual(hexToHueSat("#ffff00"), { hue: 60, saturation: 100 });
		assert.deepEqual(hexToHueSat("#00ff00"), { hue: 120, saturation: 100 });
		assert.deepEqual(hexToHueSat("#00ffff"), { hue: 180, saturation: 100 });
		assert.deepEqual(hexToHueSat("#0000ff"), { hue: 240, saturation: 100 });
		assert.deepEqual(hexToHueSat("#ff00ff"), { hue: 300, saturation: 100 });
	});

	it("reads saturation from HSV, so brightness is left to the strip's own setting", () => {
		// Mid-grey is unsaturated; a dark but pure red is still fully saturated, because
		// HSV keeps value separate. HSL would report 100% for both, which is wrong here.
		assert.equal(hexToHueSat("#808080").saturation, 0);
		assert.equal(hexToHueSat("#800000").saturation, 100);
		assert.equal(hexToHueSat("#800000").hue, 0);
	});

	it("expands three-digit shorthand", () => {
		assert.deepEqual(hexToHueSat("#f00"), hexToHueSat("#ff0000"));
		assert.deepEqual(hexToHueSat("#0f0"), hexToHueSat("#00ff00"));
	});

	it("accepts input with or without the leading hash, and with padding", () => {
		assert.deepEqual(hexToHueSat("ff0000"), { hue: 0, saturation: 100 });
		assert.deepEqual(hexToHueSat("  #ff0000  "), { hue: 0, saturation: 100 });
	});

	it("is case insensitive", () => {
		assert.deepEqual(hexToHueSat("#FF00FF"), hexToHueSat("#ff00ff"));
	});

	it("falls back to red rather than emitting a value the strip would reject", () => {
		for (const bad of ["", "#12345", "nonsense", "#gggggg", "#12345678"]) {
			assert.deepEqual(hexToHueSat(bad), { hue: 0, saturation: 100 }, `input: ${JSON.stringify(bad)}`);
		}
	});

	it("never emits hue 360, which the strip treats as out of range", () => {
		// A hue that rounds up to 360 must wrap to 0. Sweep the near-magenta/red boundary.
		for (let blue = 0; blue <= 6; blue++) {
			const hex = `#ff00${blue.toString(16).padStart(2, "0")}`;
			const { hue } = hexToHueSat(hex);
			assert.ok(hue >= 0 && hue < 360, `${hex} produced hue ${hue}`);
		}
	});

	it("keeps every output inside the ranges the strip accepts", () => {
		for (let i = 0; i < 512; i++) {
			// Deterministic sweep across the cube, no RNG so failures reproduce.
			const hex =
				"#" +
				[(i * 37) % 256, (i * 89) % 256, (i * 151) % 256]
					.map((c) => c.toString(16).padStart(2, "0"))
					.join("");
			const { hue, saturation } = hexToHueSat(hex);

			assert.ok(Number.isInteger(hue) && hue >= 0 && hue <= 359, `${hex} -> hue ${hue}`);
			assert.ok(Number.isInteger(saturation) && saturation >= 0 && saturation <= 100, `${hex} -> sat ${saturation}`);
		}
	});
});
