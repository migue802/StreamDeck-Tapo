/**
 * Generates the plugin's static artwork.
 *
 * - The manifest's default key images, written with the same functions the plugin uses to
 *   draw keys at runtime (src/render/keys.ts, compiled to build-test by `npm run icons`), so
 *   a key looks the same before and after the plugin first draws it.
 * - The marketplace PNGs. Stream Deck takes SVG everywhere else but requires PNG here, so
 *   that artwork is rasterised: drawn with signed distance fields and 4x supersampling, and
 *   encoded with the built-in zlib, rather than pulling in a native SVG renderer for one
 *   image. No dependencies, and the output is byte-identical on every machine.
 *
 * The 20px action-list icons and the category icon are hand-drawn SVGs, kept as files: at
 * that size they need drawing for the pixel grid, not scaling down.
 *
 * Run with: npm run icons
 */

import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN = resolve(ROOT, "com.migue802.tapo-lights.sdPlugin");
const OUT_DIR = resolve(PLUGIN, "imgs/plugin");

// ---------- PNG encoding ----------

const CRC_TABLE = Int32Array.from({ length: 256 }, (_, n) => {
	let c = n;
	for (let k = 0; k < 8; k++) {
		c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
	}
	return c;
});

function crc32(buf) {
	let c = 0xffffffff;
	for (const byte of buf) {
		c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
	}
	return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
	const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
	const len = Buffer.alloc(4);
	len.writeUInt32BE(data.length);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(body));
	return Buffer.concat([len, body, crc]);
}

/** Encodes an RGBA pixel buffer as a PNG. */
function encodePng(rgba, width, height) {
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 6; // colour type: RGBA
	ihdr[10] = 0; // deflate
	ihdr[11] = 0; // adaptive filtering
	ihdr[12] = 0; // no interlace

	// Each scanline is prefixed with its filter type; 0 (none) keeps this simple and
	// still compresses well, the artwork being mostly flat colour.
	const stride = width * 4;
	const raw = Buffer.alloc((stride + 1) * height);
	for (let y = 0; y < height; y++) {
		raw[y * (stride + 1)] = 0;
		rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
	}

	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", ihdr),
		chunk("IDAT", deflateSync(raw, { level: 9 })),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

// ---------- drawing ----------

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const mix = (a, b, t) => a + (b - a) * t;
const TAU = Math.PI * 2;

function hexToRgb(hex) {
	const v = hex.replace("#", "");
	return [parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16)];
}

/** Signed distance to a rounded rectangle: negative inside, positive outside. */
function sdRoundRect(px, py, cx, cy, halfW, halfH, radius) {
	const qx = Math.abs(px - cx) - (halfW - radius);
	const qy = Math.abs(py - cy) - (halfH - radius);
	const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
	return outside + Math.min(Math.max(qx, qy), 0) - radius;
}

/** Angle of (px, py) around (cx, cy), clockwise from twelve o'clock, in [0, 2π). */
function clockAngle(px, py, cx, cy) {
	const a = Math.atan2(px - cx, -(py - cy));
	return a < 0 ? a + TAU : a;
}

/**
 * Signed distance to a stroked arc with round caps, running clockwise from `from` to `to`
 * (clock angles, radians). Inside the sweep it is the distance to the circle; outside it,
 * the distance to the nearer end cap.
 */
function sdArc(px, py, cx, cy, r, from, to, width) {
	const a = clockAngle(px, py, cx, cy);
	if (a >= from && a <= to) {
		return Math.abs(Math.hypot(px - cx, py - cy) - r) - width / 2;
	}
	const cap = (angle) => Math.hypot(px - (cx + r * Math.sin(angle)), py - (cy - r * Math.cos(angle)));
	return Math.min(cap(from), cap(to)) - width / 2;
}

