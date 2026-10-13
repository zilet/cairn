// Child-process probe for test/offlineBareRun.test.js (not itself a test file the runner
// picks up: no `.test.js` suffix). Reports what a bare run resolved, via PROBE_OUT.
import { writeFileSync } from "node:fs";
import { test } from "node:test";

test("probe", async () => {
  if (process.env.PROBE_SEED === "1") await import("./_seed.js");
  const { loadAgents } = await import("../dist/agents.js");
  const { db } = await import("../dist/db.js");
  const agents = loadAgents();
  const main = db
    .prepare("PRAGMA database_list")
    .all()
    .find((row) => row.name === "main");
  writeFileSync(
    process.env.PROBE_OUT,
    JSON.stringify({
      agents: Object.fromEntries(Object.entries(agents).map(([name, def]) => [name, def.command])),
      dbFile: main.file,
    })
  );
});
