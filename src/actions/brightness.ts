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
import { brightnessKey } from "../render/keys.js";
import { Redraws } from "../render/redraw.js";
import { LatestWriter } from "../tapo/coalesce.js";
import { BRIGHTNESS_MAX, BRIGHTNESS_MIN, clamp } from "../tapo/types.js";
import type { DeviceInfo } from "../tapo/types.js";

/** What a key press does: jump to a set brightness, or nudge the current one. */
export type BrightnessMode = "set" | "increment" | "decrement";

export type BrightnessSettings = {
	/** What a key press does. Defaults to "set". */
	mode?: BrightnessMode;
	/** Target brightness for "set" mode. */
	value?: number;
	/** Points moved per key press in increment/decrement mode. */
	step?: number;
	/** Points moved per dial tick. */
	dialStep?: number;
};

const DEFAULT_VALUE = 50;
const DEFAULT_STEP = 10;
const DEFAULT_DIAL_STEP = 2;
const BAR_FILL = "#f0a30a";

/**
 * While the user is turning the dial, its own working value outranks anything the
 * strip reports: a reading taken before the write landed would otherwise yank the
 * bar back to the old brightness mid-rotation.
 */
const ROTATE_HOLD_MS = 1500;

type BrightnessAction = DialAction<BrightnessSettings> | KeyAction<BrightnessSettings>;
type PendingWrite = { action: DialAction<BrightnessSettings>; brightness: number };

@action({ UUID: "com.migue802.tapo-lights.brightness" })
export class Brightness extends SingletonAction<BrightnessSettings> {
	readonly #unsubscribes = new Map<string, () => void>();
	/** Brightness each dial believes it is on, ahead of the strip confirming it. */
	readonly #working = new Map<string, number>();
	readonly #lastTick = new Map<string, number>();
	/**
	 * Settings are mirrored from the event payloads rather than fetched. `getSettings()` is
	 * answered by a `didReceiveSettings` event, and the SDK only filters that reply out of
	 * `onDidReceiveSettings` when `useExperimentalMessageIdentifiers` is on — it is off by
	 * default, so fetching from a render would make render and settings re-trigger each other.
	 */
	readonly #settings = new Map<string, BrightnessSettings>();
	readonly #images = new KeyImages();
	readonly #redraws = new Redraws();

