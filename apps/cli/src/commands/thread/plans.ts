import { Command } from "commander";
import { action } from "../../action.js";
import { createCliBbSdk } from "../../client.js";
import { requireThreadIdOrSelf } from "../helpers.js";
export function registerPlanCommand(
  parent: Command,
  getUrl: () => string,
): void {
  parent
    .command("plan [id]")
    .description("Inspect canonical plan, history and native input IDs")
    .option("--self", "Use the current thread")
    .option("--json", "Print JSON")
    .action(
      action(async (id: string | undefined, opts: { self?: boolean }) => {
        const threadId = requireThreadIdOrSelf(id, opts);
        const result = await createCliBbSdk(getUrl()).threads.plans({
          threadIds: [threadId],
        });
        if (result.errors[threadId]) throw new Error(result.errors[threadId]);
        console.log(JSON.stringify(result.plans[threadId], null, 2));
      }),
    );
}
