/** Stream Deck's guidelines allow at most 10 programmatic updates per second to a key or dial. */
export const REDRAW_INTERVAL_MS = 100;

type Pending = { draw: () => Promise<void>; timer: ReturnType<typeof setTimeout> };

/**
 * Keeps each action instance within that limit without ever dropping the last update.
 *
 * A redraw requested soon after the previous one is held until the interval has passed;
 * requests arriving meanwhile replace it, so a fast dial turn costs ten redraws a second
 * and the key still ends on exactly the final value. A redraw with nothing in the way runs
 * at once, so a single press or tick feels no delay at all.
 */
export class Redraws {
	#lastAt = new Map<string, number>();
	#pending = new Map<string, Pending>();

	request(id: string, draw: () => Promise<void>): void {
		const pending = this.#pending.get(id);
		if (pending) {
			pending.draw = draw;
			return;
		}

		const wait = (this.#lastAt.get(id) ?? -Infinity) + REDRAW_INTERVAL_MS - Date.now();
		if (wait <= 0) {
			this.#run(id, draw);
			return;
		}

		const entry: Pending = {
			draw,
			timer: setTimeout(() => {
				this.#pending.delete(id);
				this.#run(id, entry.draw);
			}, wait),
		};
		this.#pending.set(id, entry);
	}

	/** Drops a disappearing instance, including a redraw still waiting for its slot. */
	forget(id: string): void {
		clearTimeout(this.#pending.get(id)?.timer);
		this.#pending.delete(id);
		this.#lastAt.delete(id);
	}

	#run(id: string, draw: () => Promise<void>): void {
		this.#lastAt.set(id, Date.now());
		// A key that vanished mid-draw rejects; there is nothing useful to do about it.
		void draw().catch(() => undefined);
	}
}
