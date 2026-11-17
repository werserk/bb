import { describe, expect, it } from "vitest";
import { encodeHelperDraft, decodeHelperDraft } from "./helper-mentions.js";

const draft = {
  text: "😀 Ask @same then @same",
  mentions: [
    {
      kind: "thread" as const,
      from: 7,
      to: 12,
      label: "same",
      threadId: "one",
    },
    {
      kind: "thread" as const,
      from: 18,
      to: 23,
      label: "same",
      threadId: "two",
    },
  ],
  attachments: [],
};
describe("helper mention custody", () => {
  it("restores duplicate display labels and Unicode offsets with distinct identities", () => {
    const encoded = encodeHelperDraft(draft, "request");
    const decoded = decodeHelperDraft(
      `😀 ${encoded.protectedMentions[1]} then ${encoded.protectedMentions[0]}`,
      encoded,
    )!;
    expect(decoded.text).toBe("😀 @same then @same");
    expect(
      decoded.mentions.map((mention) => [
        mention.kind === "thread" && mention.threadId,
        mention.from,
        mention.to,
      ]),
    ).toEqual([
      ["two", 3, 8],
      ["one", 14, 19],
    ]);
  });
  it("rejects missing, duplicated, forged and malformed markers", () => {
    const encoded = encodeHelperDraft(draft, "request");
    for (const text of [
      encoded.protectedMentions[0]!,
      encoded.text + encoded.protectedMentions[0],
      encoded.text + "<<BB_MENTION_unknown>>",
      encoded.text + "<<BB_MENTION_broken",
    ])
      expect(decodeHelperDraft(text, encoded)).toBeNull();
  });
  it("rejects marker collisions before inference", () => {
    expect(() =>
      encodeHelperDraft(
        { text: "<<BB_MENTION_reserved>>", mentions: [], attachments: [] },
        "request",
      ),
    ).toThrow("reserved");
  });
});
