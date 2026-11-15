import { readFile } from "node:fs/promises";
import { Command } from "commander";
import {
  parseConversationQuestionPublication,
  QUESTION_CARD_LIMITS,
  conversationQuestionAnswerSchema,
  conversationQuestionVersionSchema,
  questionResolutionInputSchema,
} from "@bb/domain";
import { action } from "../../action.js";
import { createCliBbSdk } from "../../client.js";
import { requireThreadIdOrSelf } from "../helpers.js";

type TargetOptions = { self?: boolean; json?: boolean };
function targetOptions(command: Command): Command {
  return command
    .option("--self", "Target the current thread")
    .option("--json", "Print JSON");
}
async function readJsonFile(file: string): Promise<unknown> {
  return JSON.parse(await readFile(file, "utf8"));
}
export function registerQuestionCommands(
  parent: Command,
  getUrl: () => string,
): void {
  const questions = parent
    .command("questions")
    .description(
      "Publish and answer persistent ordinary questions without blocking chat",
    );
  questions
    .command("resolve")
    .description(
      "Resolve a qst revision with an operationId and reason; local identity is unverified; answers have scoped chat standing, withdrawals cancel the question; command approvals remain separate",
    )
    .requiredOption(
      "--file <path>",
      "JSON resolution request including threadId, questionId, revision, operationId, action, reason and answer data when answering",
    )
    .option("--json", "Print JSON")
    .action(
      action(async (opts: { file: string }) => {
        const input = questionResolutionInputSchema.parse(
          await readJsonFile(opts.file),
        );
        console.log(
          JSON.stringify(
            await createCliBbSdk(
              getUrl(),
            ).threads.questions.experimental_resolve(input),
            null,
            2,
          ),
        );
      }),
    );
  targetOptions(
    questions.command("list [id]").description("List persistent questions"),
  )
    .option("--open", "Read the paginated open-question view")
    .option("--cursor <cursor>", "Continue an open-question page")
    .option("--limit <number>", "Open-question page size (1–200, default 100)")
    .action(
      action(
        async (
          id: string | undefined,
          opts: TargetOptions & {
            open?: boolean;
            cursor?: string;
            limit?: string;
          },
        ) => {
          if (
            !opts.open &&
            (opts.cursor !== undefined || opts.limit !== undefined)
          )
            throw new Error("--cursor and --limit require --open");
          const limit =
            opts.limit === undefined ? undefined : Number(opts.limit);
          if (
            limit !== undefined &&
            (!Number.isInteger(limit) || limit < 1 || limit > 200)
          )
            throw new Error("--limit must be an integer from 1 to 200");
          const api = createCliBbSdk(getUrl()).threads.questions;
          const threadId = requireThreadIdOrSelf(id, opts);
          console.log(
            JSON.stringify(
              opts.open
                ? await api.open({
                    threadId,
                    ...(limit === undefined ? {} : { limit }),
                    ...(opts.cursor === undefined
                      ? {}
                      : { cursor: opts.cursor }),
                  })
                : await api.list({ threadId }),
              null,
              2,
            ),
          );
        },
      ),
    );
  targetOptions(
    questions
      .command("show <questionId> [id]")
      .description(
        "Show original context, materials, state and delivery receipt",
      ),
  ).action(
    action(
      async (
        questionId: string,
        id: string | undefined,
        opts: TargetOptions,
      ) => {
        console.log(
          JSON.stringify(
            await createCliBbSdk(getUrl()).threads.questions.get({
              threadId: requireThreadIdOrSelf(id, opts),
              questionId,
            }),
            null,
            2,
          ),
        );
      },
    ),
  );
  targetOptions(
    questions
      .command("publish [id]")
      .description(
        `Publish a concise question (total ${QUESTION_CARD_LIMITS.total} Unicode code points, body ${QUESTION_CARD_LIMITS.body}); put full reports in materials. Read publication JSON from a file`,
      ),
  )
    .requiredOption("--file <path>", "Publication JSON file")
    .requiredOption("--turn-id <id>", "Existing live source turn")
    .requiredOption("--provider-thread-id <id>", "Source provider conversation")
    .requiredOption("--call-id <id>", "Stable source call ID for retries")
    .action(
      action(
        async (
          id: string | undefined,
          opts: TargetOptions & {
            file: string;
            turnId: string;
            providerThreadId: string;
            callId: string;
          },
        ) => {
          const publication = parseConversationQuestionPublication(
            await readJsonFile(opts.file),
          );
          console.log(
            JSON.stringify(
              await createCliBbSdk(getUrl()).threads.questions.publish({
                threadId: requireThreadIdOrSelf(id, opts),
                source: {
                  turnId: opts.turnId,
                  providerThreadId: opts.providerThreadId,
                  callId: opts.callId,
                },
                publication,
              }),
              null,
              2,
            ),
          );
        },
      ),
    );
  targetOptions(
    questions
      .command("answer <questionId> [id]")
      .description(
        "Answer a specific revision using a JSON file with revision and answers",
      ),
  )
    .requiredOption(
      "--file <path>",
      "JSON file containing revision and answers",
    )
    .action(
      action(
        async (
          questionId: string,
          id: string | undefined,
          opts: TargetOptions & { file: string },
        ) => {
          const answer = conversationQuestionAnswerSchema.parse(
            await readJsonFile(opts.file),
          );
          console.log(
            JSON.stringify(
              await createCliBbSdk(getUrl()).threads.questions.answer({
                threadId: requireThreadIdOrSelf(id, opts),
                questionId,
                ...answer,
              }),
              null,
              2,
            ),
          );
        },
      ),
    );
  for (const operation of ["dismiss", "withdraw"] as const) {
    targetOptions(
      questions
        .command(`${operation} <questionId> [id]`)
        .description(
          operation === "dismiss"
            ? "Close an unanswered question without stopping chat"
            : "Withdraw a question and fence any undelivered answer",
        ),
    )
      .requiredOption("--revision <number>", "Exact question revision")
      .action(
        action(
          async (
            questionId: string,
            id: string | undefined,
            opts: TargetOptions & { revision: string },
          ) => {
            const { revision } = conversationQuestionVersionSchema.parse({
              revision: Number(opts.revision),
            });
            console.log(
              JSON.stringify(
                await createCliBbSdk(getUrl()).threads.questions[operation]({
                  threadId: requireThreadIdOrSelf(id, opts),
                  questionId,
                  revision,
                }),
                null,
                2,
              ),
            );
          },
        ),
      );
  }
}
