/**
 * The strip's address and credentials, shared by every action.
 *
 * The IP and email carry the `global` attribute, so they persist to the plugin's global
 * settings rather than to the action being edited: the user configures the strip once,
 * from whichever action they happen to have open, and all of them pick it up.
 *
 * The password is deliberately *not* a setting. It is turned into the KLAP account hash
 * (tapo-hash.js) as it is typed, and only the hash is saved — through the same sdpi store
 * the other fields use, since saving around it would let the store write its stale copy
 * back the next time the IP is edited. The password itself never leaves this page.
 *
 * The connection fields live in a collapsible section that opens by itself only while the
 * strip is not set up: once it is, every action's inspector stays short. The compatibility
 * link sits outside any section so it is always visible.
 *
 * Rendered into the light DOM so the sdpi components upgrade and style normally. Unlabelled
 * rows omit `label` entirely: sdpi-item prints "label:" for any label that is present, and
 * an empty one still counts, leaving a stray colon.
 */
const TEST_TIMEOUT_MS = 15000;

const REPO_URL = "https://github.com/migue802/StreamDeck-Tapo";

class TapoConnection extends HTMLElement {
	#savedHash;
	#saveHash;
	#ip = "";
	#password = "";
	#testTimer;
	/** True once the saved settings have arrived; until then there is nothing true to show. */
	#loaded = false;
	/**
	 * True once this page has saved a hash. Stream Deck loads the inspector afresh for every
	 * key, so this resets on its own as soon as the user moves on.
	 */
	#savedHere = false;
	/** The strip the last successful test reached, for the compatibility report. */
	#device;

