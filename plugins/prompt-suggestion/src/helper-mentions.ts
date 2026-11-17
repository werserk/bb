import type { ComposerDraftSnapshot } from "@get-bb/plugin-sdk/app";

type Mention = ComposerDraftSnapshot["mentions"][number];
export function encodeHelperDraft(
  draft: ComposerDraftSnapshot,
  requestId: string,
) {
  if (draft.text.includes("<<BB_MENTION_"))
    throw new Error("The draft contains reserved mention markers.");
  let cursor = 0;
  let text = "";
  const mentions = [...draft.mentions]
    .sort((a, b) => a.from - b.from)
    .map((mention, index) => {
      if (
        mention.from < cursor ||
        mention.to <= mention.from ||
        mention.to > draft.text.length
      )
        throw new Error("The draft contains invalid mentions.");
      const token = `<<BB_MENTION_${requestId}_${index}>>`;
      text += draft.text.slice(cursor, mention.from) + token;
      const label = draft.text.slice(mention.from, mention.to);
      cursor = mention.to;
      return { token, mention, label };
    });
  text += draft.text.slice(cursor);
  return {
    text,
    mentions,
    protectedMentions: mentions.map(({ token }) => token),
  };
}

export function decodeHelperDraft(
  text: string,
  encoded: ReturnType<typeof encodeHelperDraft>,
) {
  const mentions: Mention[] = [];
  let cursor = 0;
  let restored = "";
  const markers = [...text.matchAll(/<<BB_MENTION_[^<>]*>>/g)];
  const seen = new Set<string>();
  for (const marker of markers) {
    const original = encoded.mentions.find(({ token }) => token === marker[0]);
    if (!original || seen.has(marker[0])) return null;
    seen.add(marker[0]);
    restored += text.slice(cursor, marker.index);
    const from = restored.length;
    restored += original.label;
    mentions.push({ ...original.mention, from, to: restored.length });
    cursor = marker.index + marker[0].length;
  }
  restored += text.slice(cursor);
  if (
    seen.size !== encoded.mentions.length ||
    restored.includes("<<BB_MENTION_")
  )
    return null;
  return { text: restored, mentions };
}
