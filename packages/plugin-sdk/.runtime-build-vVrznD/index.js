// src/ai-generation.ts
var experimental_AI_MODEL_ID_MAX_LENGTH = 12288;
var experimental_AiGenerationError = class extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "AiGenerationError";
  }
  code;
};

// src/backend-contract.ts
var PLUGIN_CLI_OUTPUT_MAX_BYTES = 32 * 1024 * 1024;

// src/cli-spec.ts
var PluginCliError = class extends Error {
  code;
  hint;
  exitCode;
  constructor(message, options) {
    super(message);
    this.name = "CliError";
    this.code = options?.code ?? "command_failed";
    this.hint = options?.hint;
    this.exitCode = options?.exitCode ?? 1;
  }
};
function cliCommand(command) {
  return command;
}
var DURATION_UNIT_MS = {
  ms: 1,
  s: 1e3,
  m: 6e4,
  h: 36e5,
  d: 864e5
};
var DURATION_UNIT_LABEL = {
  ms: "milliseconds",
  s: "seconds",
  m: "minutes",
  h: "hours",
  d: "days"
};
var DURATION_PATTERN = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/;
var UsageError = class extends Error {
  failure;
  constructor(failure) {
    super(failure.message);
    this.name = "CliUsageError";
    this.failure = failure;
  }
};
function editDistance(left, right) {
  const columns = right.length + 1;
  let previous = Array.from({ length: columns }, (_unused, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    const current = [row];
    for (let column = 1; column < columns; column += 1) {
      const substitution = (previous[column - 1] ?? 0) + (left[row - 1] === right[column - 1] ? 0 : 1);
      const deletion = (previous[column] ?? 0) + 1;
      const insertion = (current[column - 1] ?? 0) + 1;
      current.push(Math.min(substitution, deletion, insertion));
    }
    previous = current;
  }
  return previous[columns - 1] ?? Math.max(left.length, right.length);
}
function nearest(input, candidates) {
  let best = null;
  for (const candidate of candidates) {
    const score = editDistance(input, candidate);
    const related = score <= 2 || input.length >= 3 && candidate.startsWith(input) || candidate.length >= 3 && input.startsWith(candidate);
    if (!related) continue;
    if (best === null || score < best.score) best = { name: candidate, score };
  }
  return best?.name ?? null;
}
function isRequired(option) {
  return option.type !== "boolean" && option.required === true;
}
function isRepeatable(option) {
  if (option.type === "string" || option.type === "enum") {
    return option.repeatable === true;
  }
  return false;
}
function defaultOf(option) {
  return option.type === "boolean" ? void 0 : option.default;
}
function optionPlaceholder(option) {
  if (option.placeholder !== void 0) return option.placeholder;
  switch (option.type) {
    case "boolean":
      return "";
    case "enum":
      return option.values.join("|");
    case "integer":
      return `${option.min}-${option.max}`;
    case "duration":
      return "duration";
    default:
      return "value";
  }
}
function optionSignature(name, option) {
  const placeholder = optionPlaceholder(option);
  return placeholder ? `--${name} <${placeholder}>` : `--${name}`;
}
function visibleOptions(command) {
  return Object.entries(command.options ?? {}).filter(
    ([, option]) => option.hidden !== true
  );
}
function visibleCommands(spec) {
  return Object.entries(spec.commands).filter(
    ([, command]) => command.hidden !== true
  );
}
function usageLine(cliName, path, command) {
  const parts = [path ? `bb ${cliName} ${path}` : `bb ${cliName}`];
  for (const positional of command.positionals ?? []) {
    const token = positional.variadic ? `<${positional.name}...>` : `<${positional.name}>`;
    parts.push(positional.required ? token : `[${token}]`);
  }
  for (const [name, option] of visibleOptions(command)) {
    const signature = optionSignature(name, option);
    if (isRequired(option)) parts.push(signature);
    else if (isRepeatable(option)) parts.push(`[${signature}]...`);
    else parts.push(`[${signature}]`);
  }
  if (command.passthrough === true) parts.push("-- <command...>");
  return parts.join(" ");
}
function padColumns(rows) {
  const width = rows.reduce(
    (longest, [left]) => left.length <= 34 ? Math.max(longest, left.length) : longest,
    0
  );
  return rows.map(
    ([left, right]) => `  ${left.padEnd(width)}  ${right}`.trimEnd()
  );
}
function optionHelpRow(name, option) {
  const markers = [];
  if (isRequired(option)) markers.push("required");
  if (isRepeatable(option)) markers.push("repeatable");
  const fallback = defaultOf(option);
  if (fallback !== void 0) markers.push(`default: ${fallback}`);
  if (option.stdin === true) markers.push(`or --${name}-stdin from the bb CLI`);
  const suffix = markers.length > 0 ? ` (${markers.join(", ")})` : "";
  return [optionSignature(name, option), `${option.description}${suffix}`];
}
function constraintRows(command) {
  return (command.constraints ?? []).map((constraint) => {
    if (constraint.kind === "requires") {
      return [
        `--${constraint.option}`,
        `requires ${constraint.needs.map((need) => `--${need}`).join(", ")}`
      ];
    }
    const label = constraint.kind === "exactly-one" ? "Exactly one of:" : constraint.kind === "at-most-one" ? "At most one of:" : "At least one of:";
    return [label, constraint.options.map((name) => `--${name}`).join(", ")];
  });
}
function optionsSection(command) {
  const options = visibleOptions(command);
  if (options.length === 0) return [];
  const rows = options.map(
    ([name, option]) => optionHelpRow(name, option)
  );
  rows.push(["--help, -h", "Show this help and exit"]);
  return ["", "Options:", ...padColumns(rows)];
}
function positionalsSection(command) {
  const positionals = command.positionals ?? [];
  if (positionals.length === 0) return [];
  return [
    "",
    "Arguments:",
    ...padColumns(
      positionals.map((positional) => [
        positional.variadic ? `<${positional.name}...>` : `<${positional.name}>`,
        `${positional.description}${positional.required === true ? " (required)" : ""}`
      ])
    )
  ];
}
function rulesSection(command) {
  const rows = constraintRows(command);
  if (rows.length === 0) return [];
  return ["", "Rules:", ...padColumns(rows)];
}
function commandRows(spec) {
  return visibleCommands(spec).map(([path, command]) => [
    `bb ${spec.name} ${path}`,
    command.summary
  ]);
}
function renderTopLevelHelp(spec) {
  const lines = [`bb ${spec.name} \u2014 ${spec.summary}`];
  if (spec.description !== void 0) lines.push("", spec.description);
  lines.push("", "Usage:");
  if (spec.root) lines.push(`  ${usageLine(spec.name, "", spec.root)}`);
  lines.push(`  bb ${spec.name} <command> [options]`);
  const rows = commandRows(spec);
  if (rows.length > 0) lines.push("", "Commands:", ...padColumns(rows));
  if (spec.root) {
    lines.push(...positionalsSection(spec.root), ...optionsSection(spec.root));
  }
  lines.push(
    "",
    `Run \`bb ${spec.name} <command> --help\` for a command's arguments and options.`
  );
  return `${lines.join("\n")}
`;
}
function renderHelp(spec, resolved) {
  if (resolved === null) return renderTopLevelHelp(spec);
  const { path, command } = resolved;
  const lines = [
    `bb ${spec.name} ${path} \u2014 ${command.summary}`,
    "",
    "Usage:",
    `  ${usageLine(spec.name, path, command)}`
  ];
  if (command.description !== void 0) lines.push("", command.description);
  lines.push(
    ...positionalsSection(command),
    ...optionsSection(command),
    ...rulesSection(command)
  );
  return `${lines.join("\n")}
`;
}
function commandGroupRows(spec, words) {
  return visibleCommands(spec).filter(([path]) => {
    const pathWords = path.split(" ");
    return pathWords.length > words.length && words.every((word, index) => pathWords[index] === word);
  }).map(([path, command]) => [`bb ${spec.name} ${path}`, command.summary]);
}
function renderGroupHelp(spec, words, rows) {
  const group = `bb ${spec.name} ${words.join(" ")}`;
  return `${[
    `${group} \u2014 commands`,
    "",
    "Usage:",
    `  ${group} <command> [options]`,
    "",
    "Commands:",
    ...padColumns(rows),
    "",
    `Run \`${group} <command> --help\` for a command's arguments and options.`
  ].join("\n")}
