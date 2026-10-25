import { BRIGHTNESS_MAX, BRIGHTNESS_MIN, clamp, TEMP_MAX, TEMP_MIN } from "../tapo/types.js";
import type { DeviceInfo } from "../tapo/types.js";

/**
 * Key artwork, drawn as SVG at runtime so a key can show the state it stands for: the toggle
 * the strip's real colour and brightness, a preset the colour it will apply.
 *
 * Keys have no background of their own: on the device every key then shares the same black,
 * where a drawn "near black" stands out against its neighbours. Glows fade to transparent.
 *
 * Everything here sticks to what Stream Deck's SVG renderer reliably draws — shapes, strokes
 * and linear/radial gradients. Glows are transparent radial gradients and layered strokes
 * rather than `filter` blurs, and there is no text: titles are left to Stream Deck itself,
 * which draws them along the bottom of the key, so artwork that sits under a title keeps
 * clear of the bottom band.
 *
 * `tools/make-icons.mjs` writes the manifest's default key images with these same functions.
 */

export type Rgb = [number, number, number];

const SIZE = 72;

/** Rainbow used wherever the strip is running an effect rather than one colour. */
const RAINBOW = ["#ff5252", "#ffb340", "#ffe94d", "#4dff88", "#4dc3ff", "#8c6bff", "#ff5bd0"];

/** Temperature scale, warm to cool, shared by the White key and its dial. */
export const KELVIN_STOPS: Array<[number, string]> = [
	[0, "#ffb46b"],
	[0.5, "#fff4e6"],
	[1, "#cfe0ff"],
];

const OFF_GLYPH = "#6b6f78";
const TRACK = "#ffffff17";

// ---------- colour ----------

export function toHex([r, g, b]: Rgb): string {
	const part = (v: number): string => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, "0");
	return `#${part(r)}${part(g)}${part(b)}`;
}

export function fromHex(hex: string): Rgb {
	const v = hex.replace("#", "");
	return [parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16)];
}

/** Blends towards `to` by `t` (0 keeps `from`, 1 gives `to`). */
export function mix(from: Rgb, to: Rgb, t: number): Rgb {
	return [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t, from[2] + (to[2] - from[2]) * t];
}

