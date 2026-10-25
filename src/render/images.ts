import { svgDataUrl } from "./keys.js";

/** The part of an action instance that can show an image and a state. */
type ImageTarget = { readonly id: string; setImage(image?: string): Promise<void> };
type StateTarget = { readonly id: string; setState(state: 0 | 1): Promise<void> };

/**
 * Remembers the image and state each key last received, and skips sending them again.
 *
 * Every message to Stream Deck costs the host work, and counts against the guidelines' ten
 * updates a second per key. Most redraws — a poll that found nothing new, a settings echo —
 * would resend exactly what the key already shows. Forget a key when it disappears: Stream
 * Deck puts the manifest's defaults back, so the next appearance has to send them again.
 */
export class KeyImages {
	#images = new Map<string, string>();
	#states = new Map<string, 0 | 1>();

	/** Shows an SVG on the key, sent as the data URL Stream Deck needs. */
	async show(target: ImageTarget, svg: string): Promise<void> {
		if (this.#images.get(target.id) === svg) {
			return;
		}
		this.#images.set(target.id, svg);
		await target.setImage(svgDataUrl(svg));
	}

	async state(target: StateTarget, state: 0 | 1): Promise<void> {
		if (this.#states.get(target.id) === state) {
			return;
		}
		this.#states.set(target.id, state);
		await target.setState(state);
	}

	forget(id: string): void {
		this.#images.delete(id);
		this.#states.delete(id);
	}
}
