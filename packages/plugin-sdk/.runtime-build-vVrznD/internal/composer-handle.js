// src/internal/composer-suggestion.ts
import { z } from "zod";
var candidateSchema = z.object({
  requestId: z.string().min(1),
  text: z.string().refine((value) => value.trim().length > 0 && [...value].length <= 600),
  snapshot: z.object({
    composerKey: z.string(),
    threadId: z.string(),
    completedTurnId: z.string(),
    contextRevision: z.string(),
    draftRevision: z.number().int().nonnegative()
  })
});
function createComposerSuggestionController(replace, canUse = () => true) {
  let revision = 0;
  let latestRequestId = null;
  let input = {
    composerKey: "",
    threadId: null,
    contextRevision: "",
    completedTurnId: "",
    eligible: false
  };
  let state = Object.freeze({
    eligible: false,
    snapshot: null,
    candidate: null,
    request: null
  });
  const listeners = /* @__PURE__ */ new Set();
  const events = /* @__PURE__ */ new Set();
  const emit = (kind, requestId) => {
    for (const listener of [...events]) listener({ kind, requestId });
  };
  const publish = (next) => {
    state = Object.freeze(next);
    for (const listener of [...listeners]) listener();
  };
  const matches = (snapshot) => {
    const current = state.snapshot;
    return current !== null && current.composerKey === snapshot.composerKey && current.threadId === snapshot.threadId && current.completedTurnId === snapshot.completedTurnId && current.contextRevision === snapshot.contextRevision && current.draftRevision === snapshot.draftRevision;
  };
  const invalidate = (dismissed = true) => {
    revision++;
    latestRequestId = null;
    const old = state.candidate;
    publish({
      eligible: input.eligible,
      snapshot: input.threadId === null ? null : Object.freeze({
        composerKey: input.composerKey,
        threadId: input.threadId,
        completedTurnId: input.completedTurnId,
        contextRevision: input.contextRevision,
        draftRevision: revision
      }),
      candidate: null,
      request: null
    });
    if (dismissed) emit("dismissed", old?.requestId ?? null);
  };
  const controller = {
    getSnapshot: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    onEvent(listener) {
      events.add(listener);
      return () => {
        events.delete(listener);
      };
    },
    experimental_begin(requestId, snapshot) {
      if (!requestId || !state.eligible || !canUse() || !matches(snapshot))
        return false;
      latestRequestId = requestId;
      publish({
        ...state,
        candidate: null,
        request: Object.freeze({
          requestId,
          snapshot,
          phase: "pending",
          error: null
        })
      });
      return true;
    },
    experimental_finish(requestId, snapshot, error) {
      if (state.request?.requestId !== requestId || !matches(snapshot) || !state.eligible || !canUse())
        return false;
      publish({
        ...state,
        request: error === null ? null : Object.freeze({ requestId, snapshot, phase: "error", error })
      });
      return true;
    },
    show(value) {
      const parsed = candidateSchema.safeParse(value);
      if (!parsed.success) return false;
      const candidate = parsed.data;
      if (!state.eligible || !canUse() || !matches(candidate.snapshot) || latestRequestId !== null && (latestRequestId !== candidate.requestId || state.request?.phase !== "pending"))
        return false;
      publish({
        ...state,
        request: null,
        candidate: Object.freeze({
          ...candidate,
          snapshot: Object.freeze({ ...candidate.snapshot })
        })
      });
      emit("shown", candidate.requestId);
      return true;
    },
    clear(requestId) {
      if (state.candidate?.requestId === requestId) invalidate();
      else if (state.request?.requestId === requestId)
        publish({ ...state, request: null });
    },
    dismiss: () => invalidate(),
    accept(requestId) {
      if (!state.eligible || !canUse()) return "ineligible";
      const candidate = state.candidate;
      if (candidate?.requestId !== requestId || !matches(candidate.snapshot))
        return "stale";
      invalidate(false);
      replace(candidate.text);
      emit("accepted", requestId);
      return "accepted";
    }
  };
  return {
    controller,
    update(next) {
      if (JSON.stringify(input) === JSON.stringify(next)) return;
      input = next;
      invalidate();
    },
    draftChanged: () => invalidate(),
    dispose() {
      input = { ...input, eligible: false, threadId: null };
      invalidate();
    }
  };
}