/** Hue in degrees, saturation 0–100, at full value — the strip keeps brightness separately. */
export function hsvToRgb(hue: number, saturation: number): Rgb {
	const h = (((hue % 360) + 360) % 360) / 60;
	const s = clamp(saturation, 0, 100) / 100;
	const c = s;
	const x = c * (1 - Math.abs((h % 2) - 1));
	const m = 1 - c;
	const [r, g, b] =
		h < 1 ? [c, x, 0] : h < 2 ? [x, c, 0] : h < 3 ? [0, c, x] : h < 4 ? [0, x, c] : h < 5 ? [x, 0, c] : [c, 0, x];
	return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

/**
 * Approximate colour of a black-body light at the given temperature (Tanner Helland's fit),
 * which is what a white LED is imitating. Good to a few percent over 1000–40000K.
 */
export function kelvinToRgb(kelvin: number): Rgb {
	const t = clamp(kelvin, 1000, 40000) / 100;
	const r = t <= 66 ? 255 : 329.698727446 * Math.pow(t - 60, -0.1332047592);
	const g = t <= 66 ? 99.4708025861 * Math.log(t) - 161.1195681661 : 288.1221695283 * Math.pow(t - 60, -0.0755148492);
	const b = t >= 66 ? 255 : t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
	return [clamp(r, 0, 255), clamp(g, 0, 255), clamp(b, 0, 255)];
}

/** What the strip is showing: one colour, or an effect cycling through many. */
export type LightColor = { kind: "solid"; rgb: Rgb } | { kind: "effect" };

export function lightColor(info: DeviceInfo): LightColor {
	if (info.lighting_effect?.enable) {
		return { kind: "effect" };
	}
	// A non-zero colour temperature means white mode, where hue and saturation are ignored.
	if (info.color_temp > 0) {
		return { kind: "solid", rgb: kelvinToRgb(info.color_temp) };
	}
	return { kind: "solid", rgb: hsvToRgb(info.hue, info.saturation) };
}

// ---------- shared pieces ----------

const WHITE: Rgb = [255, 255, 255];
const BLACK: Rgb = [0, 0, 0];

function svg(defs: string, body: string): string {
	return (
		`<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">` +
		`<defs>${defs}</defs>${body}</svg>`
	);
}

/** A soft pool of light behind a glyph, strongest at its centre. */
function glow(id: string, cx: number, cy: number, r: number, color: string, strength: number): [string, string] {
	const def =
		`<radialGradient id="${id}">` +
		`<stop offset="0" stop-color="${color}" stop-opacity="${strength.toFixed(3)}"/>` +
		`<stop offset="0.45" stop-color="${color}" stop-opacity="${(strength * 0.45).toFixed(3)}"/>` +
		`<stop offset="1" stop-color="${color}" stop-opacity="0"/></radialGradient>`;
	return [def, `<circle cx="${cx}" cy="${cy}" r="${r}" fill="url(#${id})"/>`];
}

function stops(colors: string[]): string {
	return colors.map((c, i) => `<stop offset="${(i / (colors.length - 1)).toFixed(3)}" stop-color="${c}"/>`).join("");
}

function polar(cx: number, cy: number, r: number, degrees: number): [number, number] {
	const rad = ((degrees - 90) * Math.PI) / 180;
	return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
}

/** An arc clockwise from `from` to `to` degrees, 0 being twelve o'clock. */
function arcPath(cx: number, cy: number, r: number, from: number, to: number): string {
	const [x1, y1] = polar(cx, cy, r, from);
	const [x2, y2] = polar(cx, cy, r, to);
	const large = to - from > 180 ? 1 : 0;
	return `M${x1.toFixed(2)} ${y1.toFixed(2)}A${r} ${r} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`;
}

/** A lit sphere of the given colour, used by every key that previews a colour. */
function orb(cx: number, cy: number, r: number, rgb: Rgb): [string, string] {
	const defs =
		`<radialGradient id="orb" cx="0.36" cy="0.32" r="0.78">` +
		`<stop offset="0" stop-color="${toHex(mix(rgb, WHITE, 0.6))}"/>` +
		`<stop offset="0.5" stop-color="${toHex(rgb)}"/>` +
		`<stop offset="1" stop-color="${toHex(mix(rgb, BLACK, 0.38))}"/></radialGradient>`;
	const body =
		`<circle cx="${cx}" cy="${cy}" r="${r}" fill="url(#orb)"/>` +
		`<circle cx="${cx}" cy="${cy}" r="${r - 0.5}" fill="none" stroke="#ffffff" stroke-opacity="0.16"/>` +
		`<ellipse cx="${cx - r * 0.3}" cy="${cy - r * 0.42}" rx="${r * 0.32}" ry="${r * 0.18}" ` +
		`fill="#ffffff" fill-opacity="0.38" transform="rotate(-28 ${cx - r * 0.3} ${cy - r * 0.42})"/>`;
	return [defs, body];
}

/** The power glyph: a ring open at the top, with the stem through the gap. */
function powerGlyph(cx: number, cy: number, r: number, color: string, width: number): string {
	return (
		`<g fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round">` +
		`<path d="${arcPath(cx, cy, r, 40, 320)}"/>` +
		`<path d="M${cx} ${cy - r - 1.5}V${cy - r * 0.15}"/></g>`
	);
}

// ---------- keys ----------

/**
 * The toggle key: a gauge ring showing the strip's brightness, in the colour it is lit with,
 * around a power glyph. Off — or not yet known — it falls back to a quiet grey outline.
 */
export function toggleKey(info: DeviceInfo | undefined): string {
	const cx = 36;
	const cy = 36;
	const r = 24;

	if (!info?.device_on) {
		return svg(
			"",
			`<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${TRACK}" stroke-width="5"/>` +
				powerGlyph(cx, cy, 10, OFF_GLYPH, 4.2),
		);
	}

	const level = clamp(info.brightness, BRIGHTNESS_MIN, BRIGHTNESS_MAX) / 100;
	const light = lightColor(info);
	const glowColor = light.kind === "solid" ? toHex(light.rgb) : "#ffd27a";
	const stroke = light.kind === "solid" ? glowColor : "url(#rainbow)";

	const [glowDef, glowBody] = glow("glow", cx, cy, 36, glowColor, 0.2 + 0.4 * level);
	const defs =
		glowDef +
		(light.kind === "effect" ? `<linearGradient id="rainbow" x1="0" y1="0" x2="1" y2="1">${stops(RAINBOW)}</linearGradient>` : "");

	// A full ring would close on itself without a visible end; a whisker short of it reads as 100%.
	const sweep = Math.max(level * 360, 8);
	const arc =
		level >= 0.995
			? `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${stroke}" stroke-width="WIDTH"/>`
			: `<path d="${arcPath(cx, cy, r, 0, sweep)}" fill="none" stroke="${stroke}" stroke-width="WIDTH" stroke-linecap="round"/>`;

	return svg(
		defs,
		glowBody +
			`<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${TRACK}" stroke-width="5"/>` +
			// A wide faint pass under the ring stands in for a blur.
			`<g opacity="0.28">${arc.replace("WIDTH", "10")}</g>` +
			arc.replace("WIDTH", "5") +
			powerGlyph(cx, cy, 10, "#ffffff", 4.2),
	);
}

/** A colour preset: a lit orb of exactly the colour the key applies. */
export function colorKey(hex: string): string {
	const rgb = fromHex(hex);
	const [glowDef, glowBody] = glow("glow", 36, 34, 34, toHex(rgb), 0.5);
	const [orbDefs, orbBody] = orb(36, 34, 17, rgb);
	return svg(glowDef + orbDefs, glowBody + orbBody);
}

/**
 * A white preset: an orb of the temperature's own tint, inside a warm-to-cool scale with a
 * marker where this preset sits on it. The scale opens at the bottom, where the title goes.
 */
export function temperatureKey(kelvin: number): string {
	const k = clamp(kelvin, TEMP_MIN, TEMP_MAX);
	const t = (k - TEMP_MIN) / (TEMP_MAX - TEMP_MIN);
	const rgb = kelvinToRgb(k);
	const cx = 36;
	const cy = 30;
	const r = 21;
	const start = -135;
	const end = 135;

	const [glowDef, glowBody] = glow("glow", cx, cy, 30, toHex(rgb), 0.38);
	const [orbDefs, orbBody] = orb(cx, cy, 12, rgb);
	const scale = `<linearGradient id="scale" x1="0" y1="0" x2="1" y2="0">${stops(KELVIN_STOPS.map(([, c]) => c))}</linearGradient>`;
	const [mx, my] = polar(cx, cy, r, start + (end - start) * t);

	return svg(
		glowDef + orbDefs + scale,
		glowBody +
			`<path d="${arcPath(cx, cy, r, start, end)}" fill="none" stroke="url(#scale)" stroke-width="3" stroke-linecap="round" opacity="0.85"/>` +
			`<circle cx="${mx.toFixed(2)}" cy="${my.toFixed(2)}" r="4" fill="${toHex(rgb)}" stroke="#000000" stroke-width="2"/>` +
			orbBody,
	);
}

/** Four-pointed sparkle centred on (cx, cy). */
function sparkle(cx: number, cy: number, r: number): string {
	const w = r * 0.28;
	return (
		`M${cx} ${cy - r}C${cx + w * 0.35} ${cy - w} ${cx + w} ${cy - w * 0.35} ${cx + r} ${cy}` +
		`C${cx + w} ${cy + w * 0.35} ${cx + w * 0.35} ${cy + w} ${cx} ${cy + r}` +
		`C${cx - w * 0.35} ${cy + w} ${cx - w} ${cy + w * 0.35} ${cx - r} ${cy}` +
		`C${cx - w} ${cy - w * 0.35} ${cx - w * 0.35} ${cy - w} ${cx} ${cy - r}Z`
	);
}

/** A scene: sparkles in the scene's colour, glowing as brightly as the scene is set. */
export function sceneKey(rgb: Rgb, brightness: number): string {
	const level = clamp(brightness, BRIGHTNESS_MIN, BRIGHTNESS_MAX) / 100;
	const [glowDef, glowBody] = glow("glow", 33, 30, 32, toHex(rgb), 0.18 + 0.4 * level);
	const fill =
		`<linearGradient id="spark" x1="0" y1="0" x2="1" y2="1">` +
		`<stop offset="0" stop-color="${toHex(mix(rgb, WHITE, 0.55))}"/><stop offset="1" stop-color="${toHex(rgb)}"/></linearGradient>`;

	return svg(
		glowDef + fill,
		glowBody +
			`<path d="${sparkle(32, 31, 17)}" fill="url(#spark)"/>` +
			`<path d="${sparkle(51, 15, 7.5)}" fill="url(#spark)" opacity="0.9"/>` +
			`<path d="${sparkle(51, 44, 5)}" fill="url(#spark)" opacity="0.7"/>`,
	);
}

export type BrightnessKeyMode = "set" | "increment" | "decrement";

/**
 * A brightness preset: a sun whose lit rays show the level it sets. A step key's effect
 * depends on where the strip already is, so it shows its direction instead — fully lit to
 * brighten, half lit to dim — and leaves the amount to its title.
 */
export function brightnessKey(mode: BrightnessKeyMode, value: number): string {
	const cx = 36;
	const cy = 30;
	const amber = "#ffb627";
	const level = clamp(value, BRIGHTNESS_MIN, BRIGHTNESS_MAX) / 100;
	const lit = mode === "set" ? Math.max(1, Math.round(level * 8)) : mode === "increment" ? 8 : 4;

	const [glowDef, glowBody] = glow("glow", cx, cy, 30, amber, mode === "set" ? 0.12 + 0.4 * level : 0.35);
	const core =
		`<radialGradient id="core" cx="0.38" cy="0.34" r="0.8">` +
		`<stop offset="0" stop-color="#fff1c2"/><stop offset="0.6" stop-color="${amber}"/><stop offset="1" stop-color="#d9860b"/></radialGradient>`;

	let rays = "";
	for (let i = 0; i < 8; i++) {
		const angle = i * 45;
		const [x1, y1] = polar(cx, cy, 14, angle);
		const [x2, y2] = polar(cx, cy, 20, angle);
		const color = i < lit ? amber : "#ffffff1f";
		rays += `<path d="M${x1.toFixed(2)} ${y1.toFixed(2)}L${x2.toFixed(2)} ${y2.toFixed(2)}" stroke="${color}"/>`;
	}

	return svg(
		glowDef + core,
		glowBody +
			`<g stroke-width="4" stroke-linecap="round">${rays}</g>` +
			`<circle cx="${cx}" cy="${cy}" r="9" fill="url(#core)"/>`,
	);
}

/**
 * An SVG as a data URL. Stream Deck only draws an image sent this way: given the bare
 * `<svg>` markup that the SDK's documentation suggests, it silently keeps the old image.
 */
export function svgDataUrl(image: string): string {
	return `data:image/svg+xml;base64,${Buffer.from(image).toString("base64")}`;
}
