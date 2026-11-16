import { experimental_AI_MODEL_ID_MAX_LENGTH } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { DEFAULT_INSTRUCTIONS } from "./instructions.js";
const DEFAULT_TIMEOUT_MS = 15000;
export const settingsSchema = z.object({
  enabled: z.boolean().default(false),
  model: z.string().max(experimental_AI_MODEL_ID_MAX_LENGTH).default(""),
  instructions: z.string().max(16000).default(DEFAULT_INSTRUCTIONS),
  contextCharLimit: z.number().int().min(1000).max(100000).default(24000),
  outputTokenLimit: z.number().int().min(0).max(2048).default(0),
  timeoutMs: z.number().int().min(100).max(30000).default(DEFAULT_TIMEOUT_MS),
  maxRequestsPerHour: z.number().int().min(1).max(1000).default(60),
  projectIds: z.string().default(""),
});
export type Settings = z.infer<typeof settingsSchema>;
export const settingDescriptors = {
  enabled: {
    type: "boolean",
    label: "Enable Prompt Suggestion",
    default: false,
  },
  model: {
    experimental_schema: settingsSchema.shape.model.unwrap(),
    type: "string",
    label: "Generator model",
    default: "",
  },
  instructions: {
    experimental_schema: settingsSchema.shape.instructions.unwrap(),
    type: "string",
    label: "Generator instructions",
    default: DEFAULT_INSTRUCTIONS,
  },
  contextCharLimit: {
    experimental_schema: settingsSchema.shape.contextCharLimit.unwrap(),
    type: "number",
    label: "Context character limit",
    default: 24000,
  },
  outputTokenLimit: {
    experimental_schema: settingsSchema.shape.outputTokenLimit.unwrap(),
    type: "number",
    label: "Output token limit",
    description:
      "0 uses the model default. A positive limit requires model support; unsupported limits fail without a request.",
    default: 0,
  },
  timeoutMs: {
    experimental_schema: settingsSchema.shape.timeoutMs.unwrap(),
    type: "number",
    label: "Timeout in milliseconds",
    default: DEFAULT_TIMEOUT_MS,
  },
  maxRequestsPerHour: {
    experimental_schema: settingsSchema.shape.maxRequestsPerHour.unwrap(),
    type: "number",
    label: "Requests per hour (session)",
    default: 60,
  },
  projectIds: {
    type: "string",
    label: "Allowed project IDs",
    description: "Comma-separated; empty allows all projects.",
    default: "",
  },
} as const;