`;
}
function commandListBlock(spec) {
  return ["Commands:", ...padColumns(commandRows(spec))].join("\n");
}
function leadingWords(argv) {
  const words = [];
  for (const token of argv) {
    if (token.startsWith("-")) break;
    words.push(token);
  }
  return words;
}
function resolveCommand(spec, words) {
  const candidates = [];
  for (const [path, command] of Object.entries(spec.commands)) {
    candidates.push({ path, words: path.split(" ") });
    for (const alias of command.aliases ?? []) {
      candidates.push({ path, words: alias.split(" ") });
    }
  }
  candidates.sort((left, right) => right.words.length - left.words.length);
  for (const candidate of candidates) {
    if (candidate.words.length > words.length) continue;
    if (!candidate.words.every((word, index) => words[index] === word)) {
      continue;
    }
    const command = spec.commands[candidate.path];
    if (command) {
      return {
        path: candidate.path,
        command,
        words: candidate.words.length
      };
    }
  }
  return null;
}
function unknownCommandError(spec, words) {
  const suggestions = /* @__PURE__ */ new Map();
  for (const [path, command] of Object.entries(spec.commands)) {
    for (const alias of command.aliases ?? []) suggestions.set(alias, path);
    for (const near of command.suggestFor ?? []) suggestions.set(near, path);
  }
  const visiblePaths = visibleCommands(spec).map(([path]) => path.split(" "));
  let shared = 0;
  while (shared < words.length && visiblePaths.some(
    (path) => path.length > shared + 1 && path.slice(0, shared + 1).every((word, index) => words[index] === word)
  )) {
    shared += 1;
  }
  const prefix = words.slice(0, shared);
  const siblings = [
    ...new Set(
      visiblePaths.filter(
        (path) => path.length > shared && prefix.every((word, index) => path[index] === word)
      ).map((path) => path[shared] ?? "")
    )
  ];
  const attemptedWord = words[shared];
  if (attemptedWord === void 0) {
    return new UsageError({
      code: "missing_command",
      message: `missing command after '${prefix.join(" ")}'`,
      hint: `Expected one of: ${siblings.join(", ")}`,
      detail: commandListBlock(spec),
      exitCode: spec.usageErrorExitCode ?? 1
    });
  }
  const attempted = [...prefix, attemptedWord].join(" ");
  const nearestSibling = nearest(attemptedWord, siblings);
  const suggestion = suggestions.get(attempted) ?? suggestions.get(attemptedWord) ?? (nearestSibling === null ? null : [...prefix, nearestSibling].join(" "));
  return new UsageError({
    code: "unknown_command",
    message: `unknown command '${attempted}'`,
    ...suggestion === null || suggestion === void 0 ? {} : { hint: `Did you mean ${suggestion}?` },
    detail: commandListBlock(spec),
    exitCode: spec.usageErrorExitCode ?? 1
  });
}
function usageFailure(spec, path, command, failure) {
  return new UsageError({
    ...failure,
    usage: `Usage:
  ${usageLine(spec.name, path, command)}`,
    exitCode: spec.usageErrorExitCode ?? 1
  });
}
function namesDeclaredOption(token, byName, byShort) {
  if (token === "--" || token === "--help" || token === "-h") return true;
  if (token.startsWith("--")) {
    const spelled = token.slice(2).split("=")[0] ?? "";
    return byName.has(spelled) || spelled.endsWith("-stdin") && byName.has(spelled.slice(0, -"-stdin".length));
  }
  if (token.startsWith("-") && token.length > 1) {
    return byShort.has(token.slice(1).split("=")[0] ?? "");
  }
  return false;
}
function tokenize(spec, path, command, argv) {
  const options = command.options ?? {};
  const byName = /* @__PURE__ */ new Map();
  const byShort = /* @__PURE__ */ new Map();
  for (const [name, option] of Object.entries(options)) {
    byName.set(name, name);
    for (const alias of option.aliases ?? []) byName.set(alias, name);
    if (option.short !== void 0) {
      byShort.set(normalizeShort(option.short), name);
    }
  }
  const parsed = {
    values: /* @__PURE__ */ new Map(),
    flags: /* @__PURE__ */ new Set(),
    positionals: [],
    passthrough: []
  };
  const fail = (failure) => usageFailure(spec, path, command, failure);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? "";
    if (token === "--") {
      const rest = argv.slice(index + 1);
      if (command.passthrough === true) parsed.passthrough.push(...rest);
      else parsed.positionals.push(...rest);
      break;
    }
    if (!token.startsWith("-") || token === "-" || NEGATIVE_NUMBER_PATTERN.test(token) && !byShort.has(token.slice(1))) {
      parsed.positionals.push(token);
      continue;
    }
    const long = token.startsWith("--");
    const body = long ? token.slice(2) : token.slice(1);
    const separator = body.indexOf("=");
    const spelled = separator === -1 ? body : body.slice(0, separator);
    const inline = separator === -1 ? void 0 : body.slice(separator + 1);
    const name = long ? byName.get(spelled) : byShort.get(spelled);
    const option = name === void 0 ? void 0 : options[name];
    if (name === void 0 || option === void 0) {
      const stdinTarget = spelled.endsWith("-stdin") ? byName.get(spelled.slice(0, -"-stdin".length)) : void 0;
      if (stdinTarget !== void 0 && options[stdinTarget]?.stdin === true) {
        throw fail({
          code: "invalid_value",
          message: `--${spelled} is read by the bb CLI, which rewrites it to --${stdinTarget} <value> before this command runs`,
          hint: `Pass --${stdinTarget} <value> here, or run this through the bb CLI.`
        });
      }
      const suggestion = nearest(
        spelled,
        visibleOptions(command).map(([optionName]) => optionName)
      );
      throw fail({
        code: "unknown_option",
        message: `unknown option '${long ? "--" : "-"}${spelled}'`,
        ...suggestion === null ? {} : { hint: `Did you mean --${suggestion}?` }
      });
    }
    if (option.type === "boolean") {
      if (inline !== void 0 && inline !== "true" && inline !== "false") {
        throw fail({
          code: "invalid_value",
          message: `invalid value '${inline}' for --${name}. Expected one of: true, false`
        });
      }
      if (parsed.flags.has(name)) {
        throw fail({
          code: "unexpected_argument",
          message: `--${name} was given more than once`
        });
      }
      if (inline !== "false") parsed.flags.add(name);
      continue;
    }
    const existing = parsed.values.get(name);
    if (existing !== void 0 && !isRepeatable(option)) {
      throw fail({
        code: "unexpected_argument",
        message: `--${name} was given more than once; it takes a single value`
      });
    }
    if (inline !== void 0) {
      parsed.values.set(name, [...existing ?? [], inline]);
      continue;
    }
    const next = argv[index + 1];
    if (next === void 0 || namesDeclaredOption(next, byName, byShort)) {
      throw fail({
        code: "invalid_value",
        message: `--${name} requires a value`,
        hint: `Write --${name}=<value> when the value is itself an option name.`
      });
    }
    parsed.values.set(name, [...existing ?? [], next]);
    index += 1;
  }
  return parsed;
}
function parseIntegerValue(name, option, raw) {
  const expected = `Expected an integer between ${option.min} and ${option.max}`;
  if (!/^-?\d+$/.test(raw)) {
    throw new Error(`invalid value '${raw}' for --${name}. ${expected}`);
  }
  const value = Number(raw);
  if (value < option.min || value > option.max) {
    throw new Error(`invalid value '${raw}' for --${name}. ${expected}`);
  }
  return value;
}
function durationExpectation(option) {
  const forms = (option.bareUnits ?? [option.defaultUnit]).map((unit) => {
    const unitMs = DURATION_UNIT_MS[unit];
    const low = option.min === void 0 ? null : Math.ceil(option.min / unitMs);
    const high = option.max === void 0 ? null : Math.floor(option.max / unitMs);
    const range = low !== null && high !== null ? ` (${low}-${high})` : "";
    return `a bare number of ${DURATION_UNIT_LABEL[unit]}${range}`;
  });
  return `Expected a duration with a unit (1500ms, 90s, 5m, 2h) or ${forms.join(", or ")}`;
}
function parseDurationValue(name, option, raw) {
  const invalid = () => new Error(
    `invalid value '${raw}' for --${name}. ${durationExpectation(option)}`
  );
  const match = DURATION_PATTERN.exec(raw.trim().toLowerCase());
  if (match === null) throw invalid();
  const amount = Number.parseFloat(match[1] ?? "");
  const unit = match[2];
  const inRange = (value) => (option.min === void 0 || value >= option.min) && (option.max === void 0 || value <= option.max);
  if (unit !== void 0) {
    const value = Math.round(
      amount * DURATION_UNIT_MS[unit]
    );
    if (!inRange(value)) throw invalid();
    return value;
  }
  for (const candidate of option.bareUnits ?? [option.defaultUnit]) {
    const value = Math.round(amount * DURATION_UNIT_MS[candidate]);
    if (inRange(value)) return value;
  }
  throw invalid();
}
function parseOptionValue(name, option, raw) {
  switch (option.type) {
    case "enum": {
      if (!option.values.includes(raw)) {
        throw new Error(
          `invalid value '${raw}' for --${name}. Expected one of: ${option.values.join(", ")}`
        );
      }
      return raw;
    }
    case "integer":
      return parseIntegerValue(name, option, raw);
    case "duration":
      return parseDurationValue(name, option, raw);
    default:
      return raw;
  }
}
function splitValues(option, values) {
  const separator = option.type === "string" || option.type === "enum" ? option.split : void 0;
  if (separator === void 0) return [...values];
  return values.flatMap(
    (value) => value.split(separator).map((part) => part.trim()).filter((part) => part.length > 0)
  );
}
function buildOptionValues(spec, path, command, parsed) {
  const values = {};
  const missing = [];
  for (const [name, option] of Object.entries(command.options ?? {})) {
    if (option.type === "boolean") {
      values[name] = parsed.flags.has(name);
      continue;
    }
    const raw = splitValues(option, parsed.values.get(name) ?? []);
    if (raw.length === 0) {
      if (option.required === true) missing.push(`--${name}`);
      if (isRepeatable(option)) values[name] = [];
      else values[name] = option.default;
      continue;
    }
    try {
      if (isRepeatable(option)) {
        values[name] = raw.map(
          (value) => String(parseOptionValue(name, option, value))
        );
        continue;
      }
      values[name] = parseOptionValue(name, option, raw[0] ?? "");
    } catch (error) {
      throw usageFailure(spec, path, command, {
        code: "invalid_value",
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }
  return { values, missing };
}
function buildPositionalValues(spec, path, command, parsed) {
  const values = {};
  const missing = [];
  const tokens = [...parsed.positionals];
  for (const positional of command.positionals ?? []) {
    if (positional.variadic === true) {
      const rest = tokens.splice(0, tokens.length);
      values[positional.name] = rest;
      if (positional.required === true && rest.length === 0) {
        missing.push(`<${positional.name}>`);
      }
      continue;
    }
    const token = tokens.shift();
    values[positional.name] = token;
    if (positional.required === true && token === void 0) {
      missing.push(`<${positional.name}>`);
    }
  }
  if (tokens.length > 0) {
    throw usageFailure(spec, path, command, {
      code: "unexpected_argument",
      message: `unexpected argument '${tokens[0]}'`,
      ...command.unexpectedPositionalHint === void 0 ? {} : { hint: command.unexpectedPositionalHint }
    });
  }
  return { values, missing };
}
function isPresent(command, parsed, name) {
  if (command.options?.[name]?.type === "boolean")
    return parsed.flags.has(name);
  return (parsed.values.get(name) ?? []).length > 0;
}
function checkConstraints(spec, path, command, parsed) {
  for (const constraint of command.constraints ?? []) {
    if (constraint.kind === "requires") {
      if (!isPresent(command, parsed, constraint.option)) continue;
      const absent = constraint.needs.filter(
        (need) => !isPresent(command, parsed, need)
      );
      if (absent.length === 0) continue;
      throw usageFailure(spec, path, command, {
        code: "missing_required",
        message: `--${constraint.option} requires ${absent.map((need) => `--${need}`).join(", ")}`
      });
    }
    const given = constraint.options.filter(
      (name) => isPresent(command, parsed, name)
    );
    const list = constraint.options.map((name) => `--${name}`).join(", ");
    if (given.length > 1 && constraint.kind !== "at-least-one") {
      throw usageFailure(spec, path, command, {
        code: "unexpected_argument",
        message: `${given.map((name) => `--${name}`).join(" and ")} cannot be combined`,
        hint: `${constraint.kind === "exactly-one" ? "Pass exactly one of" : "Pass at most one of"}: ${list}`
      });
    }
    if (given.length === 0 && constraint.kind !== "at-most-one") {
      throw usageFailure(spec, path, command, {
        code: "missing_required",
        message: `missing required options: one of ${list}`
      });
    }
  }
}
function renderErrorText(failure) {
  const blocks = [
    failure.hint === void 0 ? failure.message : `${failure.message} (${failure.hint})`
  ];
  if (failure.detail !== void 0) blocks.push(failure.detail);
  if (failure.usage !== void 0) blocks.push(failure.usage);
  return `${blocks.join("\n\n")}
