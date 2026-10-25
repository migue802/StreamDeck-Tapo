import { action, SingletonAction } from "@elgato/streamdeck";
import type {
	DialAction,
	DialDownEvent,
	DialRotateEvent,
	KeyAction,
	KeyDownEvent,
	WillAppearEvent,
	WillDisappearEvent,
} from "@elgato/streamdeck";

import { deviceState, withDevice } from "../context.js";
import { KeyImages } from "../render/images.js";
import { svgDataUrl, toggleKey } from "../render/keys.js";
import { Redraws } from "../render/redraw.js";
import { LatestWriter } from "../tapo/coalesce.js";
import { BRIGHTNESS_MAX, BRIGHTNESS_MIN, clamp, decodeField } from "../tapo/types.js";
import type { DeviceInfo } from "../tapo/types.js";

/** The strip is configured plugin-wide, so this action holds no settings of its own. */
type ToggleSettings = Record<string, never>;

/** An instance of this action, whichever hardware it landed on. */
type ToggleAction = DialAction<ToggleSettings> | KeyAction<ToggleSettings>;

/**
 * How long a rotation target is trusted after the last tick. The dial counts from its own
 * target while it is turning, because the strip reports brightness slower than the user can
 * rotate; once the dial has been still for this long, the device's reading is the truth again.
 */
const ROTATION_IDLE_MS = 500;

/**
 * Turns the strip on or off; on a dial, rotating also sets the brightness. The key's image is
 * drawn live from the strip's state: its colour and brightness when on, a grey outline when off.
 */
@action({ UUID: "com.migue802.tapo-lights.toggle" })
export class Toggle extends SingletonAction<ToggleSettings> {
	#unsubscribers = new Map<string, () => void>();
	#writers = new Map<string, LatestWriter<number>>();
	#rotations = new Map<string, { target: number; at: number }>();
	#images = new KeyImages();
	#redraws = new Redraws();

	override async onWillAppear(ev: WillAppearEvent<ToggleSettings>): Promise<void> {
		const instance = ev.action;

		this.#unsubscribers.get(instance.id)?.();
		this.#unsubscribers.set(
			instance.id,
			deviceState.subscribe(() => this.#redraw(instance)),
		);

		if (instance.isDial()) {
			await instance.setTriggerDescription({ push: "Toggle", rotate: "Brightness" });
		}

		this.#redraw(instance);
		// The read broadcasts whatever it finds, which redraws this instance along with the rest.
		await withDevice(instance, async () => {
			await deviceState.get();
		});
	}

	override onWillDisappear(ev: WillDisappearEvent<ToggleSettings>): void {
		this.#unsubscribers.get(ev.action.id)?.();
		this.#unsubscribers.delete(ev.action.id);
		this.#writers.delete(ev.action.id);
		this.#rotations.delete(ev.action.id);
		this.#images.forget(ev.action.id);
		this.#redraws.forget(ev.action.id);
	}

	override async onKeyDown(ev: KeyDownEvent<ToggleSettings>): Promise<void> {
		await this.#toggle(ev.action);
	}

	override async onDialDown(ev: DialDownEvent<ToggleSettings>): Promise<void> {
		await this.#toggle(ev.action);
	}

	override onDialRotate(ev: DialRotateEvent<ToggleSettings>): void {
		const previous = this.#rotations.get(ev.action.id);
		const base =
			previous && Date.now() - previous.at < ROTATION_IDLE_MS
				? previous.target
				: (deviceState.cached?.brightness ?? BRIGHTNESS_MIN);

		const target = clamp(base + ev.payload.ticks, BRIGHTNESS_MIN, BRIGHTNESS_MAX);
		this.#rotations.set(ev.action.id, { target, at: Date.now() });
		this.#writerFor(ev.action).push(target);

		// Follow the dial now; the device's own reading only lands a write later.
		const dial = ev.action;
		this.#redraws.request(dial.id, () => dial.setFeedback({ value: `${target}%`, indicator: { value: target } }));
	}

	async #toggle(instance: ToggleAction): Promise<void> {
		await withDevice(instance, async () => {
			// Read the cache synchronously where possible. `deviceState.set` updates it before
			// it awaits anything, so two quick presses cannot both observe the pre-toggle value
			// and cancel each other out — which an `await get()` here would allow.
			const info = deviceState.cached ?? (await deviceState.get());
			await deviceState.set({ device_on: !info.device_on });
		});
	}

	#writerFor(instance: DialAction<ToggleSettings>): LatestWriter<number> {
		let writer = this.#writers.get(instance.id);
		if (!writer) {
			// Reaching for the brightness of a dark strip is a request for light, not just a number.
			writer = new LatestWriter<number>((brightness) =>
				withDevice(instance, () => deviceState.set({ device_on: true, brightness })),
			);
			this.#writers.set(instance.id, writer);
		}

		return writer;
	}

	/** Redraws from the latest state when this instance's next update slot comes round. */
	#redraw(instance: ToggleAction): void {
		this.#redraws.request(instance.id, () => this.#render(instance, deviceState.cached));
	}

	async #render(instance: ToggleAction, info: DeviceInfo | undefined): Promise<void> {
		const on = info?.device_on ?? false;

		if (instance.isKey()) {
			// The state still tracks on/off for anything that reads it (a multi-action, say);
			// the image drawn over it is what shows the strip's actual colour and brightness.
			await this.#images.state(instance, on ? 1 : 0);
			await this.#images.show(instance, toggleKey(info));
		} else if (instance.isDial()) {
			const brightness = info?.brightness ?? 0;
			await instance.setFeedback({
				title: decodeField(info?.nickname) || "Tapo L900",
				icon: svgDataUrl(toggleKey(info)),
				value: on ? `${brightness}%` : "Off",
				indicator: { value: on ? brightness : 0 },
			});
		}
	}
}
