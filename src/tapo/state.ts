import { TapoError } from "./client.js";
import type { TapoClient } from "./client.js";
import type { DeviceInfo, SetDeviceInfoParams } from "./types.js";

type Listener = (info: DeviceInfo | undefined) => void;

/** How long a cached reading is trusted before the next read refetches it. */
const CACHE_TTL_MS = 2000;

/** How often the strip is re-read while any key is showing its state. */
export const POLL_MS = 5000;

/** Longest wait between reads of a strip that keeps failing to answer. */
export const POLL_MAX_MS = 60000;

export type DeviceStateOptions = {
	/** Called once when polling starts failing, and once when it recovers (with `undefined`). */
	onPollHealth?: (error: unknown) => void;
};

/**
 * The parts of a reading that something on a key or dial is drawn from. Anything else —
 * the Wi-Fi signal above all, which moves on nearly every read — must not count as a change,
 * or polling would redraw every key on every poll.
 */
function visible(info: DeviceInfo | undefined): string {
	if (!info) {
		return "null";
	}
	const { device_on, brightness, hue, saturation, color_temp, nickname, lighting_effect } = info;
	return JSON.stringify([device_on, brightness, hue, saturation, color_temp, nickname, Boolean(lighting_effect?.enable)]);
}

/**
 * Shared, cached view of the strip's state.
 *
 * Every action reads through this rather than calling the device itself, so a row of
 * buttons appearing at once costs one request instead of six. Writes are applied to
 * the cache optimistically and broadcast, which keeps unrelated actions (the toggle
 * key, say) visually in sync with a dial the user is turning right now.
 *
 * The strip has no way to announce a change made elsewhere — the Tapo app hears about it
 * through TP-Link's cloud, which a local plugin has no part in — so while anything is
 * subscribed the state is re-read every few seconds. A read that changes nothing visible
 * broadcasts nothing, so an idle strip costs one small local request per poll and no
 * traffic to Stream Deck at all.
 */
export class DeviceState {
	#info: DeviceInfo | undefined;
	#fetchedAt = 0;
	#inFlight: Promise<DeviceInfo> | undefined;
	#listeners = new Set<Listener>();
	/** What listeners last saw, so a re-read that changed nothing redraws nothing. */
	#lastEmitted: string | undefined;

	#pollTimer: ReturnType<typeof setTimeout> | undefined;
	#pollDelay = POLL_MS;
	#pollFailing = false;

	constructor(
		private readonly getClient: () => TapoClient,
		private readonly options: DeviceStateOptions = {},
	) {}

	get cached(): DeviceInfo | undefined {
		return this.#info;
	}

	/** Subscribes to changes. Polling runs for as long as at least one subscriber exists. */
	subscribe(listener: Listener): () => void {
		this.#listeners.add(listener);
		if (this.#listeners.size === 1) {
			this.#schedulePoll();
		}

		return () => {
			this.#listeners.delete(listener);
			if (this.#listeners.size === 0) {
				clearTimeout(this.#pollTimer);
				this.#pollTimer = undefined;
			}
		};
	}

	/**
	 * Broadcasts the state, but only when something drawn from it changed. Every listener
	 * answers with a message to Stream Deck (a title, a key state, a dial redraw), so repeating
	 * an unchanged reading to a whole profile of keys is pure load on the host.
	 */
	#emit(): void {
		const snapshot = visible(this.#info);
		if (snapshot === this.#lastEmitted) {
			return;
		}
		this.#lastEmitted = snapshot;

		for (const listener of this.#listeners) {
			listener(this.#info);
		}
	}

	/** Drops the cache, e.g. after the connection settings changed. */
	invalidate(): void {
		this.#info = undefined;
		this.#fetchedAt = 0;
		this.#emit();
	}

	/** Returns the strip's state, refetching only when the cached copy is stale. */
	async get(force = false): Promise<DeviceInfo> {
		const fresh = this.#info && Date.now() - this.#fetchedAt < CACHE_TTL_MS;
		if (!force && fresh) {
			return this.#info!;
		}

		// Collapse concurrent reads onto a single request.
		this.#inFlight ??= Promise.resolve()
			.then(() => this.getClient().getInfo())
			.then((info) => {
				this.#info = info;
				this.#fetchedAt = Date.now();
				this.#emit();
				return info;
			})
			.finally(() => {
				this.#inFlight = undefined;
			});

		return this.#inFlight;
	}

	/** Applies a change to the strip, updating the cache optimistically. */
	async set(params: SetDeviceInfoParams): Promise<void> {
		if (this.#info) {
			this.#info = { ...this.#info, ...params } as DeviceInfo;
			this.#fetchedAt = Date.now();
			this.#emit();
		}

		try {
			await this.getClient().setInfo(params);
		} catch (err) {
			// The optimistic value may be a lie; force a re-read next time.
			this.#fetchedAt = 0;
			throw err;
		}
	}

	#schedulePoll(): void {
		clearTimeout(this.#pollTimer);
		this.#pollTimer = setTimeout(() => void this.#poll(), this.#pollDelay);
		// Polling serves whatever else keeps the process alive; it must never be the reason to.
		this.#pollTimer.unref?.();
	}

	/**
	 * One poll. A cache refreshed by a write moments ago counts as fresh, so a poll never
	 * lands in the middle of a dial turn to read back a value the strip has not reached yet.
	 *
	 * A strip that stops answering is shown as unknown rather than left on its last colour,
	 * and asked less and less often (doubling up to POLL_MAX_MS) until it answers again.
	 * Missing settings are not a failure: there is simply nothing to ask yet.
	 */
	async #poll(): Promise<void> {
		this.#pollTimer = undefined;
		try {
			await this.get();
			this.#pollDelay = POLL_MS;
			if (this.#pollFailing) {
				this.#pollFailing = false;
				this.options.onPollHealth?.(undefined);
			}
		} catch (err) {
			if (err instanceof TapoError && err.kind === "config") {
				this.#pollDelay = POLL_MS;
			} else {
				this.#pollDelay = Math.min(this.#pollDelay * 2, POLL_MAX_MS);
				if (!this.#pollFailing) {
					this.#pollFailing = true;
					this.invalidate();
					this.options.onPollHealth?.(err);
				}
			}
		} finally {
			if (this.#listeners.size > 0 && this.#pollTimer === undefined) {
				this.#schedulePoll();
			}
		}
	}
}
