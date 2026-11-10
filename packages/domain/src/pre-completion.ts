export const BB_PRE_COMPLETION_TOOL_NAME = "bb_internal_pre_completion";

export const BB_PRE_COMPLETION_LIMITS = {
  deadlineMs: 2000,
  bridgeDeadlineMs: 2500,
  finalTextLimit: 8192,
  instructionLimit: 1000,
} as const;