/** Signed distance to a stroked segment with round caps. */
function sdSegment(px, py, ax, ay, bx, by, width) {
	const dx = bx - ax;
	const dy = by - ay;
	const t = clamp01(((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy));
	return Math.hypot(px - (ax + dx * t), py - (ay + dy * t)) - width / 2;
}

/** The rainbow the toggle key uses for a strip running an effect, sampled along the ring. */
const RAMP = ["#ff5252", "#ffb340", "#ffe94d", "#4dff88", "#4dc3ff", "#8c6bff", "#ff5bd0"].map(hexToRgb);

function rampAt(t) {
	const x = clamp01(t) * (RAMP.length - 1);
	const i = Math.min(Math.floor(x), RAMP.length - 2);
	const k = x - i;
	return [0, 1, 2].map((c) => mix(RAMP[i][c], RAMP[i + 1][c], k));
}

/**
 * The toggle key's artwork on a tile: a rainbow brightness ring around a power glyph.
 * Coordinates are on a 256-unit design grid and scaled, so every size is the same drawing.
 */
function render(size) {
	const SS = 4; // supersampling factor, for antialiased edges without a rasteriser
	const rgba = Buffer.alloc(size * size * 4);
	const k = size / 256;

	const BG_IN = hexToRgb("#22252b");
	const BG_OUT = hexToRgb("#0c0d10");
	const WHITE = [255, 255, 255];
	const C = 128;
	const RING_R = 82;
	const RING_W = 18;
	const SWEEP = TAU * 0.83;
	const GLOW = 30;

	for (let y = 0; y < size; y++) {
		for (let x = 0; x < size; x++) {
			let r = 0;
			let g = 0;
			let b = 0;
			let a = 0;

			for (let sy = 0; sy < SS; sy++) {
				for (let sx = 0; sx < SS; sx++) {
					// Sample at the subpixel centre, in design units.
					const px = (x + (sx + 0.5) / SS) / k;
					const py = (y + (sy + 0.5) / SS) / k;

					// Tile, with the same centre-lit gradient as the keys.
					const ca = clamp01(0.5 - sdRoundRect(px, py, C, C, 128, 128, 52));
					const bgT = clamp01(Math.hypot(px - C, py - C * 0.84) / 190);
					let [cr, cg, cb] = [0, 1, 2].map((c) => mix(BG_IN[c], BG_OUT[c], bgT));
					const paint = (cover, color) => {
						cr = mix(cr, color[0], cover);
						cg = mix(cg, color[1], cover);
						cb = mix(cb, color[2], cover);
					};

					// Past the end of the sweep — around the caps — take the colour of the nearer
					// end, or the glow by the start cap picks up the far end's colour.
					const angle = clockAngle(px, py, C, C);
					const along = angle <= SWEEP ? angle / SWEEP : angle - SWEEP < TAU - angle ? 1 : 0;
					const ringColor = rampAt(along);

					// Track under the ring.
					const dTrack = Math.abs(Math.hypot(px - C, py - C) - RING_R) - RING_W / 2;
					paint(clamp01(0.5 - dTrack) * 0.09, WHITE);

					// Glow, then the ring itself.
					const dRing = sdArc(px, py, C, C, RING_R, 0, SWEEP, RING_W);
					if (dRing > 0 && dRing < GLOW) {
						const t = 1 - dRing / GLOW;
						paint(0.4 * t * t, ringColor);
					}
					paint(clamp01(0.5 - dRing), ringColor);

					// Power glyph: a ring open at the top, and the stem through the gap.
					const dGlyph = Math.min(
						sdArc(px, py, C, C, 36, (40 / 360) * TAU, (320 / 360) * TAU, 17),
						sdSegment(px, py, C, C - 44, C, C - 8, 17),
					);
					paint(clamp01(0.5 - dGlyph), WHITE);

					r += cr * ca;
					g += cg * ca;
					b += cb * ca;
					a += ca;
				}
			}

			const n = SS * SS;
			const i = (y * size + x) * 4;
			// Un-premultiply so the stored colour stays correct where alpha is partial.
			rgba[i] = a > 0 ? Math.round(clamp01(r / a / 255) * 255) : 0;
			rgba[i + 1] = a > 0 ? Math.round(clamp01(g / a / 255) * 255) : 0;
			rgba[i + 2] = a > 0 ? Math.round(clamp01(b / a / 255) * 255) : 0;
			rgba[i + 3] = Math.round(clamp01(a / n) * 255);
		}
	}

	return encodePng(rgba, size, size);
}

mkdirSync(OUT_DIR, { recursive: true });

for (const [name, size] of [
	["marketplace.png", 256],
	["marketplace@2x.png", 512],
]) {
	const png = render(size);
	writeFileSync(resolve(OUT_DIR, name), png);
	console.log(`${name.padEnd(28)} ${String(size).padStart(3)}px  ${String(png.length).padStart(6)} bytes`);
}

// ---------- default key images ----------

const keys = await import(pathToFileURL(resolve(ROOT, "build-test/src/render/keys.js")).href);

/** A strip that is on and running an effect, so the toggle's "on" default shows off the ring. */
const SAMPLE_ON = {
	device_id: "",
	model: "L900",
	fw_ver: "",
	nickname: "",
	ssid: "",
	rssi: 0,
	device_on: true,
	brightness: 75,
	hue: 0,
	saturation: 100,
	color_temp: 0,
	lighting_effect: { enable: 1 },
};

const defaults = {
	"actions/toggle/off.svg": keys.toggleKey(undefined),
	"actions/toggle/on.svg": keys.toggleKey(SAMPLE_ON),
	"actions/brightness/key.svg": keys.brightnessKey("set", 50),
	"actions/color/key.svg": keys.colorKey("#ff0000"),
	"actions/temperature/key.svg": keys.temperatureKey(4000),
	"actions/scene/key.svg": keys.sceneKey(keys.fromHex("#ff0000"), 80),
};

for (const [path, image] of Object.entries(defaults)) {
	writeFileSync(resolve(PLUGIN, "imgs", path), `${image}\n`);
	console.log(`${path.padEnd(28)} ${String(image.length).padStart(6)} bytes`);
}
