import { action, SingletonAction } from "@elgato/streamdeck";
import type {
	DialAction,
	DialDownEvent,
	DialRotateEvent,
	DidReceiveSettingsEvent,
	KeyAction,
	KeyDownEvent,
	WillAppearEvent,
	WillDisappearEvent,
} from "@elgato/streamdeck";
import { deviceState, withDevice } from "../context.js";
import { KeyImages } from "../render/images.js";
import { colorKey } from "../render/keys.js";
import { Redraws } from "../render/redraw.js";
import { LatestWriter } from "../tapo/coalesce.js";

export type ColorSettings = {
	hex?: string;
};

const DEFAULT_HEX = "#ff0000";
const HUE_RANGE = 360;

/** Degrees of hue travelled per dial tick. */
const TICK_DEGREES = 2;

/** Dialling picks a hue, not a pastel; saturation is pinned so the colour is actually visible. */
const DIAL_SATURATION = 100;

/** The full hue wheel, laid under the dial so the bar shows the colour being selected. */
const HUE_GRADIENT = "0:#ff0000,0.17:#ffff00,0.33:#00ff00,0.5:#00ffff,0.67:#0000ff,0.83:#ff00ff,1:#ff0000";

/**
 * How long after a tick device broadcasts are ignored.
 *
 * Writes are coalesced, so the strip's reported hue lags the dial. A background read
 * landing mid-turn would otherwise snap the dial back to the last hue actually written.
 */
const ROTATE_GRACE_MS = 1500;

/** JavaScript's `%` keeps the sign of the dividend, so a negative tick would yield a negative hue. */
function wrapHue(hue: number): number {
	return ((hue % HUE_RANGE) + HUE_RANGE) % HUE_RANGE;
}