`;
}
function renderErrorJson(failure) {
  const hint = failure.hint ?? failure.usage?.replace(/^Usage:\n {2}/, "");
  return `${JSON.stringify(
    {
      ok: false,
      error: {
        code: failure.code,
        message: failure.message,
        ...hint === void 0 ? {} : { hint }
      }
    },
    null,
    2
  )}
`;
}
function wantsJsonOutput(argv) {
  const terminator = argv.indexOf("--");
  const scanned = terminator === -1 ? argv : argv.slice(0, terminator);
  return scanned.some((token) => token === "--json" || token === "--json=true");
}
var NEGATIVE_NUMBER_PATTERN = /^-\.?\d/;
function normalizeShort(short) {
  return short.startsWith("-") ? short.slice(1) : short;
}
function assertValidSpec(spec) {
  const entries = Object.entries(
    spec.commands
  );
  if (spec.root !== void 0) entries.push(["", spec.root]);
  for (const [path, command] of entries) {
    const label = `bb ${[spec.name, path].filter((part) => part.length > 0).join(" ")}`;
    const spellings = /* @__PURE__ */ new Map([
      ["help", "the built-in --help"]
    ]);
    const shorts = /* @__PURE__ */ new Map([["h", "the built-in -h"]]);
    for (const [name, option] of Object.entries(command.options ?? {})) {
      for (const spelling of [name, ...option.aliases ?? []]) {
        const owner = spellings.get(spelling);
        if (owner !== void 0) {
          throw new Error(
            `${label}: --${spelling} is declared by both ${owner} and --${name}`
          );
        }
        spellings.set(spelling, `--${name}`);
      }
      if (option.short !== void 0) {
        const short = normalizeShort(option.short);
        if (short.length !== 1) {
          throw new Error(
            `${label}: short form ${JSON.stringify(option.short)} of --${name} must be one character`
          );
        }
        const owner = shorts.get(short);
        if (owner !== void 0) {
          throw new Error(
            `${label}: -${short} is declared by both ${owner} and --${name}`
          );
        }
        shorts.set(short, `--${name}`);
      }
      if ((option.type === "string" || option.type === "enum") && option.split !== void 0 && option.repeatable !== true) {
        throw new Error(
          `${label}: --${name} declares split without repeatable: true, which would drop every value after the first`
        );
      }
    }
  }
}
function failureResult(failure, wantsJson) {
  const stderr = renderErrorText(failure);
  if (!wantsJson) return { exitCode: failure.exitCode, stderr };
  return {
    exitCode: failure.exitCode,
    stdout: renderErrorJson(failure),
    stderr
  };
}
function defineCli(spec) {
  assertValidSpec(spec);
  const commands = visibleCommands(spec).map(
    ([path, command]) => ({
      name: path.replaceAll(" ", "-"),
      summary: command.summary,
      usage: usageLine(spec.name, path, command)
    })
  );
  return {
    name: spec.name,
    summary: spec.summary,
    commands,
    rendersHelp: true,
    async run(argv, ctx) {
      const wantsJson = wantsJsonOutput(argv);
      const asked = argv[0] === "help" ? argv.slice(1) : argv;
      const terminator = asked.indexOf("--");
      const scanned = terminator === -1 ? asked : asked.slice(0, terminator);
      const helpRequested = argv[0] === "help" || scanned.some((token) => token === "--help" || token === "-h");
      try {
        const words = leadingWords(scanned);
        const resolved = resolveCommand(spec, words);
        if (helpRequested) {
          if (resolved === null && words.length > 0) {
            const group = commandGroupRows(spec, words);
            if (group.length === 0) throw unknownCommandError(spec, words);
            return {
              exitCode: 0,
              stdout: renderGroupHelp(spec, words, group)
            };
          }
          return { exitCode: 0, stdout: renderHelp(spec, resolved) };
        }
        if (resolved === null) {
          const root = spec.root;
          if (root === void 0 || words.length > 0 && !root.positionals) {
            if (words.length > 0) {
              throw unknownCommandError(spec, words);
            }
            const failure = {
              code: "missing_command",
              message: "missing command",
              hint: `Run \`bb ${spec.name} --help\` for the command list.`,
              exitCode: spec.usageErrorExitCode ?? 1
            };
            if (!wantsJson) {
              return {
                exitCode: failure.exitCode,
                stdout: renderTopLevelHelp(spec)
              };
            }
            return {
              exitCode: failure.exitCode,
              stdout: renderErrorJson(failure),
              stderr: renderTopLevelHelp(spec)
            };
          }
        }
        const path = resolved?.path ?? "";
        const command = resolved?.command ?? spec.root;
        if (command === void 0) {
          throw unknownCommandError(spec, words);
        }
        const tail = asked.slice(resolved?.words ?? 0);
        const parsed = tokenize(spec, path, command, tail);
        const options = buildOptionValues(spec, path, command, parsed);
        const positionals = buildPositionalValues(spec, path, command, parsed);
        const missing = [
          ...positionals.missing.length > 0 ? [`missing required arguments: ${positionals.missing.join(", ")}`] : [],
          ...options.missing.length > 0 ? [`missing required options: ${options.missing.join(", ")}`] : []
        ];
        if (missing.length > 0) {
          throw usageFailure(spec, path, command, {
            code: "missing_required",
            message: missing.join("; ")
          });
        }
        checkConstraints(spec, path, command, parsed);
        return await command.run(
          {
            options: options.values,
            positionals: positionals.values,
            passthrough: parsed.passthrough,
            help: renderHelp(spec, resolved)
          },
          ctx
        );
      } catch (error) {
        if (error instanceof UsageError) {
          return failureResult(error.failure, wantsJson);
        }
        if (error instanceof PluginCliError) {
          return failureResult(
            {
              code: error.code,
              message: error.message,
              ...error.hint === void 0 ? {} : { hint: error.hint },
              exitCode: error.exitCode
            },
            wantsJson
          );
        }
        throw error;
      }
    }
  };
}

