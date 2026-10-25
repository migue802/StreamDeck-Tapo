/**
 * Sends only the most recent value, and only one at a time.
 *
 * A dial emits rotate events far faster than the strip can answer them, so writing
 * on every tick would queue up requests and leave the light lagging seconds behind
 * the user's hand. Instead, values pushed while a write is in flight overwrite each
 * other, and the newest survivor is sent once the device is free. Rotating fast
 * therefore costs about as many requests as rotating slowly, and the light always
 * settles on the value the dial actually stopped at.
 */
export class LatestWriter<T> {
	#pending: T | undefined;
	#hasPending = false;
	#inFlight = false;

	constructor(
		private readonly write: (value: T) => Promise<void>,
		private readonly onError?: (err: unknown) => void,
	) {}

	push(value: T): void {
		this.#pending = value;
		this.#hasPending = true;
		void this.#drain();
	}

	async #drain(): Promise<void> {
		if (this.#inFlight) {
			return;
		}

		this.#inFlight = true;
		try {
			while (this.#hasPending) {
				const value = this.#pending as T;
				this.#hasPending = false;

				try {
					await this.write(value);
				} catch (err) {
					this.onError?.(err);
				}
			}
		} finally {
			this.#inFlight = false;
		}
	}
}
