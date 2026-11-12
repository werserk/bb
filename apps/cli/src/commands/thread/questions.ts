import { readFile } from "node:fs/promises";
import { Command } from "commander";
import {
  parseConversationQuestionPublication,
  QUESTION_CARD_LIMITS,
  conversationQuestionAnswerSchema,
  conversationQuestionVersionSchema,
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
  targetOptions(
    questions.command("list [id]").description("List persistent questions"),
  ).action(
    action(async (id: string | undefined, opts: TargetOptions) => {
      console.log(
        JSON.stringify(
          await createCliBbSdk(getUrl()).threads.questions.list({
            threadId: requireThreadIdOrSelf(id, opts),
          }),
          null,
          2,
        ),
      );
    }),
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