// src/host-contract.ts
function experimental_defineHostEntry(args) {
  return {
    experimental_apiVersion: 1,
    contract: args.contract,
    handlers: args.handlers,
    ...args.experimental_signals === void 0 ? {} : { experimental_signals: args.experimental_signals },
    ...args.dispose === void 0 ? {} : { dispose: args.dispose }
  };
}

// src/rpc-contract.ts
var rpcErrorCodes = [
  "forbidden",
  "not_found",
  "conflict",
  "invalid",
  "invalid_json",
  "invalid_input",
  "handler_error",
  "invalid_output",
  "non_json_result",
  "unknown_method",
  "transport_error",
  "invalid_response",
  "unknown_error"
];
var callErrorBrand = /* @__PURE__ */ Symbol.for("@get-bb/plugin-sdk/rpc-call-error");
var experimental_PluginRpcCallError = class _experimental_PluginRpcCallError extends Error {
  /** Recognizes errors across the packed SDK's separately bundled entries. */
  static [Symbol.hasInstance](value) {
    return typeof value === "object" && value !== null && Reflect.get(value, callErrorBrand) === true && rpcErrorCodes.some((code) => code === Reflect.get(value, "code")) && typeof Reflect.get(value, "message") === "string";
  }
  code;
  issues;
  status;
  serverCode;
  constructor(args) {
    super(args.message);
    this.name = "experimental_PluginRpcCallError";
    Object.defineProperty(this, callErrorBrand, { value: true });
    this.code = args.code;
    this.issues = args.issues;
    this.status = args.status;
    this.serverCode = args.serverCode;
  }
  /** Normalize failures at the RPC boundary; preserves an existing client error. */
  static from(error, fallback = "transport_error") {
    if (error instanceof _experimental_PluginRpcCallError) return error;
    const record = typeof error === "object" && error !== null ? error : {};
    const rawCode = Reflect.get(record, "code");
    const code = rpcErrorCodes.find((value) => value === rawCode);
    const message = Reflect.get(record, "message");
    const status = Reflect.get(record, "status");
    const rawIssues = Reflect.get(record, "issues");
    const issues = [];
    if (Array.isArray(rawIssues))
      for (const issue of rawIssues) {
        if (typeof issue !== "object" || issue === null || typeof Reflect.get(issue, "message") !== "string")
          continue;
        const path = Reflect.get(issue, "path");
        if (path !== void 0 && (!Array.isArray(path) || !path.every(
          (part) => typeof part === "string" || typeof part === "number" && Number.isFinite(part)
        )))
          continue;
        issues.push({
          message: Reflect.get(issue, "message"),
          ...path === void 0 ? {} : { path }
        });
      }
    return new _experimental_PluginRpcCallError({
      code: code ?? (typeof rawCode === "string" ? "unknown_error" : fallback),
      message: typeof message === "string" ? message : typeof error === "string" ? error : "Plugin RPC request failed",
      ...issues.length === 0 ? {} : { issues },
      ...typeof status === "number" ? { status } : {},
      ...typeof rawCode === "string" && code === void 0 ? { serverCode: rawCode } : {}
    });
  }
};
var refusalBrand = /* @__PURE__ */ Symbol.for("@get-bb/plugin-sdk/rpc-refusal");
var experimental_PluginRpcRefusal = class extends Error {
  [refusalBrand] = true;
  code;
  issues;
  constructor(args) {
    super(args.message);
    this.name = "experimental_PluginRpcRefusal";
    this.code = args.code;
    this.issues = args.issues;
  }
};
function defineRpcContract(contract) {
  return contract;
}

