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
import { KELVIN_STOPS, temperatureKey } from "../render/keys.js";
import { Redraws } from "../render/redraw.js";
import { LatestWriter } from "../tapo/coalesce.js";
import { clamp, TEMP_MAX, TEMP_MIN } from "../tapo/types.js";

export type TemperatureSettings = {
	kelvin?: number;
	step?: number;
};

/** Neutral white, and the value to fall back on whenever no usable reading exists. */
const DEFAULT_KELVIN = 4000;
const DEFAULT_STEP = 100;

/** Warm through neutral to cool: the same scale the key draws, as a touch-strip gradient. */
const TEMP_GRADIENT = KELVIN_STOPS.map(([stop, color]) => `${stop}:${color}`).join(",");

/**
 * How long after a tick a broadcast stops reseeding the dial's working value.
 *
 * Writes are coalesced, so the strip's reported temperature lags the dial. A read that
 * began before the turn would otherwise snap the dial back to the old Kelvin mid-rotation,
 * and the next tick would carry on from there.
 */
const ROTATE_GRACE_MS = 1500;

type TemperatureAction = DialAction<TemperatureSettings> | KeyAction<TemperatureSettings>;

@action({ UUID: "com.migue802.tapo-lights.temperature" })
export class Temperature extends SingletonAction<TemperatureSettings> {
	#unsubscribes = new Map<string, () => void>();
	#writers = new Map<string, LatestWriter<number>>();
	/** Kelvin the dial currently shows, per instance; the strip lags behind it while turning. */
	#working = new Map<string, number>();
	#lastTick = new Map<string, number>();
	/**
	 * Settings are mirrored from event payloads rather than fetched. `getSettings()` is answered
	 * by a `didReceiveSettings` event, which the SDK routes back into `onDidReceiveSettings`
	 * unless `useExperimentalMessageIdentifiers` is on — and it is off by default. Fetching from
	 * a render would therefore make the two re-trigger each other without end.
	 */
	#settings = new Map<string, TemperatureSettings>();
	#images = new KeyImages();
	#redraws = new Redraws();

	override async onWillAppear(ev: WillAppearEvent<TemperatureSettings>): Promise<void> {
		const target = ev.action;
		this.#settings.set(target.id, ev.payload.settings);

		if (target.isDial()) {
			// Only a dial follows the strip: a key's title and image come from its own settings,
			// so it does not subscribe — and does not keep the strip being polled on its behalf.
			const dial = target;
			this.#unsubscribes.get(dial.id)?.();
			this.#unsubscribes.set(
				dial.id,
				deviceState.subscribe((info) => {
					// A reading taken before the last write landed would snap the dial back mid-turn,
					// and the following tick would carry on from that stale value.
					if (Date.now() - (this.#lastTick.get(dial.id) ?? 0) < ROTATE_GRACE_MS) {
						return;
					}

					const reported = info?.color_temp;
					// A reported 0 means the strip is in colour mode, not that it is at TEMP_MIN.
					if (reported) {
						this.#working.set(dial.id, clamp(reported, TEMP_MIN, TEMP_MAX));
					}
					this.#redraw(dial);
				}),
			);

			this.#writers.set(
				dial.id,
				new LatestWriter<number>(async (kelvin) => {
					await withDevice(dial, () => deviceState.set({ color_temp: kelvin, device_on: true }));
				}),
			);

			await dial.setFeedbackLayout("$B2");
			await dial.setTriggerDescription({ push: "Toggle", rotate: "Temperature" });
		}

		this.#redraw(target);
	}

	override onWillDisappear(ev: WillDisappearEvent<TemperatureSettings>): void {
		this.#unsubscribes.get(ev.action.id)?.();
		this.#unsubscribes.delete(ev.action.id);
		this.#writers.delete(ev.action.id);
		this.#working.delete(ev.action.id);
		this.#lastTick.delete(ev.action.id);
		this.#settings.delete(ev.action.id);
		this.#images.forget(ev.action.id);
		this.#redraws.forget(ev.action.id);
	}

	override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<TemperatureSettings>): Promise<void> {
		this.#settings.set(ev.action.id, ev.payload.settings);
		this.#redraw(ev.action);
	}

	override async onKeyDown(ev: KeyDownEvent<TemperatureSettings>): Promise<void> {
		this.#settings.set(ev.action.id, ev.payload.settings);

		const kelvin = clamp(ev.payload.settings.kelvin ?? DEFAULT_KELVIN, TEMP_MIN, TEMP_MAX);
		await withDevice(ev.action, () => deviceState.set({ device_on: true, color_temp: kelvin }));
	}

	override async onDialRotate(ev: DialRotateEvent<TemperatureSettings>): Promise<void> {
		this.#settings.set(ev.action.id, ev.payload.settings);
		this.#lastTick.set(ev.action.id, Date.now());

		const step = ev.payload.settings.step ?? DEFAULT_STEP;
		const next = clamp(this.#kelvinFor(ev.action.id) + ev.payload.ticks * step, TEMP_MIN, TEMP_MAX);
		this.#working.set(ev.action.id, next);

		// The dial must track the hand, so draw now and let the writer catch the strip up.
		const dial = ev.action;
		this.#redraws.request(dial.id, () => this.#renderDial(dial, next));
		this.#writers.get(ev.action.id)?.push(next);
	}

	override async onDialDown(ev: DialDownEvent<TemperatureSettings>): Promise<void> {
		await withDevice(ev.action, async () => {
			const info = await deviceState.get();
			await deviceState.set({ device_on: !info.device_on });
		});
	}

	/**
	 * The strip reports `color_temp` 0 while in colour mode, so a cached 0 must not be clamped
	 * to TEMP_MIN — that would make the first tick jump to 2500. Start from neutral white instead.
	 */
	#kelvinFor(id: string): number {
		const working = this.#working.get(id);
		if (working !== undefined) {
			return working;
		}

		const cached = deviceState.cached?.color_temp;
		return cached ? clamp(cached, TEMP_MIN, TEMP_MAX) : DEFAULT_KELVIN;
	}

	/** Redraws from the latest state when this instance's next update slot comes round. */
	#redraw(target: TemperatureAction): void {
		this.#redraws.request(target.id, () => this.#render(target));
	}

	async #render(target: TemperatureAction): Promise<void> {
		if (target.isKey()) {
			const kelvin = clamp(this.#settings.get(target.id)?.kelvin ?? DEFAULT_KELVIN, TEMP_MIN, TEMP_MAX);
			await target.setTitle(`${kelvin}K`);
			await this.#images.show(target, temperatureKey(kelvin));
			return;
		}

		if (target.isDial()) {
			await this.#renderDial(target, this.#kelvinFor(target.id));
		}
	}

	async #renderDial(dial: DialAction<TemperatureSettings>, kelvin: number): Promise<void> {
		await dial.setFeedback({
			title: "White",
			value: `${kelvin}K`,
			indicator: {
				value: Math.round(((kelvin - TEMP_MIN) / (TEMP_MAX - TEMP_MIN)) * 100),
				bar_bg_c: TEMP_GRADIENT,
			},
		});
	}
}
