/**
 * The KLAP account hash, computed in the property inspector so the password never has to
 * leave it: sha256(sha1(email) ‖ sha1(password)), the same value the strip checks and the
 * same as `userHash()` in src/tapo/klap.ts.
 *
 * Pure JavaScript on purpose. `crypto.subtle` only exists in a secure context, and whether
 * the inspector's page counts as one depends on how Stream Deck happens to serve it.
 * test/hash.test.ts checks this against Node's own crypto.
 */
(function () {
	const rotl = (x, n) => (x << n) | (x >>> (32 - n));
	const rotr = (x, n) => (x >>> n) | (x << (32 - n));

	/** Appends the Merkle–Damgård padding and returns the message as big-endian 32-bit words. */
	function toWords(bytes) {
		const bitLength = bytes.length * 8;
		const total = (((bytes.length + 8) >> 6) + 1) * 16;
		const words = new Array(total).fill(0);
		for (let i = 0; i < bytes.length; i++) {
			words[i >> 2] |= bytes[i] << (24 - (i % 4) * 8);
		}
		words[bytes.length >> 2] |= 0x80 << (24 - (bytes.length % 4) * 8);
		words[total - 1] = bitLength >>> 0;
		words[total - 2] = Math.floor(bitLength / 0x100000000);
		return words;
	}

	function toBytes(state) {
		const out = new Uint8Array(state.length * 4);
		state.forEach((word, i) => {
			out[i * 4] = word >>> 24;
			out[i * 4 + 1] = (word >>> 16) & 0xff;
			out[i * 4 + 2] = (word >>> 8) & 0xff;
			out[i * 4 + 3] = word & 0xff;
		});
		return out;
	}

	function sha1(bytes) {
		const words = toWords(bytes);
		const h = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0];
		const w = new Array(80);

		for (let block = 0; block < words.length; block += 16) {
			for (let t = 0; t < 80; t++) {
				w[t] = t < 16 ? words[block + t] : rotl(w[t - 3] ^ w[t - 8] ^ w[t - 14] ^ w[t - 16], 1);
			}

			let [a, b, c, d, e] = h;
			for (let t = 0; t < 80; t++) {
				let f, k;
				if (t < 20) [f, k] = [(b & c) | (~b & d), 0x5a827999];
				else if (t < 40) [f, k] = [b ^ c ^ d, 0x6ed9eba1];
				else if (t < 60) [f, k] = [(b & c) | (b & d) | (c & d), 0x8f1bbcdc];
				else [f, k] = [b ^ c ^ d, 0xca62c1d6];

				const next = (rotl(a, 5) + f + e + k + w[t]) | 0;
				[e, d, c, b, a] = [d, c, rotl(b, 30), a, next];
			}

			h[0] = (h[0] + a) | 0;
			h[1] = (h[1] + b) | 0;
			h[2] = (h[2] + c) | 0;
			h[3] = (h[3] + d) | 0;
			h[4] = (h[4] + e) | 0;
		}

		return toBytes(h);
	}

	const K256 = [
		0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
		0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
		0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
		0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
		0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
		0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
		0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
		0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
	];

	function sha256(bytes) {
		const words = toWords(bytes);
		const h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
		const w = new Array(64);

		for (let block = 0; block < words.length; block += 16) {
			for (let t = 0; t < 64; t++) {
				if (t < 16) {
					w[t] = words[block + t];
				} else {
					const s0 = rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3);
					const s1 = rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10);
					w[t] = (w[t - 16] + s0 + w[t - 7] + s1) | 0;
				}
			}

			let [a, b, c, d, e, f, g, hh] = h;
			for (let t = 0; t < 64; t++) {
				const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
				const ch = (e & f) ^ (~e & g);
				const t1 = (hh + S1 + ch + K256[t] + w[t]) | 0;
				const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
				const maj = (a & b) ^ (a & c) ^ (b & c);
				const t2 = (S0 + maj) | 0;
				[hh, g, f, e, d, c, b, a] = [g, f, e, (d + t1) | 0, c, b, a, (t1 + t2) | 0];
			}

			[a, b, c, d, e, f, g, hh].forEach((v, i) => (h[i] = (h[i] + v) | 0));
		}

		return toBytes(h);
	}

	const utf8 = (text) => new TextEncoder().encode(text);
	const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

	function concat(a, b) {
		const out = new Uint8Array(a.length + b.length);
		out.set(a);
		out.set(b, a.length);
		return out;
	}

	/** Returns the account hash as lowercase hex, the form stored in the global settings. */
	window.tapoAuthHash = (email, password) => hex(sha256(concat(sha1(utf8(email)), sha1(utf8(password)))));
})();
