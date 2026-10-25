import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import vm from "node:vm";
import { userHash } from "../src/tapo/klap.js";

/** Loads the property inspector's hash script the way the inspector does: as a classic script. */
function loadInspectorHash(): (email: string, password: string) => string {
	// Compiled tests run from build-test/test, two levels below the project root.
	const file = path.resolve(import.meta.dirname, "../../com.migue802.tapo-lights.sdPlugin/ui/tapo-hash.js");
	const window: { tapoAuthHash?: (email: string, password: string) => string } = {};
	vm.runInNewContext(readFileSync(file, "utf8"), { window, TextEncoder });
	assert.ok(window.tapoAuthHash, "tapo-hash.js did not define window.tapoAuthHash");
	return window.tapoAuthHash;
}

describe("property inspector account hash", () => {
	const inspectorHash = loadInspectorHash();

	it("matches the plugin's userHash, so a hash saved by the inspector authenticates", () => {
		const cases: Array<[string, string]> = [
			["user@example.com", "hunter2"],
			["", ""],
			["ñandú@correo.es", "contraseña con espacios y €"],
			// Lengths around the 55/56/64-byte padding boundaries of a single block.
			["a".repeat(55), "b".repeat(56)],
			["c".repeat(63), "d".repeat(64)],
			["e".repeat(200), "🔒".repeat(40)],
		];

		for (const [email, password] of cases) {
			assert.equal(
				inspectorHash(email, password),
				userHash(email, password).toString("hex"),
				`email ${JSON.stringify(email.slice(0, 20))}…`,
			);
		}
	});
});
