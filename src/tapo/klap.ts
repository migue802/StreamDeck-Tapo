import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const sha1 = (data: Buffer): Buffer => createHash("sha1").update(data).digest();
const sha256 = (data: Buffer): Buffer => createHash("sha256").update(data).digest();

/**
 * The sequence number is a *signed* 32-bit big-endian integer. Roughly half of all
 * handshakes derive a negative starting value, so an unsigned read fails intermittently.
 */
function int32be(value: number): Buffer {
	const buf = Buffer.alloc(4);
	buf.writeInt32BE(value);
	return buf;
}

/** Derives the account hash used to authenticate against the device. */
export function userHash(email: string, password: string): Buffer {
	return sha256(Buffer.concat([sha1(Buffer.from(email)), sha1(Buffer.from(password))]));
}

export function newLocalSeed(): Buffer {
	return randomBytes(16);
}

export function serverHash(localSeed: Buffer, remoteSeed: Buffer, auth: Buffer): Buffer {
	return sha256(Buffer.concat([localSeed, remoteSeed, auth]));
}

export function handshake2Payload(localSeed: Buffer, remoteSeed: Buffer, auth: Buffer): Buffer {
	return sha256(Buffer.concat([remoteSeed, localSeed, auth]));
}

/**
 * Session cipher negotiated during the KLAP handshake. Each request is AES-128-CBC
 * encrypted under an IV that embeds a monotonically incrementing sequence number, and
 * prefixed with a SHA-256 signature over that sequence and the ciphertext.
 */
export class KlapCipher {
	readonly #key: Buffer;
	readonly #ivBase: Buffer;
	readonly #sigKey: Buffer;
	#seq: number;

	constructor(localSeed: Buffer, remoteSeed: Buffer, auth: Buffer) {
		const localHash = Buffer.concat([localSeed, remoteSeed, auth]);

		this.#key = sha256(Buffer.concat([Buffer.from("lsk"), localHash])).subarray(0, 16);

		const ivFull = sha256(Buffer.concat([Buffer.from("iv"), localHash]));
		this.#ivBase = ivFull.subarray(0, 12);
		this.#seq = ivFull.readInt32BE(28);

		this.#sigKey = sha256(Buffer.concat([Buffer.from("ldk"), localHash])).subarray(0, 28);
	}

	#iv(seq: number): Buffer {
		return Buffer.concat([this.#ivBase, int32be(seq)]);
	}

	encrypt(plaintext: Buffer): { body: Buffer; seq: number } {
		this.#seq += 1;
		const cipher = createCipheriv("aes-128-cbc", this.#key, this.#iv(this.#seq));
		const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
		const signature = sha256(Buffer.concat([this.#sigKey, int32be(this.#seq), ciphertext]));
		return { body: Buffer.concat([signature, ciphertext]), seq: this.#seq };
	}

	decrypt(payload: Buffer, seq: number): Buffer {
		const decipher = createDecipheriv("aes-128-cbc", this.#key, this.#iv(seq));
		return Buffer.concat([decipher.update(payload.subarray(32)), decipher.final()]);
	}
}
