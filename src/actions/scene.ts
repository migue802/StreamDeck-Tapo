import { action, SingletonAction } from "@elgato/streamdeck";
import type {
	DialAction,
	DidReceiveSettingsEvent,
	KeyAction,
	KeyDownEvent,
	WillAppearEvent,
	WillDisappearEvent,
} from "@elgato/streamdeck";
import { deviceState, withDevice } from "../context.js";
import { KeyImages } from "../render/images.js";
import { fromHex, kelvinToRgb, sceneKey } from "../render/keys.js";
import type { Rgb } from "../render/keys.js";
import { Redraws } from "../render/redraw.js";
import { BRIGHTNESS_MAX, BRIGHTNESS_MIN, TEMP_MAX, TEMP_MIN, clamp } from "../tapo/types.js";
import type { SetDeviceInfoParams } from "../tapo/types.js";
import { hexToHueSat, normalizeHex } from "./color.js";

type SceneMode = "color" | "white";

/** One key's preset. Every field is absent until the property inspector saves it. */
type SceneSettings = {
	mode?: SceneMode;
	hex?: string;
	kelvin?: number;
	brightness?: number;
};

/** The same preset with every field resolved to a usable value. */
type Preset = Required<SceneSettings>;

type SceneActionInstance = DialAction<SceneSettings> | KeyAction<SceneSettings>;

const DEFAULTS: Preset = {
	mode: "color",
	hex: "#ff0000",
	kelvin: 4000,
	brightness: 80,
};

/** The property inspector may hand a range back as a string, and a fresh key hands back nothing. */
function toNumber(value: unknown, fallback: number): number {
	// Number("") and Number(null) are 0, not NaN, so a blank setting must be rejected before parsing.
	if (value === undefined || value === null || (typeof value === "string" && value.trim() === "")) {
		return fallback;
	}

	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : fallback;
}

function readPreset(settings: SceneSettings | undefined): Preset {
	return {
		mode: settings?.mode === "white" ? "white" : DEFAULTS.mode,
		hex: settings?.hex ?? DEFAULTS.hex,
		kelvin: toNumber(settings?.kelvin, DEFAULTS.kelvin),
		brightness: toNumber(settings?.brightness, DEFAULTS.brightness),
	};
}

/** The whole preset as a single payload. */
function toParams(preset: Preset): SetDeviceInfoParams {
	const params: SetDeviceInfoParams = {
		device_on: true,
		brightness: clamp(Math.round(preset.brightness), BRIGHTNESS_MIN, BRIGHTNESS_MAX),
	};

	if (preset.mode === "white") {
		return { ...params, color_temp: clamp(Math.round(preset.kelvin), TEMP_MIN, TEMP_MAX) };
	}

	// A non-zero colour temperature keeps the strip in white mode, where hue and saturation are ignored.
	return { ...params, ...hexToHueSat(preset.hex), color_temp: 0 };
}

/** The colour the preset lights the strip with, for drawing on its key. */
function toRgb(preset: Preset): Rgb {
	return preset.mode === "white" ? kelvinToRgb(clamp(preset.kelvin, TEMP_MIN, TEMP_MAX)) : fromHex(normalizeHex(preset.hex));
}

function toTitle(preset: Preset): string {
	return preset.mode === "white" ? `${Math.round(preset.kelvin)}K` : `${Math.round(preset.brightness)}%`;
}

/**
 * The key reflects the preset the user configured, not the strip, so this action needs no
 * subscription to the shared device state: nothing another action does can change what it reads.
 */
@action({ UUID: "com.migue802.tapo-lights.scene" })
export class Scene extends SingletonAction<SceneSettings> {
	#images = new KeyImages();
	#redraws = new Redraws();

	override onWillAppear(ev: WillAppearEvent<SceneSettings>): void {
		this.#redraw(ev.action, ev.payload.settings);
	}

	override onWillDisappear(ev: WillDisappearEvent<SceneSettings>): void {
		this.#images.forget(ev.action.id);
		this.#redraws.forget(ev.action.id);
	}

	override onDidReceiveSettings(ev: DidReceiveSettingsEvent<SceneSettings>): void {
		this.#redraw(ev.action, ev.payload.settings);
	}

	override async onKeyDown(ev: KeyDownEvent<SceneSettings>): Promise<void> {
		const preset = readPreset(ev.payload.settings);

		await withDevice(ev.action, async () => {
			// One request for the whole preset: sent as separate calls the strip visibly steps
			// through the intermediate states on its way to the scene.
			await deviceState.set(toParams(preset));
			await ev.action.showOk();
		});
	}

	/** Dragging a slider in the inspector sends settings faster than a key may be redrawn. */
	#redraw(action: SceneActionInstance, settings: SceneSettings): void {
		this.#redraws.request(action.id, () => this.#render(action, settings));
	}

	async #render(action: SceneActionInstance, settings: SceneSettings): Promise<void> {
		if (!action.isKey()) {
			return;
		}

		const preset = readPreset(settings);
		await action.setTitle(toTitle(preset));
		await this.#images.show(action, sceneKey(toRgb(preset), preset.brightness));
	}
}