// src/thread-action-groups.ts
var experimental_THREAD_ACTION_GROUPS = {
  open: "1_open",
  state: "1_state",
  organize: "2_organize",
  settings: "3_settings",
  lifecycle: "4_lifecycle"
};

// src/thread-info-groups.ts
var experimental_THREAD_CONTEXT_SEGMENT_GROUPS = {
  thread: "1_thread",
  git: "3_git"
};
var experimental_THREAD_INFO_ROW_GROUPS = {
  thread: "1_thread",
  environment: "2_environment",
  git: "3_git",
  pullRequest: "4_pullRequest",
  lifecycle: "5_lifecycle"
};
var experimental_THREAD_INFO_SECTION_GROUPS = {
  related: "1_related",
  changes: "2_changes",
  storage: "3_storage"
};

// ../domain/src/host-path.ts
var WINDOWS_DRIVE_PATH_PATTERN = /^([A-Za-z]):(?:[\\/]+|$)/u;
var WINDOWS_UNC_PATH_PATTERN = /^[\\/]{2}([^\\/]+)[\\/]+([^\\/]+)(?:[\\/]+|$)/u;
var WINDOWS_SEPARATOR_PATTERN = /[\\/]+/u;
function collapseSegments(rawSegments) {
  const segments = [];
  for (const segment of rawSegments) {
    if (segment.length === 0 || segment === ".") {
      continue;
    }
    if (segment === "..") {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments;
}
function splitHostPathRoot(path) {
  const drive = WINDOWS_DRIVE_PATH_PATTERN.exec(path);
  if (drive) {
    return {
      flavor: "windows",
      root: `${(drive[1] ?? "").toUpperCase()}:\\`,
      relativePath: path.slice(drive[0].length)
    };
  }
  const unc = WINDOWS_UNC_PATH_PATTERN.exec(path);
  if (unc) {
    return {
      flavor: "windows",
      root: `\\\\${unc[1] ?? ""}\\${unc[2] ?? ""}\\`,
      relativePath: path.slice(unc[0].length)
    };
  }
  if (path.startsWith("/")) {
    return { flavor: "posix", root: "/", relativePath: path.slice(1) };
  }
  return null;
}
function parseHostPath(path) {
  const split = splitHostPathRoot(path);
  if (split === null) {
    return null;
  }
  return {
    flavor: split.flavor,
    root: split.root,
    segments: collapseSegments(
      split.relativePath.split(
        split.flavor === "windows" ? WINDOWS_SEPARATOR_PATTERN : "/"
      )
    )
  };
}
function formatHostPath(parsed) {
  if (parsed.flavor === "posix") {
    return `/${parsed.segments.join("/")}`;
  }
  if (parsed.segments.length === 0) {
    return parsed.root;
  }
  return `${parsed.root}${parsed.segments.join("\\")}`;
}
function comparisonSegments(parsed) {
  return parsed.flavor === "windows" ? parsed.segments.map((segment) => segment.toLowerCase()) : parsed.segments;
}
function comparisonRoot(parsed) {
  return parsed.flavor === "windows" ? parsed.root.toLowerCase() : parsed.root;
}
function normalizeHostPath(path) {
  const parsed = parseHostPath(path);
  return parsed === null ? null : formatHostPath(parsed);
}
function getHostPathComparisonKey(path) {
  const parsed = parseHostPath(path);
  if (parsed === null) {
    return null;
  }
  return formatHostPath({
    flavor: parsed.flavor,
    root: comparisonRoot(parsed),
    segments: comparisonSegments(parsed)
  });
}
function isHostPathWithin({
  rootPath,
  candidatePath
}) {
  const root = parseHostPath(rootPath);
  const candidate = parseHostPath(candidatePath);
  if (root === null || candidate === null || root.flavor !== candidate.flavor || comparisonRoot(root) !== comparisonRoot(candidate)) {
    return false;
  }
  const rootSegments = comparisonSegments(root);
  const candidateSegments = comparisonSegments(candidate);
  return rootSegments.length <= candidateSegments.length && rootSegments.every((segment, index) => segment === candidateSegments[index]);
}
function joinHostPath({
  rootPath,
  relativePath
}) {
  const parsed = parseHostPath(rootPath);
  if (parsed === null) {
    return null;
  }
  const relativeSegments = relativePath.split(
    parsed.flavor === "windows" ? WINDOWS_SEPARATOR_PATTERN : "/"
  );
  return formatHostPath({
    ...parsed,
    segments: collapseSegments([...parsed.segments, ...relativeSegments])
  });
}
function resolveHostPath({
  rootPath,
  path
}) {
  if (path.length === 0 || path.includes("\0") || rootPath.includes("\0")) {
    return null;
  }
  const absolute = normalizeHostPath(path);
  if (absolute !== null) return absolute;
  if (path.startsWith("\\") || /^[A-Za-z]:/u.test(path)) return null;
  return joinHostPath({ rootPath, relativePath: path });
}
function getHostPathDirname(path) {
  const parsed = parseHostPath(path);
  if (parsed === null) {
    return null;
  }
  return formatHostPath({ ...parsed, segments: parsed.segments.slice(0, -1) });
}
function getHostPathBasename(path) {
  const parsed = parseHostPath(path);
  if (parsed === null) {
    return null;
  }
  return parsed.segments.at(-1) ?? "";
}
function getRelativeHostPath({
  rootPath,
  candidatePath
}) {
  if (!isHostPathWithin({ rootPath, candidatePath })) {
    return null;
  }
  const rootSegments = parseHostPath(rootPath)?.segments ?? [];
  const candidateSegments = parseHostPath(candidatePath)?.segments ?? [];
  return candidateSegments.slice(rootSegments.length).join("/");
}
export {
  PLUGIN_CLI_OUTPUT_MAX_BYTES,
  PluginCliError,
  cliCommand,
  defineCli,
  defineRpcContract,
  experimental_AI_MODEL_ID_MAX_LENGTH,
  experimental_AiGenerationError,
  experimental_PluginRpcCallError,
  experimental_PluginRpcRefusal,
  experimental_THREAD_ACTION_GROUPS,
  experimental_THREAD_CONTEXT_SEGMENT_GROUPS,
  experimental_THREAD_INFO_ROW_GROUPS,
  experimental_THREAD_INFO_SECTION_GROUPS,
  experimental_defineHostEntry,
  getHostPathBasename as experimental_getHostPathBasename,
  getHostPathComparisonKey as experimental_getHostPathComparisonKey,
  getHostPathDirname as experimental_getHostPathDirname,
  getRelativeHostPath as experimental_getRelativeHostPath,
  isHostPathWithin as experimental_isHostPathWithin,
  joinHostPath as experimental_joinHostPath,
  normalizeHostPath as experimental_normalizeHostPath,
  resolveHostPath as experimental_resolveHostPath
};
