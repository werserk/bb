import { experimental_AI_MODEL_ID_MAX_LENGTH } from "@get-bb/plugin-sdk";
import { z } from "zod";
const DEFAULT_TIMEOUT_MS = 15000;
export const settingsSchema = z.object({
  enabled: z.boolean().default(false),
  backgroundPreparation: z.boolean().default(false),
  model: z.string().max(experimental_AI_MODEL_ID_MAX_LENGTH).default(""),
  reasoningEffort: z
    .enum(["default", "none", "low", "medium", "high", "xhigh", "max", "ultra"])
    .default("default"),
  serviceTier: z.enum(["default", "fast"]).default("default"),
  instructions: z.string().max(16000).default(""),
  contextCharLimit: z.number().int().min(1000).max(100000).default(24000),
  outputTokenLimit: z.number().int().min(0).max(2048).default(0),
  timeoutMs: z.number().int().min(100).max(30000).default(DEFAULT_TIMEOUT_MS),
  maxRequestsPerHour: z.number().int().min(1).max(1000).default(60),
  projectIds: z.string().default(""),
});
export type Settings = z.infer<typeof settingsSchema>;
export const settingDescriptors = {
  backgroundPreparation: {
    type: "boolean",
    label: "Background preparation",
    description:
      "Keep recently opened threads prepared for 10 minutes, including while you view another thread.",
    default: false,
  },
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
  reasoningEffort: {
    type: "select",
    label: "Reasoning effort",
    description:
      "Use only an effort advertised by the selected model. Unsupported choices fail before generation.",
    options: [
      "default",
      "none",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra",
    ],
    experimental_optionLabels: { default: "Provider default", none: "None" },
    experimental_schema: settingsSchema.shape.reasoningEffort.unwrap(),
    default: "default",
  },
  serviceTier: {
    type: "select",
    label: "Processing speed",
    description:
      "Fast requires provider support and may consume a higher quota or cost more.",
    options: ["default", "fast"],
    experimental_optionLabels: { default: "Provider default", fast: "Fast" },
    experimental_schema: settingsSchema.shape.serviceTier.unwrap(),
    default: "default",
  },
  instructions: {
    experimental_schema: settingsSchema.shape.instructions.unwrap(),
    type: "string",
    label: "Additional companion guidance",
    description:
      "Added to the goal-oriented role and your owner base instructions.",
    default: "",
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
} satisfies import("@get-bb/plugin-sdk").PluginSettingDescriptors;
