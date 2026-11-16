import { z } from "zod";
import { completionUrl } from "./generate.js";
import { DEFAULT_INSTRUCTIONS } from "./instructions.js";
export const settingsSchema = z.object({
  enabled: z.boolean().default(false),
  baseUrl: z
    .string()
    .refine((value) => {
      if (!value) return true;
      try {
        completionUrl(value);
        return true;
      } catch {
        return false;
      }
    }, "Invalid generator URL")
    .default(""),
  model: z.string().default(""),
  apiKey: z.string().default(""),
  instructions: z.string().max(16000).default(DEFAULT_INSTRUCTIONS),
  contextCharLimit: z.number().int().min(1000).max(100000).default(24000),
  outputTokenLimit: z.number().int().min(32).max(2048).default(256),
  timeoutMs: z.number().int().min(100).max(30000).default(8000),
  maxRequestsPerHour: z.number().int().min(1).max(1000).default(60),
  projectIds: z.string().default(""),
});
export type Settings = z.infer<typeof settingsSchema>;
export const settingDescriptors = {
  enabled: { type: "boolean", label: "Enable Autosay", default: false },
  baseUrl: {
    experimental_schema: settingsSchema.shape.baseUrl.unwrap(),
    type: "string",
    label: "Generator API base URL",
    description:
      "Receives conversation context. HTTPS or local loopback HTTP; include /v1 when required.",
    default: "",
  },
  model: { type: "string", label: "Generator model", default: "" },
  apiKey: { type: "string", label: "Generator API key", secret: true },
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
    default: 256,
  },
  timeoutMs: {
    experimental_schema: settingsSchema.shape.timeoutMs.unwrap(),
    type: "number",
    label: "Timeout in milliseconds",
    default: 8000,
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
