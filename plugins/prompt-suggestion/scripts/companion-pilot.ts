import { readFile, writeFile } from "node:fs/promises";
import { fixturesSchema, parsePilotArgs, runPilot } from "../src/pilot.js";

try {
  const options = parsePilotArgs(process.argv.slice(2));
  const fixtures = fixturesSchema.parse(
    JSON.parse(
      await readFile(
        new URL("../fixtures/companion-quality.json", import.meta.url),
        "utf8",
      ),
    ),
  );
  const ownerContent = await readFile(options.instructionsFile, "utf8");
  const report = await runPilot(options, fixtures, ownerContent);
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (options.output)
    await writeFile(options.output, serialized, { mode: 0o600 });
  else process.stdout.write(serialized);
  if (
    report.calls.some(
      (call) =>
        call.validation !== "valid" ||
        ("screeningPassed" in call && !call.screeningPassed),
    )
  )
    process.exitCode = 1;
} catch {
  process.stderr.write(
    "Pilot failed; check options, input files, and gateway availability.\n",
  );
  process.exitCode = 1;
}
