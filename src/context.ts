import streamDeck from "@elgato/streamdeck";
import { TapoClient, TapoClientHolder, TapoError } from "./tapo/client.js";
import { userHash } from "./tapo/klap.js";
import { DeviceState } from "./tapo/state.js";
import { decodeField } from "./tapo/types.js";

/**
 * Plugin-wide settings. The strip is configured once, not per button.
 *
 * The password is never stored. The property inspector turns it into `authHash` as it is
 * typed — the same one-way hash the strip itself checks — and saves only that. `email` is
 * kept so the inspector can show which account is in use. `password` only exists in
 * settings saved by older versions, and is replaced by its hash the first time it is read.
 */
export type GlobalSettings = {
	ip?: string;
	email?: string;
	authHash?: string;
	password?: string;
};

/** What a successful test tells the inspector about the strip, for a compatibility report. */
type TestedDevice = { model: string; fw_ver: string; hw_ver: string };

/** The message the property inspector sends when the user presses "Test connection". */
type TestRequest = { event: "testConnection"; ip?: string; authHash?: string };

const holder = new TapoClientHolder();

/** Shared, cached view of the strip, used by every action. */
export const deviceState = new DeviceState(() => holder.require(), {
	// Logged on the transition only: a strip unplugged overnight would otherwise fill the log.
	onPollHealth: (err) => {
		if (err === undefined) {
			streamDeck.logger.info("The strip is answering again.");
		} else {
			const message = err instanceof TapoError ? err.message : String(err);
			streamDeck.logger.warn(`Lost contact with the strip; retrying less often. ${message}`);
		}
	},
});

/** True once an IP and credentials are both present. */
export function isConfigured(): boolean {
	return holder.current !== undefined;
}

/** Parses a stored hash, rejecting anything that is not exactly 32 bytes of hex. */
function parseAuthHash(value: unknown): Buffer | undefined {
	return typeof value === "string" && /^[0-9a-f]{64}$/i.test(value) ? Buffer.from(value, "hex") : undefined;
}

/** Rebuilds the client if the connection settings changed. */
function applyConnection(settings: GlobalSettings): void {
	const previous = holder.current;
	holder.update({ ip: settings.ip?.trim(), auth: parseAuthHash(settings.authHash) });

	if (holder.current !== previous) {
		deviceState.invalidate();
	}
}

/** The last settings written by a migration, so the same settings arriving twice are written once. */
let lastMigration: string | undefined;

/**
 * Settings saved before the hash existed hold the password in plain text. Hash it, and
 * write the settings back without it, so the password stops being stored at all.
 *
 * At startup the same old settings arrive twice — as the reply to `getGlobalSettings()` and,
 * through the SDK quirk described on `watchConnection`, as an event — hence `lastMigration`.
 */
async function migratePassword(settings: GlobalSettings): Promise<GlobalSettings> {
	const { password, ...rest } = settings;
	if (password === undefined) {
		return settings;
	}

	const email = settings.email?.trim();
	const migrated: GlobalSettings = { ...rest };
	if (email && password) {
		migrated.authHash = userHash(email, password).toString("hex");
	}

	const serialized = JSON.stringify(migrated);
	if (serialized === lastMigration) {
		return migrated;
	}
	lastMigration = serialized;

	await streamDeck.settings.setGlobalSettings(migrated);
	streamDeck.logger.info("Replaced the stored Tapo password with its hash.");
	return migrated;
}

/** Reads the global settings once, at startup. */
export async function loadConnection(): Promise<void> {
	const settings = await streamDeck.settings.getGlobalSettings<GlobalSettings>();
	applyConnection(await migratePassword(settings));
}

/**
 * Keeps the client in step with edits made in the property inspector.
 *
 * The listener must use the settings carried by the event and never fetch them again.
 * `getGlobalSettings()` is answered by a `didReceiveGlobalSettings` event, and the SDK only
 * keeps that reply away from this listener when `useExperimentalMessageIdentifiers` is on —
 * it is off by default. Fetching from here made the two re-trigger each other forever: a
 * request/reply ping-pong with Stream Deck that pinned the CPU and grew the host's memory.
 */
export function watchConnection(): void {
	streamDeck.settings.onDidReceiveGlobalSettings<GlobalSettings>((ev) => {
		void migratePassword(ev.settings).then(applyConnection);
	});
}

/**
 * Answers the property inspector's "Test connection" button.
 *
 * The test runs against the values in the form, on a client of its own, so it checks what
 * the user typed rather than whatever was saved before. A fresh handshake is the point: it
 * is what proves the address and the credentials.
 */
export function watchConnectionTests(): void {
	streamDeck.ui.onSendToPlugin<TestRequest>(async (ev) => {
		if (ev.payload?.event !== "testConnection") {
			return;
		}

		const ip = ev.payload.ip?.trim();
		const auth = parseAuthHash(ev.payload.authHash);
		let result: { event: "testResult"; ok: boolean; message: string; device?: TestedDevice };

		if (!ip || !auth) {
			result = { event: "testResult", ok: false, message: "Fill in the IP, email and password first." };
		} else {
			try {
				const info = await new TapoClient(ip, auth).getInfo();
				const name = decodeField(info.nickname) || info.model;
				result = {
					event: "testResult",
					ok: true,
					message: `Connected to ${name} (${info.model}, firmware ${info.fw_ver}).`,
					// Only what identifies the hardware: no nickname, network or account detail.
					device: { model: info.model, fw_ver: info.fw_ver, hw_ver: info.hw_ver ?? "" },
				};
			} catch (err) {
				result = { event: "testResult", ok: false, message: err instanceof TapoError ? err.message : String(err) };
			}
		}

		await streamDeck.ui.sendToPropertyInspector(result);

		// The keys may be showing an alert from before the settings were fixed; let them catch up.
		if (result.ok && isConfigured()) {
			void deviceState.get(true).catch(() => undefined);
		}
	});
}

/**
 * Runs a device operation, turning any failure into the Stream Deck's own alert
 * badge plus a log line. Actions call this instead of try/catch so that a strip that
 * is unplugged, or credentials that are wrong, surface on the key the user pressed.
 */
export async function withDevice(
	action: { showAlert(): Promise<void> },
	operation: () => Promise<void>,
): Promise<void> {
	if (!isConfigured()) {
		streamDeck.logger.warn("Strip is not configured; set IP, email and password in the plugin settings.");
		await action.showAlert();
		return;
	}

	try {
		await operation();
	} catch (err) {
		const message = err instanceof TapoError ? err.message : String(err);
		streamDeck.logger.error(`Device operation failed: ${message}`);
		await action.showAlert();
	}
}