// src/internal/composer-draft-transforms.ts
function removeComposerMentions(draft, matches) {
  const removed = draft.mentions.filter(matches).sort((a, b) => a.from - b.from);
  if (removed.length === 0) return draft;
  let text = "";
  let cursor = 0;
  for (const mention of removed) {
    text += draft.text.slice(cursor, mention.from);
    cursor = mention.to;
  }
  const removedSet = new Set(removed);
  const mentions = draft.mentions.filter((mention) => !removedSet.has(mention)).map((mention) => {
    const offset = removed.reduce(
      (sum, item) => sum + (item.to <= mention.from ? item.to - item.from : 0),
      0
    );
    return offset === 0 ? mention : { ...mention, from: mention.from - offset, to: mention.to - offset };
  });
  return { ...draft, text: text + draft.text.slice(cursor), mentions };
}
function setComposerText(draft, text) {
  if (text === draft.text) return draft;
  return {
    ...draft,
    text,
    mentions: reconcileComposerMentions(draft.text, text, draft.mentions)
  };
}
function reconcileComposerMentions(currentText, nextText, mentions) {
  if (currentText === nextText) return [...mentions];
  let unchangedPrefixLength = 0;
  const maximumPrefixLength = Math.min(currentText.length, nextText.length);
  while (unchangedPrefixLength < maximumPrefixLength && currentText[unchangedPrefixLength] === nextText[unchangedPrefixLength]) {
    unchangedPrefixLength += 1;
  }
  let unchangedSuffixLength = 0;
  while (unchangedSuffixLength < currentText.length - unchangedPrefixLength && unchangedSuffixLength < nextText.length - unchangedPrefixLength && currentText[currentText.length - unchangedSuffixLength - 1] === nextText[nextText.length - unchangedSuffixLength - 1]) {
    unchangedSuffixLength += 1;
  }
  const replacedCurrentEnd = currentText.length - unchangedSuffixLength;
  const replacementDelta = nextText.length - currentText.length;
  return mentions.flatMap((mention) => {
    if (mention.to <= unchangedPrefixLength) return [mention];
    if (mention.from >= replacedCurrentEnd) {
      return [
        {
          ...mention,
          from: mention.from + replacementDelta,
          to: mention.to + replacementDelta
        }
      ];
    }
    return [];
  });
}

// src/internal/composer-draft-actions.ts
import { z as z2 } from "zod";
var range = {
  from: z2.number().int().nonnegative(),
  to: z2.number().int().nonnegative(),
  label: z2.string()
};
var mentionSchema = z2.discriminatedUnion("kind", [
  z2.object({
    ...range,
    kind: z2.literal("thread"),
    threadId: z2.string(),
    projectId: z2.string().optional()
  }),
  z2.object({ ...range, kind: z2.literal("project"), projectId: z2.string() }),
  z2.object({ ...range, kind: z2.literal("section"), sectionId: z2.string() }),
  z2.object({
    ...range,
    kind: z2.literal("path"),
    path: z2.string(),
    source: z2.enum(["workspace", "thread-storage"]),
    entryKind: z2.enum(["file", "directory"])
  }),
  z2.object({
    ...range,
    kind: z2.literal("command"),
    trigger: z2.enum(["/", "$"]),
    name: z2.string(),
    source: z2.enum(["skill", "command"]),
    origin: z2.enum(["builtin", "project", "user"]),
    argumentHint: z2.string().nullable()
  }),
  z2.object({ ...range, kind: z2.literal("attachment"), path: z2.string() }),
  z2.object({
    ...range,
    kind: z2.literal("plugin"),
    pluginId: z2.string(),
    provider: z2.string().min(1).refine((value) => !value.includes(":")),
    id: z2.string(),
    icon: z2.string().nullable().optional()
  })
]);
var attachmentFields = {
  type: z2.enum(["localImage", "localFile"]),
  path: z2.string().min(1),
  name: z2.string(),
  mimeType: z2.string().optional(),
  sizeBytes: z2.number().nonnegative().optional()
};
var attachmentsSchema = z2.array(
  z2.union([
    z2.object({
      ...attachmentFields,
      hostId: z2.string().min(1),
      sourceProjectId: z2.undefined().optional()
    }),
    z2.object({
      ...attachmentFields,
      sourceProjectId: z2.string().min(1).optional(),
      hostId: z2.undefined().optional()
    })
  ])
);
var replacementSchema = z2.object({
  text: z2.string(),
  mentions: z2.array(mentionSchema),
  attachments: attachmentsSchema.optional()
}).superRefine((draft, context) => {
  let end = 0;
  for (const mention of [...draft.mentions].sort((a, b) => a.from - b.from)) {
    if (mention.from < end || mention.to <= mention.from || mention.to > draft.text.length) {
      context.addIssue({
        code: "custom",
        message: "Mention ranges must be non-overlapping and inside the draft text."
      });
    }
    end = mention.to;
  }
});
function createComposerDraftActions(target) {
  let cached = null;
  const snapshotOf = (current) => {
    const content = current.getDraft();
    if (cached?.content === content) return cached.snapshot;
    const snapshot = Object.freeze({
      text: content.text,
      mentions: Object.freeze(
        content.mentions.map((mention) => Object.freeze({ ...mention }))
      ),
      attachments: Object.freeze(
        content.attachments.map(
          (attachment) => Object.freeze({ ...attachment })
        )
      )
    });
    cached = { content, snapshot };
    return snapshot;
  };
  const requireAvailable = (current) => {
    if (!current.isAvailable())
      throw new Error("This composer is no longer available.");
  };
  return {
    get draft() {
      return snapshotOf(target());
    },
    replace(next) {
      const current = target();
      requireAvailable(current);
      const snapshot = snapshotOf(current);
      const result = typeof next === "function" ? next(snapshot) : next;
      requireAvailable(current);
      if (result === snapshot) return;
      const parsed = replacementSchema.safeParse(result);
      if (!parsed.success)
        throw new Error(
          "Invalid composer draft: text, mention ranges, or attachments are invalid."
        );
      current.setDraft(parsed.data);
    },
    focus() {
      const current = target();
      requireAvailable(current);
      current.focus();
    }
  };
}

