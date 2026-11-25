import {
  canonicalJsonBytes,
  flattenPromptInputGroups,
  promptInputSchema,
  type JsonValue,
  type PromptInput,
  type PlacementOperation,
} from "@bb/domain";
import { PlacementDispatchConflictError } from "./placement-dispatch-errors.js";

const blocks = promptInputSchema.array();
const groupedBlocks = blocks.min(1).array().min(1);

function normalizedBlocks(input: unknown) {
  const parsed = blocks.safeParse(input);
  if (!parsed.success)
    throw new PlacementDispatchConflictError("invalid prepared input blocks");
  return parsed.data;
}

// Read the normalized request accepted by preparation. A string is the older
// single text representation. Native fork preparation prepends the hidden seed.
export function placementPreparedGroups(
  preparedRequest: string | null,
  kind: PlacementOperation["kind"],
): PromptInput[][] {
  const request: JsonValue =
    preparedRequest === null ? null : JSON.parse(preparedRequest);
  if (!request || typeof request !== "object" || Array.isArray(request))
    throw new PlacementDispatchConflictError(
      "ordinary input has no prepared request",
    );
  const parsedGroups = groupedBlocks.optional().safeParse(request.inputGroups);
  if (!parsedGroups.success)
    throw new PlacementDispatchConflictError("invalid prepared input groups");
  const grouped = parsedGroups.data;
  const visible =
    request.input === undefined
      ? undefined
      : normalizedBlocks(
          typeof request.input === "string"
            ? [{ type: "text", text: request.input }]
            : request.input,
        );
  const seed =
    kind === "fork" && request.agentContextSeed !== undefined
      ? normalizedBlocks(request.agentContextSeed)
      : [];
  if (seed.some((block) => block.visibility !== "agent-only"))
    throw new PlacementDispatchConflictError("invalid prepared fork seed");
  if (!visible && !grouped && !seed.length)
    throw new PlacementDispatchConflictError("prepared input missing");
  if (
    grouped &&
    visible &&
    canonicalJsonBytes(flattenPromptInputGroups(grouped)) !==
      canonicalJsonBytes(visible)
  )
    throw new PlacementDispatchConflictError("prepared input groups disagree");
  const groups = grouped ?? [visible ?? []];
  return seed.length ? [[...seed, ...groups[0]!], ...groups.slice(1)] : groups;
}
