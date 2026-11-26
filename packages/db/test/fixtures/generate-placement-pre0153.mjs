import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
const baseline = resolve(process.argv[2]);
const expected = "f4ce7061642bb92aabadf32c3c38cb69a260ac97";
if (
  execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: baseline,
    encoding: "utf8",
  }).trim() !== expected
)
  throw new Error("Wrong baseline");
const { createConnection } = await import(
  pathToFileURL(resolve(baseline, "packages/db/src/connection.ts"))
);
const { migrate } = await import(
  pathToFileURL(resolve(baseline, "packages/db/src/migrate.ts"))
);
const db = createConnection(":memory:");
try {
  migrate(db);
  db.$client.exec(
    `INSERT INTO hosts(id,name,type,created_at,updated_at) VALUES ('fixture-host','Synthetic','persistent',1,1)`,
  );
  db.$client.exec(
    `INSERT INTO projects(id,name,created_at,updated_at) VALUES ('fixture-project','Synthetic',1,1)`,
  );
  db.$client.exec(
    `INSERT INTO environments(id,project_id,host_id,path,status,created_at,updated_at) VALUES ('fixture-env','fixture-project','fixture-host','/fixture','ready',1,1)`,
  );
  for (const provider of ["codex", "claude-code"]) {
    db.$client
      .prepare(
        `INSERT INTO threads(id,project_id,environment_id,provider_id,status,latest_attention_at,created_at,updated_at) VALUES (?, 'fixture-project','fixture-env',?,'idle',1,1,1)`,
      )
      .run(`fixture-${provider}`, provider);
    db.$client
      .prepare(
        `INSERT INTO queued_thread_messages(id,thread_id,content,model,reasoning_level,permission_mode,service_tier,state,sort_key,created_at,updated_at,service_turn,question_id,question_revision) VALUES (?,?,?,'fixture','high','auto','default','queued','V',1,1,?,NULL,NULL)`,
      )
      .run(
        `queue-${provider}`,
        `fixture-${provider}`,
        `[{"type":"text","text":"Synthetic ${provider} bytes  \\n"}]`,
        JSON.stringify({ kind: "fixture", provider }),
      );
  }
  if (db.$client.pragma("foreign_key_check").length)
    throw new Error("Baseline foreign key failure");
  const bytes = gzipSync(db.$client.serialize(), { level: 9 });
  writeFileSync(
    new URL("./placement-pre0153.sqlite.gz", import.meta.url),
    bytes,
  );
  writeFileSync(
    new URL("./placement-pre0153.json", import.meta.url),
    JSON.stringify(
      {
        baseSha: expected,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        synthetic: true,
        command:
          "node --import tsx packages/db/test/fixtures/generate-placement-pre0153.mjs <checkout-at-base-sha>",
        tables: [
          "hosts",
          "projects",
          "environments",
          "threads",
          "queued_thread_messages",
        ],
        generation:
          "Baseline createConnection(':memory:') + migrate(), including actual fork DDL; synthetic SQL seed only.",
      },
      null,
      2,
    ) + "\n",
  );
} finally {
  db.$client.close();
}