// src/internal/composer-handle.ts
var UNAVAILABLE_MESSAGE = "This composer is no longer available.";
var OFF_SCREEN_MESSAGE = "This composer isn't on screen.";
var OFF_SCREEN_EDITOR_STATE = {
  layout: "expanded",
  isRunning: false,
  isSubmitting: false,
  isSubmittingBlocked: true,
  submittingBlockedReason: OFF_SCREEN_MESSAGE,
  isAttaching: false,
  attachmentError: null
};
var warnedAliases = /* @__PURE__ */ new Set();
function warnDeprecatedComposerMember(oldName, newName) {
  if (warnedAliases.has(oldName)) return;
  warnedAliases.add(oldName);
  console.warn(
    `useComposer().${oldName} is deprecated; use useComposer().${newName}.`
  );
}
function appendComposerDraft(current, value, block) {
  const base = block ? current.text.replace(/\s+$/u, "") : current.text;
  const separator = block && base.length > 0 ? "\n\n" : "";
  const offset = base.length + separator.length;
  return {
    text: `${base}${separator}${value.text}`,
    mentions: [
      ...current.mentions.filter((mention) => mention.to <= base.length),
      ...value.mentions.map((mention) => ({
        ...mention,
        from: mention.from + offset,
        to: mention.to + offset
      }))
    ]
  };
}
function validProviderId(provider) {
  const trimmed = provider.trim();
  return trimmed.length === 0 || trimmed.includes(":") ? null : trimmed;
}
function insertValue(parts, controller) {
  const list = Array.isArray(parts) ? parts : [parts];
  let text = "";
  const mentions = [];
  for (const part of list) {
    if (typeof part === "string") {
      text += part;
      continue;
    }
    let mention;
    if ("kind" in part) {
      mention = part;
    } else {
      const provider = validProviderId(part.provider);
      if (provider === null) {
        throw new Error(`Invalid mention provider id "${part.provider}".`);
      }
      mention = {
        from: 0,
        to: 0,
        label: part.label.trim() || part.id,
        kind: "plugin",
        pluginId: controller.pluginId,
        provider,
        id: part.id,
        icon: null
      };
    }
    const serialized = controller.mentionText(mention);
    mentions.push({
      ...mention,
      from: text.length,
      to: text.length + serialized.length
    });
    text += serialized;
  }
  return { text, mentions };
}
function isDraftEmpty(draft, attachmentCount) {
  return draft.text.trim().length === 0 && draft.mentions.length === 0 && attachmentCount === 0;
}
var legacyDrafts = /* @__PURE__ */ new WeakMap();
function withLegacyDraftFields(draft, attachmentCount) {
  const cached = legacyDrafts.get(draft);
  if (cached) return cached;
  const snapshot = { ...draft };
  Object.defineProperties(snapshot, {
    isEmpty: { value: isDraftEmpty(draft, attachmentCount), enumerable: false },
    attachmentCount: { value: attachmentCount, enumerable: false }
  });
  Object.freeze(snapshot);
  legacyDrafts.set(draft, snapshot);
  return snapshot;
}
function waitForUploads(target) {
  return new Promise((resolve) => {
    if (!target.getEditorState().isAttaching) {
      resolve();
      return;
    }
    const unsubscribe = target.subscribeEditorState(() => {
      if (target.getEditorState().isAttaching) return;
      unsubscribe();
      resolve();
    });
  });
}
function createComposerHandleBinding(key, initial) {
  let controller = initial;
  const target = () => controller.target;
  const editorState = () => target().getEditorState();
  const requireAvailable = () => {
    if (!target().isAvailable()) throw new Error(UNAVAILABLE_MESSAGE);
  };
  const legacyAvailable = (method) => {
    if (target().isAvailable()) return true;
    console.warn(
      `[plugin:${controller.pluginId}] useComposer().${method}: ${UNAVAILABLE_MESSAGE}`
    );
    return false;
  };
  const replaceText = (nextText) => {
    const current = target().getDraft();
    if (nextText === current.text) return;
    target().setDraft(setComposerText(current, nextText));
  };
  const insertMention = (mention) => {
    warnDeprecatedComposerMember("insertMention", "insert");
    const provider = validProviderId(mention.provider);
    if (provider === null) {
      console.warn(
        `[plugin:${controller.pluginId}] useComposer().insertMention: invalid provider id "${mention.provider}"`
      );
      return;
    }
    if (!legacyAvailable("insertMention")) return;
    const label = mention.label.trim() || mention.id;
    const current = target().getDraft();
    const separator = current.text.length === 0 || /\s$/u.test(current.text) ? "" : " ";
    const from = current.text.length + separator.length;
    target().setDraft({
      text: `${current.text}${separator}${label} `,
      mentions: [
        ...current.mentions,
        {
          from,
          to: from + label.length,
          label,
          kind: "plugin",
          pluginId: controller.pluginId,
          provider,
          id: mention.id,
          icon: null
        }
      ]
    });
    target().focus();
  };
  const removeMentionFrom = (mention) => {
    const current = target().getDraft();
    const next = removeComposerMentions(
      current,
      (item) => item.kind === "plugin" && item.pluginId === controller.pluginId && item.provider === mention.provider && item.id === mention.id
    );
    if (next !== current) target().setDraft(next);
  };
  const removeMention = (mention) => {
    warnDeprecatedComposerMember("removeMention", "replace");
    requireAvailable();
    removeMentionFrom(mention);
  };
  const insert = (parts, options = {}) => {
    requireAvailable();
    const value = insertValue(parts, controller);
    const block = options.block === true;
    if ((options.at ?? "cursor") === "cursor") {
      if (!target().insertAtCursor(value, block)) {
        throw new Error(OFF_SCREEN_MESSAGE);
      }
      return;
    }
    target().setDraft(appendComposerDraft(target().getDraft(), value, block));
  };
  const submit = async (options = {}) => {
    requireAvailable();
    if (options.sendAt !== void 0 && (!Number.isFinite(options.sendAt) || options.sendAt <= Date.now())) {
      throw new Error("Pick a time in the future.");
    }
    const errorBefore = editorState().attachmentError;
    if (editorState().isAttaching) await waitForUploads(target());
    const state = editorState();
    if (state.attachmentError !== null && state.attachmentError !== errorBefore) {
      throw new Error(state.attachmentError);
    }
    const submission = target().editorSubmit({
      mode: options.experimental_mode ?? "enter",
      ...options.sendAt === void 0 ? {} : { sendAt: options.sendAt },
      ...options.experimental_data === void 0 ? {} : {
        pluginSubmission: {
          pluginId: controller.pluginId,
          data: options.experimental_data
        }
      }
    });
    if (submission === null) throw new Error(OFF_SCREEN_MESSAGE);
    await submission;
  };
  const setSelection = async (selection) => {
    requireAvailable();
    const hostSetSelection = target().setSelection;
    if (hostSetSelection === void 0) {
      throw new Error("This composer has no pickers to set.");
    }
    return hostSetSelection(selection);
  };
  const submittedListeners = /* @__PURE__ */ new Set();
  let submittedSubscription = null;
  const syncSubmittedSubscription = () => {
    const scope = submittedListeners.size === 0 ? null : JSON.stringify(target().scope);
    if (submittedSubscription?.scope === scope) return;
    submittedSubscription?.unsubscribe();
    submittedSubscription = scope === null ? null : {
      scope,
      unsubscribe: controller.onSubmitted(() => {
        for (const listener of [...submittedListeners]) {
          try {
            listener();
          } catch (error) {
            console.error("Composer submission listener failed", error);
          }
        }
      })
    };
  };
  const onSubmitted = (listener) => {
    const entry = () => listener();
    submittedListeners.add(entry);
    syncSubmittedSubscription();
    return () => {
      submittedListeners.delete(entry);
      syncSubmittedSubscription();
    };
  };
  const draftActions = createComposerDraftActions(target);
  const unsupportedSuggestions = createComposerSuggestionController(
    () => {
    }
  ).controller;
  const handle = {
    get experimental_suggestions() {
      return target().suggestions ?? unsupportedSuggestions;
    },
    replace: draftActions.replace,
    get scope() {
      return target().scope;
    },
    get key() {
      return target().key;
    },
    get layout() {
      return editorState().layout;
    },
    get isRunning() {
      return editorState().isRunning;
    },
    get isSubmitting() {
      return editorState().isSubmitting;
    },
    get isSubmittingBlocked() {
      return editorState().isSubmittingBlocked;
    },
    get submittingBlockedReason() {
      return editorState().submittingBlockedReason;
    },
    get isEmpty() {
      return isDraftEmpty(target().getDraft(), target().getAttachmentCount());
    },
    get attachmentCount() {
      return target().getAttachmentCount();
    },
    get text() {
      return target().getDraft().text;
    },
    get draft() {
      return withLegacyDraftFields(
        draftActions.draft,
        target().getAttachmentCount()
      );
    },
    get selection() {
      return target().getSelection();
    },
    setText: (next) => {
      warnDeprecatedComposerMember("setText", "replace");
      if (legacyAvailable("setText")) replaceText(next);
    },
    updateText: (updater) => {
      warnDeprecatedComposerMember("updateText", "replace");
      if (legacyAvailable("updateText")) {
        replaceText(updater(target().getDraft().text));
      }
    },
    clear: () => {
      warnDeprecatedComposerMember("clear", "replace");
      if (legacyAvailable("clear")) replaceText("");
    },
    insert,
    setTextEffect: (effect) => controller.setTextEffect(effect),
    setInputLock: (locked) => controller.setInputLock(locked),
    addQuote: (text) => {
      warnDeprecatedComposerMember("addQuote", "replace");
      if (!legacyAvailable("addQuote")) return;
      target().addQuote(text);
      target().focus();
    },
    insertMention,
    removeMention,
    onSubmitted,
    focus: () => target().focus(),
    experimental_openPopup: (id) => target().openPopup?.(controller.pluginId, id) ?? false,
    experimental_closePopup: () => target().closePopup?.(controller.pluginId) ?? false,
    submit,
    setSelection,
    experimental_removeMention: (mention) => {
      warnDeprecatedComposerMember("experimental_removeMention", "replace");
      if (!legacyAvailable("experimental_removeMention")) return;
      removeMentionFrom(mention);
    },
    experimental_onSubmitted: (listener) => {
      warnDeprecatedComposerMember("experimental_onSubmitted", "onSubmitted");
      return onSubmitted(listener);
    },
    experimental_submit: (options) => {
      warnDeprecatedComposerMember("experimental_submit", "submit");
      return submit(options);
    },
    experimental_setSelection: (selection) => {
      warnDeprecatedComposerMember("experimental_setSelection", "setSelection");
      return setSelection(selection);
    }
  };
  Object.defineProperties(handle, {
    run: {
      enumerable: false,
      get: () => {
        const state = editorState();
        return { isRunning: state.isRunning, isSubmitting: state.isSubmitting };
      }
    },
    setThreadRowStatus: { enumerable: false, value: () => {
    } }
  });
  return {
    key,
    handle,
    update(next) {
      controller = next;
      syncSubmittedSubscription();
    }
  };
}
export {
  OFF_SCREEN_EDITOR_STATE,
  appendComposerDraft,
  createComposerDraftActions,
  createComposerHandleBinding,
  createComposerSuggestionController,
  reconcileComposerMentions
};