	connectedCallback() {
		this.innerHTML = `
			<details class="tapo-section" id="tapo-connection-section">
				<summary>Strip connection <span class="tapo-summary-state" id="tapo-summary-state"></span></summary>
				<sdpi-item label="Strip IP">
					<sdpi-textfield id="tapo-ip" setting="ip" global placeholder="192.168.1.50" pattern="[A-Za-z0-9.\\-]+(:[0-9]{1,5})?" required></sdpi-textfield>
				</sdpi-item>
				<sdpi-item label="Tapo email">
					<sdpi-textfield id="tapo-email" setting="email" global placeholder="you@example.com" pattern="[^@\\s]+@[^@\\s]+" required></sdpi-textfield>
				</sdpi-item>
				<sdpi-item label="Tapo password">
					<sdpi-password id="tapo-password" placeholder="Tapo account password"></sdpi-password>
				</sdpi-item>
				<sdpi-item id="tapo-stored-item" hidden>
					<p class="tapo-status" id="tapo-stored"></p>
				</sdpi-item>
				<sdpi-item>
					<p class="tapo-hint">
						Only a one-way hash of your password is saved, and it goes only to the strip
						on your network.
					</p>
				</sdpi-item>
				<sdpi-item>
					<sdpi-button id="tapo-test">Test connection</sdpi-button>
				</sdpi-item>
				<sdpi-item id="tapo-result-item" hidden>
					<p class="tapo-status" id="tapo-result" role="status"></p>
				</sdpi-item>
			</details>
			<sdpi-item>
				<a class="tapo-link" id="tapo-report" href="#" title="Opens a GitHub issue with your light's model and firmware filled in">
					Works with your light, or not? Let me know ↗
				</a>
			</sdpi-item>
			<details class="tapo-section" id="tapo-help-section">
				<summary>Setup help</summary>
				<sdpi-item>
					<ol class="tapo-steps">
						<li>Find the strip's IP in the Tapo app: open the device › Settings › Device Info › IP Address.</li>
						<li>The strip must be on the same local network as this computer.</li>
						<li>Enable access in the Tapo app: Me › Third-Party Services › <em>Third-Party Compatibility</em>.</li>
					</ol>
				</sdpi-item>
				<sdpi-item>
					<a class="tapo-link" id="tapo-guide" href="#">Full setup guide ↗</a>
				</sdpi-item>
			</details>
		`;

		[, this.#saveHash] = SDPIComponents.useGlobalSettings(
			"authHash",
			(value) => {
				this.#savedHash = value;
				this.#onLoaded();
			},
			// Saved once typing pauses, not on every keystroke.
			400,
		);
		// Read only, to decide whether the strip is set up; the IP field saves itself.
		SDPIComponents.useGlobalSettings("ip", (value) => {
			this.#ip = (value ?? "").trim();
			this.#onLoaded();
		});

		// `input` only fires for the user's own typing, unlike `valuechange`, which also fires
		// when the store fills a field in from saved settings. composedPath()[0] is the
		// <input> inside the component's shadow root, so its value is already current.
		this.#field("tapo-password").addEventListener("input", (ev) => {
			this.#password = ev.composedPath()[0].value ?? "";
			this.#updateHash();
		});
		this.#field("tapo-email").addEventListener("input", () => this.#updateHash());
		this.#field("tapo-ip").addEventListener("input", (ev) => {
			this.#ip = (ev.composedPath()[0].value ?? "").trim();
			this.#showStored();
		});
		this.#field("tapo-test").addEventListener("click", () => this.#test());
		this.#field("tapo-report").addEventListener("click", (ev) => {
			ev.preventDefault();
			void this.#report();
		});
		this.#field("tapo-guide").addEventListener("click", (ev) => {
			ev.preventDefault();
			this.#openUrl(`${REPO_URL}#setup`);
		});

		SDPIComponents.streamDeckClient.sendToPropertyInspector.subscribe((message) => {
			if (message.payload?.event === "testResult") {
				this.#device = message.payload.ok ? message.payload.device : undefined;
				this.#showResult(message.payload.ok ? "ok" : "error", message.payload.message);
			}
		});

		this.#showStored();
	}

	#field(id) {
		return this.querySelector(`#${id}`);
	}

	#email() {
		return (this.#field("tapo-email").value ?? "").trim();
	}

	#hashOfTyped() {
		const email = this.#email();
		return email && this.#password ? window.tapoAuthHash(email, this.#password) : undefined;
	}

	#isConfigured() {
		return Boolean(this.#ip && this.#savedHash);
	}

	/**
	 * The first settings to arrive decide whether the connection section starts open: open
	 * when there is something to fill in, closed when the strip is already set up. Later
	 * changes leave it as the user put it.
	 */
	#onLoaded() {
		if (!this.#loaded) {
			this.#loaded = true;
			queueMicrotask(() => {
				this.#field("tapo-connection-section").open = !this.#isConfigured();
				this.#showStored();
			});
		}
		this.#showStored();
	}

	/**
	 * The hash covers the email too, so editing either one changes it. With a password typed
	 * the hash is recomputed; with none, an email edit leaves no valid hash to keep, and the
	 * old one is dropped rather than left to fail at the next handshake.
	 */
	#updateHash() {
		const hash = this.#hashOfTyped();
		if (hash) {
			this.#saveHash(hash);
		} else if (!this.#password && this.#savedHash) {
			this.#saveHash(undefined);
		} else {
			return;
		}

		// Stream Deck does not echo the inspector's own saves back to it, so the store's
		// callback never hears about this one; update what the page shows directly.
		this.#savedHash = hash;
		this.#savedHere = this.#savedHere || Boolean(hash);
		this.#showStored();
	}

	/**
	 * The note under the password field is for the moments it tells the user something: no
	 * password yet, or one just entered. A hash saved on an earlier visit needs no comment —
	 * the placeholder already says it is there — so the note stays hidden until the hash goes.
	 */
	#showStored() {
		const item = this.#field("tapo-stored-item");
		const stored = this.#field("tapo-stored");
		const password = this.#field("tapo-password");
		const state = this.#field("tapo-summary-state");
		if (!item || !stored || !password || !state) {
			return;
		}

		item.hidden = !this.#loaded || (Boolean(this.#savedHash) && !this.#savedHere);

		if (this.#savedHash) {
			stored.className = "tapo-status ok";
			stored.textContent = "🔒 Saved as a one-way hash, not as your password.";
		} else {
			stored.className = "tapo-status";
			stored.textContent = "Not set. The password is needed once, to compute the hash.";
		}

		state.textContent = !this.#loaded ? "" : this.#isConfigured() ? "Set up" : "Not set up";
		state.classList.toggle("ok", this.#isConfigured());

		// sdpi-components' hasChanged for text properties is inverted — it reports a change
		// only when the old and new values are *equal* — so swapping one placeholder for
		// another is ignored. Clearing it first is a change it does register.
		password.removeAttribute("placeholder");
		password.setAttribute("placeholder", this.#savedHash ? "Saved — type to replace" : "Tapo account password");
	}

	#showResult(kind, text) {
		clearTimeout(this.#testTimer);
		const item = this.#field("tapo-result-item");
		const result = this.#field("tapo-result");
		item.hidden = false;
		result.className = `tapo-status ${kind}`;
		result.textContent = kind === "ok" ? `✓ ${text}` : kind === "error" ? `✗ ${text}` : text;
		this.#field("tapo-test").disabled = kind === "pending";
	}

	/** Tests what is in the form, whether or not it has been saved yet. */
	#test() {
		const ip = (this.#field("tapo-ip").value ?? "").trim();
		const authHash = this.#hashOfTyped() ?? this.#savedHash;

		if (!ip || !authHash) {
			this.#showResult("error", "Fill in the IP, email and password first.");
			return;
		}

		this.#showResult("pending", "Testing…");
		this.#testTimer = setTimeout(
			() => this.#showResult("error", "The plugin did not answer. Is it running?"),
			TEST_TIMEOUT_MS,
		);
		SDPIComponents.streamDeckClient.send("sendToPlugin", { event: "testConnection", ip, authHash });
	}

	/**
	 * Opens a compatibility report on GitHub. The issue form's fields are filled in from the
	 * URL: the light's model and firmware from the last successful test, plus the plugin and
	 * Stream Deck versions. Nothing is sent anywhere unless the user submits the issue, and
	 * they see every value first. No name, address or account detail is included.
	 */
	async #report() {
		const params = new URLSearchParams({ template: "compatibility.yml", labels: "compatibility" });
		const { info } = await SDPIComponents.streamDeckClient.getConnectionInfo();

		if (this.#device) {
			params.set("title", `[Compatibility] ${this.#device.model}`);
			params.set("model", this.#device.model ?? "");
			params.set("firmware", this.#device.fw_ver ?? "");
			params.set("hardware", this.#device.hw_ver ?? "");
		}
		if (info?.plugin?.version) {
			params.set("plugin_version", info.plugin.version);
		}
		if (info?.application?.version) {
			params.set("stream_deck", `${info.application.version} (${info.application.platform ?? "unknown OS"})`);
		}

		this.#openUrl(`${REPO_URL}/issues/new?${params}`);
	}

	/** Links have to be opened by Stream Deck, in the default browser, not inside the inspector. */
	#openUrl(url) {
		SDPIComponents.streamDeckClient.send("openUrl", { url });
	}
}

customElements.define("tapo-connection", TapoConnection);
