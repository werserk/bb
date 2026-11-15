// werserk fork: drizzle-kit config for fork migrations. Generate a fork schema
// change with `pnpm --filter @bb/db exec drizzle-kit generate --config
// drizzle.fork.config.ts`. See "Database migrations" in FORK.md.
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/schema.ts",
  out: "./drizzle/fork",
  dialect: "sqlite",
});
