/**
 * Reads the leak monitor's CSV and reports the memory-growth slope for each stretch
 * during which the set of running plugins stayed constant.
 *
 * Whenever a plugin is disabled its node process dies, the "plugins" column changes,
 * and a new segment begins. Comparing the MB/min slope across segments shows whether
 * removing a given plugin slowed the leak — i.e. whether that plugin was aggravating it.
 *
 * Usage: node tools/analyze-leak.mjs [path-to-csv]
 */
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const csvPath = process.argv[2] ?? join(tmpdir(), "sd_leak_monitor.csv");

const lines = readFileSync(csvPath, "utf8").trim().split(/\r?\n/);
const header = lines.shift();
if (!header) {
	console.error("Empty CSV.");
	process.exit(1);
}

const rows = lines
	.map((line) => {
		const [epoch, iso, pid, ws, priv, handles, threads, familyWs, count, plugins] = line.split(",");
		return {
			epoch: Number(epoch),
			iso,
			ws: ws === "" ? null : Number(ws),
			priv: priv === "" ? null : Number(priv),
			familyWs: familyWs === "" ? null : Number(familyWs),
			plugins: plugins ?? "",
		};
	})
	.filter((r) => r.priv !== null);

if (rows.length < 2) {
	console.error(`Only ${rows.length} usable sample(s) so far — let it run a little longer.`);
	process.exit(0);
}

// Split into segments where the running-plugin set is constant.
const segments = [];
let current = [rows[0]];
for (let i = 1; i < rows.length; i++) {
	if (rows[i].plugins === current[0].plugins) {
		current.push(rows[i]);
	} else {
		segments.push(current);
		current = [rows[i]];
	}
}
segments.push(current);

const fmtClock = (iso) => iso.slice(11, 19);
const slope = (a, b, key) => {
	const dt = (b.epoch - a.epoch) / 60; // minutes
	return dt > 0 ? (b[key] - a[key]) / dt : 0;
};

console.log(`\nLeak monitor — ${rows.length} samples, ${segments.length} segment(s)\n`);

for (const seg of segments) {
	const a = seg[0];
	const b = seg[seg.length - 1];
	const mins = ((b.epoch - a.epoch) / 60).toFixed(1);
	const privRate = slope(a, b, "priv").toFixed(1);
	const wsRate = slope(a, b, "ws").toFixed(1);

	const set = a.plugins || "(none running)";
	console.log(`■ ${fmtClock(a.iso)}–${fmtClock(b.iso)}  (${mins} min, ${seg.length} samples)`);
	console.log(`   plugins running : ${set}`);
	console.log(`   private commit  : ${a.priv} → ${b.priv} MB`);
	if (seg.length >= 3 && Number(mins) >= 1) {
		console.log(`   growth          : private ${privRate} MB/min | ws ${wsRate} MB/min`);
	} else {
		console.log(`   growth          : (need ~1+ min in this segment for a reliable slope)`);
	}
	console.log();
}

// Name what changed between consecutive segments — the likely lever on the leak.
if (segments.length >= 2) {
	console.log("Changes between segments (what was added/removed):");
	for (let i = 1; i < segments.length; i++) {
		const before = new Set(segments[i - 1][0].plugins.split(";").filter(Boolean));
		const after = new Set(segments[i][0].plugins.split(";").filter(Boolean));
		const removed = [...before].filter((p) => !after.has(p));
		const added = [...after].filter((p) => !before.has(p));
		const at = fmtClock(segments[i][0].iso);
		const parts = [];
		if (removed.length) parts.push(`− ${removed.join(", ")}`);
		if (added.length) parts.push(`+ ${added.join(", ")}`);
		console.log(`   at ${at}: ${parts.join("  ") || "(no plugin change — restart?)"}`);
	}
	console.log();
}
