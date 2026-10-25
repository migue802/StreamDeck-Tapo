import http from "node:http";

import { handshake2Payload, KlapCipher, newLocalSeed, serverHash } from "./klap.js";
import type { DeviceInfo, SetDeviceInfoParams, TapoConnection } from "./types.js";

export class TapoError extends Error {
	constructor(
		message: string,
		readonly kind: "auth" | "network" | "device" | "config" = "device",
	) {
		super(message);
		this.name = "TapoError";
	}
}

const REQUEST_TIMEOUT_MS = 5000;

type RawResponse = {
	status: number;
	body: Buffer;
	setCookie: string | undefined;
};

/**
 * Local KLAP client for a Tapo device.
 *
 * Two behaviours matter for a long-lived plugin process:
 *
 * - Requests are serialized. The cipher's sequence number must reach the device in
 *   ascending order, so overlapping requests (two actions firing at once) would race
 *   and be rejected.
 * - Sessions expire. Any request that fails re-handshakes once and retries, so the
 *   plugin recovers without the user noticing.
 */
export class TapoClient {
	#ip: string;
	#auth: Buffer;
	#cipher: KlapCipher | undefined;
	#cookie: string | undefined;
	/** Promise chain that serializes requests. */
	#queue: Promise<unknown> = Promise.resolve();

	/**
	 * @param auth The account hash from `userHash()`. The client never sees the password
	 * itself: the hash is all KLAP needs, and it is all the plugin stores.
	 */
	constructor(ip: string, auth: Buffer) {
		this.#ip = ip;
		this.#auth = auth;
	}