/** Normalises user input to a safe `#rrggbb` string, falling back to red. Only hex reaches the SVG. */
export function normalizeHex(hex: string | undefined): string {
	if (typeof hex !== "string") {
		return DEFAULT_HEX;
	}

	let value = hex.trim().replace(/^#/, "");
	if (/^[0-9a-fA-F]{3}$/.test(value)) {
		value = value.replace(/./g, (digit) => digit + digit);
	}

	return /^[0-9a-fA-F]{6}$/.test(value) ? `#${value.toLowerCase()}` : DEFAULT_HEX;
}

/**
 * Converts `#rrggbb` (or `#rgb`) to the hue and saturation the strip expects, falling
 * back to red when the input is not a colour. Saturation is taken from HSV rather than
 * HSL because the strip carries lightness separately, as its own brightness setting.
 */
export function hexToHueSat(hex: string): { hue: number; saturation: number } {
	const red = { hue: 0, saturation: 100 };
	if (typeof hex !== "string") {
		return red;
	}

	let value = hex.trim().replace(/^#/, "");
	if (/^[0-9a-fA-F]{3}$/.test(value)) {
		value = value.replace(/./g, (digit) => digit + digit);
	}

	if (!/^[0-9a-fA-F]{6}$/.test(value)) {
		return red;
	}

	const r = parseInt(value.slice(0, 2), 16) / 255;
	const g = parseInt(value.slice(2, 4), 16) / 255;
	const b = parseInt(value.slice(4, 6), 16) / 255;

	const max = Math.max(r, g, b);
	const min = Math.min(r, g, b);
	const delta = max - min;

	let hue = 0;
	if (delta > 0) {
		if (max === r) {
			hue = (g - b) / delta;
		} else if (max === g) {
			hue = (b - r) / delta + 2;
		} else {
			hue = (r - g) / delta + 4;
		}
		hue *= 60;
	}

	return {
		// Rounding can reach 360, which the strip treats as out of range.
		hue: wrapHue(Math.round(hue)),
		saturation: Math.round(max === 0 ? 0 : (delta / max) * 100),
	};
}

/** Sets the strip to a fixed colour on a key, or sweeps the hue wheel on a dial. */
@action({ UUID: "com.migue802.tapo-lights.color" })
export class Color extends SingletonAction<ColorSettings> {
	#unsubscribers = new Map<string, () => void>();
	/** A key is a preset, so it renders from its own settings rather than the strip's state. */
	#settings = new Map<string, ColorSettings>();
	#images = new KeyImages();
	#redraws = new Redraws();

	/** The hue the dial is on, which leads the strip while writes are coalesced. */
	#hue = 0;
	#lastRotateAt = 0;

	#writer = new LatestWriter<{ action: DialAction<ColorSettings>; hue: number }>(({ action: dial, hue }) =>
		withDevice(dial, () =>
			deviceState.set({ device_on: true, hue, saturation: DIAL_SATURATION, color_temp: 0 }),
		),
	);

	override async onWillAppear(ev: WillAppearEvent<ColorSettings>): Promise<void> {
		this.#settings.set(ev.action.id, ev.payload.settings);

		// Render immediately so a key shows its swatch even if the strip never broadcasts.
		this.#redraw(ev.action);

		// Only a dial follows the strip; a key shows its own configured colour, so it does not
		// subscribe — and does not keep the strip being polled on its behalf.
		if (!ev.action.isDial()) {
			return;
		}

		const dial = ev.action;
		this.#unsubscribers.get(dial.id)?.();
		this.#unsubscribers.set(
			dial.id,
			deviceState.subscribe((info) => {
				if (info && Date.now() - this.#lastRotateAt >= ROTATE_GRACE_MS) {
					this.#hue = wrapHue(Math.round(info.hue));
				}
				this.#redraw(dial);
			}),
		);

		await dial.setFeedbackLayout("$B2");
		await dial.setTriggerDescription({ push: "Toggle", rotate: "Hue" });

		const cached = deviceState.cached;
		if (cached) {
			this.#hue = wrapHue(Math.round(cached.hue));
		}
		this.#redraw(dial);

		await withDevice(ev.action, async () => {
			await deviceState.get();
		});
	}

	override onWillDisappear(ev: WillDisappearEvent<ColorSettings>): void {
		this.#unsubscribers.get(ev.action.id)?.();
		this.#unsubscribers.delete(ev.action.id);
		this.#settings.delete(ev.action.id);
		this.#images.forget(ev.action.id);
		this.#redraws.forget(ev.action.id);
	}

	override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<ColorSettings>): Promise<void> {
		// This is what refreshes a key's swatch the moment the user picks a new colour.
		this.#settings.set(ev.action.id, ev.payload.settings);
		this.#redraw(ev.action);
	}

	override async onKeyDown(ev: KeyDownEvent<ColorSettings>): Promise<void> {
		this.#settings.set(ev.action.id, ev.payload.settings);
		const { hue, saturation } = hexToHueSat(ev.payload.settings.hex ?? DEFAULT_HEX);

		await withDevice(ev.action, () =>
			// Without color_temp: 0 the strip stays in white mode and ignores the colour entirely.
			deviceState.set({ device_on: true, hue, saturation, color_temp: 0 }),
		);
	}

	override async onDialRotate(ev: DialRotateEvent<ColorSettings>): Promise<void> {
		this.#lastRotateAt = Date.now();
		this.#hue = wrapHue(this.#hue + ev.payload.ticks * TICK_DEGREES);

		this.#writer.push({ action: ev.action, hue: this.#hue });
		this.#redraw(ev.action);
	}

	override async onDialDown(ev: DialDownEvent<ColorSettings>): Promise<void> {
		await withDevice(ev.action, async () => {
			const info = deviceState.cached ?? (await deviceState.get());
			await deviceState.set({ device_on: !info.device_on });
		});
	}

	/** Redraws from the latest state when this instance's next update slot comes round. */
	#redraw(target: DialAction<ColorSettings> | KeyAction<ColorSettings>): void {
		this.#redraws.request(target.id, () => this.#render(target));
	}

	async #render(target: DialAction<ColorSettings> | KeyAction<ColorSettings>): Promise<void> {
		if (target.isKey()) {
			// The key shows the colour it applies; only hex validated by normalizeHex reaches the SVG.
			await this.#images.show(target, colorKey(normalizeHex(this.#settings.get(target.id)?.hex)));
			return;
		}

		if (target.isDial()) {
			await target.setFeedback({
				title: "Colour",
				value: `${this.#hue}°`,
				indicator: {
					value: Math.round((this.#hue / HUE_RANGE) * 100),
					bar_bg_c: HUE_GRADIENT,
				},
			});
		}
	}
}