	/** All dials drive the same strip, so the newest value is the only one worth sending. */
	readonly #writer = new LatestWriter<PendingWrite>(async ({ action, brightness }) => {
		// device_on rides along: setting a brightness on a strip that is off should light it.
		await withDevice(action, () => deviceState.set({ brightness, device_on: true }));
	});

	override async onWillAppear(ev: WillAppearEvent<BrightnessSettings>): Promise<void> {
		this.#settings.set(ev.action.id, ev.payload.settings);
		this.#unsubscribes.get(ev.action.id)?.();
		this.#unsubscribes.set(
			ev.action.id,
			deviceState.subscribe(() => this.#onBroadcast(ev.action)),
		);

		if (ev.action.isDial()) {
			const dial = ev.action;
			await dial.setFeedbackLayout("$B1");
			await dial.setTriggerDescription({ push: "Toggle", rotate: "Brightness" });
		}

		this.#redraw(ev.action);

		// Both a dial (live bar) and an increment/decrement key (its starting point) need the
		// strip's current brightness, so prime the cache. Reads are collapsed and cached for a
		// couple of seconds, so a row of keys costs one request between them.
		await withDevice(ev.action, async () => {
			await deviceState.get();
		});
	}

	override async onWillDisappear(ev: WillDisappearEvent<BrightnessSettings>): Promise<void> {
		this.#unsubscribes.get(ev.action.id)?.();
		this.#unsubscribes.delete(ev.action.id);
		this.#working.delete(ev.action.id);
		this.#lastTick.delete(ev.action.id);
		this.#settings.delete(ev.action.id);
		this.#images.forget(ev.action.id);
		this.#redraws.forget(ev.action.id);
	}

	override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<BrightnessSettings>): Promise<void> {
		this.#settings.set(ev.action.id, ev.payload.settings);

		// A key's title is drawn from its settings, so it restyles as the slider moves.
		if (ev.action.isKey()) {
			this.#redraw(ev.action);
		}
	}

	override async onKeyDown(ev: KeyDownEvent<BrightnessSettings>): Promise<void> {
		const settings = ev.payload.settings;
		this.#settings.set(ev.action.id, settings);
		const mode = settings.mode ?? "set";

		await withDevice(ev.action, async () => {
			let brightness: number;
			if (mode === "set") {
				brightness = clamp(settings.value ?? DEFAULT_VALUE, BRIGHTNESS_MIN, BRIGHTNESS_MAX);
			} else {
				// Nudge from the strip's current brightness. Reading the cache synchronously lets
				// repeated presses accumulate — deviceState.set updates it before it awaits — and
				// only the very first press, on a cold cache, has to wait for a read.
				const current = deviceState.cached?.brightness ?? (await deviceState.get()).brightness;
				const step = settings.step ?? DEFAULT_STEP;
				const delta = mode === "increment" ? step : -step;
				brightness = clamp(Math.round(current + delta), BRIGHTNESS_MIN, BRIGHTNESS_MAX);
			}

			await deviceState.set({ device_on: true, brightness });
		});
	}

	override async onDialRotate(ev: DialRotateEvent<BrightnessSettings>): Promise<void> {
		const settings = ev.payload.settings;
		this.#settings.set(ev.action.id, settings);

		const current =
			this.#working.get(ev.action.id) ?? deviceState.cached?.brightness ?? settings.value ?? DEFAULT_VALUE;
		const delta = ev.payload.ticks * (settings.dialStep ?? DEFAULT_DIAL_STEP);
		const brightness = clamp(Math.round(current + delta), BRIGHTNESS_MIN, BRIGHTNESS_MAX);

		this.#working.set(ev.action.id, brightness);
		this.#lastTick.set(ev.action.id, Date.now());

		// Drawn before the write is even queued: the touch strip has to follow the hand.
		const dial = ev.action;
		this.#redraws.request(dial.id, () => this.#feedback(dial, brightness));
		this.#writer.push({ action: ev.action, brightness });
	}

	override async onDialDown(ev: DialDownEvent<BrightnessSettings>): Promise<void> {
		await withDevice(ev.action, async () => {
			const info = await deviceState.get();
			await deviceState.set({ device_on: !info.device_on });
		});
	}

	#onBroadcast(action: BrightnessAction): void {
		// A key's title comes from its own settings, so the strip's state never changes it.
		if (!action.isDial() || Date.now() - (this.#lastTick.get(action.id) ?? 0) < ROTATE_HOLD_MS) {
			return;
		}

		this.#redraw(action);
	}

	/** Redraws from the latest state when this instance's next update slot comes round. */
	#redraw(action: BrightnessAction): void {
		this.#redraws.request(action.id, () => this.#render(action, deviceState.cached));
	}

	async #render(action: BrightnessAction, info: DeviceInfo | undefined): Promise<void> {
		const settings: BrightnessSettings = this.#settings.get(action.id) ?? {};

		if (action.isKey()) {
			await action.setTitle(this.#keyTitle(settings));
			await this.#images.show(action, brightnessKey(settings.mode ?? "set", settings.value ?? DEFAULT_VALUE));
			return;
		}

		if (action.isDial()) {
			const brightness = clamp(
				Math.round(info?.brightness ?? this.#working.get(action.id) ?? settings.value ?? DEFAULT_VALUE),
				BRIGHTNESS_MIN,
				BRIGHTNESS_MAX,
			);
			this.#working.set(action.id, brightness);
			await this.#feedback(action, brightness);
		}
	}

	/** A key's title states what it will do: a target for "set", or the signed nudge otherwise. */
	#keyTitle(settings: BrightnessSettings): string {
		const mode = settings.mode ?? "set";
		const step = settings.step ?? DEFAULT_STEP;
		if (mode === "increment") {
			return `+${step}%`;
		}
		if (mode === "decrement") {
			return `−${step}%`;
		}
		return `${clamp(settings.value ?? DEFAULT_VALUE, BRIGHTNESS_MIN, BRIGHTNESS_MAX)}%`;
	}

	async #feedback(action: DialAction<BrightnessSettings>, brightness: number): Promise<void> {
		await action.setFeedback({
			title: "Brightness",
			value: `${brightness}%`,
			indicator: { value: brightness, bar_fill_c: BAR_FILL },
		});
	}
}