	get #host(): string {
		return this.#ip.split(":")[0];
	}

	/** Devices listen on port 80; a port is only ever present when testing against a mock. */
	get #port(): number {
		const port = Number(this.#ip.split(":")[1]);
		return Number.isFinite(port) && port > 0 ? port : 80;
	}

	/** True once a handshake has completed and a session cipher exists. */
	get isConnected(): boolean {
		return this.#cipher !== undefined;
	}

	/**
	 * Sends one request to the device.
	 *
	 * This uses `node:http` rather than `fetch` for one non-obvious reason: the strip's HTTP
	 * parser matches `Content-Length` case-sensitively, and answers 400 to the lowercase
	 * spelling. The fetch specification requires header names to be lowercased, and undici
	 * obeys it, so `fetch` can never talk to this device — no combination of options helps.
	 * `node:http` sends header names exactly as written here, which is why they are spelled
	 * canonically below. Do not lowercase them.
	 */
	#post(path: string, body: Buffer, query?: Record<string, string>): Promise<RawResponse> {
		const search = new URLSearchParams(query ?? {}).toString();

		const headers: Record<string, string | number> = { "Content-Length": body.length };
		if (this.#cookie) {
			headers["Cookie"] = this.#cookie;
		}

		return new Promise<RawResponse>((resolve, reject) => {
			const fail = (reason: string): void => {
				reject(new TapoError(`Cannot reach the device at ${this.#ip} (${reason}).`, "network"));
			};

			const req = http.request(
				{
					host: this.#host,
					port: this.#port,
					path: `/app/${path}${search ? `?${search}` : ""}`,
					method: "POST",
					headers,
				},
				(res) => {
					const chunks: Buffer[] = [];
					res.on("data", (chunk: Buffer) => chunks.push(chunk));
					res.on("error", (err) => fail(err.message));
					res.on("end", () =>
						resolve({
							status: res.statusCode ?? 0,
							body: Buffer.concat(chunks),
							setCookie: res.headers["set-cookie"]?.[0],
						}),
					);
				},
			);

			req.on("error", (err) => fail(err.message));
			req.setTimeout(REQUEST_TIMEOUT_MS, () => {
				req.destroy();
				fail("timed out");
			});

			req.end(body);
		});
	}

	/**
	 * Performs the two-stage KLAP handshake and negotiates a session cipher.
	 *
	 * `handshake1` returns the session cookie the device expects on every subsequent
	 * request. There is no cookie jar here, so it is captured and replayed by hand.
	 */
	async login(): Promise<void> {
		this.#cipher = undefined;
		this.#cookie = undefined;

		const localSeed = newLocalSeed();
		const first = await this.#post("handshake1", localSeed);

		if (first.status === 403) {
			throw new TapoError(
				"The device refused the handshake (403). Enable 'Third-Party Compatibility' in the Tapo app under the device's settings.",
				"auth",
			);
		}

		if (first.status !== 200 || first.body.length < 48) {
			throw new TapoError(`Handshake failed (HTTP ${first.status}).`, "network");
		}

		// The cookie must be captured before handshake2, which is already session-scoped.
		if (first.setCookie) {
			this.#cookie = first.setCookie.split(";")[0];
		}

		const remoteSeed = first.body.subarray(0, 16);
		const expected = first.body.subarray(16, 48);
		if (!serverHash(localSeed, remoteSeed, this.#auth).equals(expected)) {
			throw new TapoError("Incorrect Tapo email or password.", "auth");
		}

		const second = await this.#post("handshake2", handshake2Payload(localSeed, remoteSeed, this.#auth));
		if (second.status < 200 || second.status >= 300) {
			throw new TapoError(`Handshake failed (HTTP ${second.status}).`, "auth");
		}

		this.#cipher = new KlapCipher(localSeed, remoteSeed, this.#auth);
	}

	async #send(method: string, params: unknown): Promise<unknown> {
		if (!this.#cipher) {
			await this.login();
		}

		const envelope = Buffer.from(JSON.stringify({ method, params }));
		const { body, seq } = this.#cipher!.encrypt(envelope);
		const response = await this.#post("request", body, { seq: String(seq) });

		if (response.status !== 200) {
			throw new TapoError(`${method} failed (HTTP ${response.status}).`, "device");
		}

		const decrypted = this.#cipher!.decrypt(response.body, seq);
		const result = JSON.parse(decrypted.toString("utf8")) as { error_code?: number; result?: unknown };

		if (result.error_code !== 0) {
			throw new TapoError(`${method} returned error_code ${result.error_code}.`, "device");
		}

		return result.result;
	}

	/**
	 * Serializes the request, and re-handshakes once if the session has gone stale.
	 * An auth or config failure is not retried — retrying a wrong password only
	 * risks the device rate-limiting us.
	 */
	async request<T>(method: string, params: unknown = null): Promise<T> {
		const run = this.#queue.then(
			async () => {
				try {
					return await this.#send(method, params);
				} catch (err) {
					if (err instanceof TapoError && err.kind === "auth") {
						throw err;
					}

					this.#cipher = undefined;
					await this.login();
					return await this.#send(method, params);
				}
			},
			async () => {
				// A prior request failing must not poison the queue for this one.
				return await this.#send(method, params);
			},
		);

		// Keep the chain alive regardless of this request's outcome.
		this.#queue = run.catch(() => undefined);
		return run as Promise<T>;
	}

	getInfo(): Promise<DeviceInfo> {
		return this.request<DeviceInfo>("get_device_info");
	}

	setInfo(params: SetDeviceInfoParams): Promise<unknown> {
		return this.request("set_device_info", params);
	}
}

/**
 * Holds the single client shared by every action, rebuilt whenever the connection
 * settings change. One strip, one session.
 */
export class TapoClientHolder {
	#client: TapoClient | undefined;
	#key = "";

	/** Rebuilds the client if the connection details changed. Returns undefined when unconfigured. */
	update(connection: TapoConnection): TapoClient | undefined {
		const { ip, auth } = connection;
		if (!ip || !auth) {
			this.#client = undefined;
			this.#key = "";
			return undefined;
		}

		const key = `${ip} ${auth.toString("hex")}`;
		if (key !== this.#key) {
			this.#key = key;
			this.#client = new TapoClient(ip, auth);
		}

		return this.#client;
	}

	get current(): TapoClient | undefined {
		return this.#client;
	}

	/** Returns the configured client, or throws a message suitable for surfacing to the user. */
	require(): TapoClient {
		if (!this.#client) {
			throw new TapoError("Set the strip's IP, email and password in the plugin settings first.", "config");
		}
		return this.#client;
	}
}
