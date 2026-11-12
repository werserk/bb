import { describe, expect, it } from "vitest";
import {
  conversationQuestionPublicationSchema,
  normalizeConversationQuestionPublication,
  conversationQuestionMarker,
  parseConversationQuestionMarker,
  normalizeConversationQuestionAnswers,
} from "../src/conversation-questions.js";

const publication = {
  body: "Listen to the attached samples.",
  questions: [
    {
      id: "voice",
      prompt: "Which voice?",
      shortLabel: "Voice",
      multiSelect: false,
      options: [
        { value: "a", label: "A" },
        { value: "b", label: "B" },
      ],
      allowFreeText: true,
      required: true,
    },
  ],
  materials: [{ path: "samples/a.mp3", label: "Voice A", dependencies: [] }],
};

describe("independent question boundaries", () => {
  it("requires real material references rather than accepting a promise as an attachment", () => {
    expect(
      conversationQuestionPublicationSchema.safeParse({
        ...publication,
        materials: ["samples are above"],
      }).success,
    ).toBe(false);
    expect(
      conversationQuestionPublicationSchema.parse(publication).materials[0]
        ?.path,
    ).toBe("samples/a.mp3");
  });

  it.each([
    "../secret.mp3",
    "/tmp/a.mp3",
    "samples/../a.mp3",
    "C:\\secret.mp3",
    "\\\\host\\share\\a.mp3",
    "https://example.com/a.mp3",
  ])("rejects an escaping material path %s", (path) => {
    expect(
      conversationQuestionPublicationSchema.safeParse({
        ...publication,
        materials: [{ ...publication.materials[0], path }],
      }).success,
    ).toBe(false);
  });

  it("rejects dependencies that escape the source and duplicate file declarations", () => {
    expect(
      conversationQuestionPublicationSchema.safeParse({
        ...publication,
        materials: [
          { ...publication.materials[0], dependencies: ["../private"] },
        ],
      }).success,
    ).toBe(false);
    expect(
      conversationQuestionPublicationSchema.safeParse({
        ...publication,
        materials: [publication.materials[0], publication.materials[0]],
      }).success,
    ).toBe(false);
  });

  it("keeps an explicit answer distinct from an approval decision", () => {
    const questions =
      conversationQuestionPublicationSchema.parse(publication).questions;
    expect(() =>
      normalizeConversationQuestionAnswers(questions, {
        voice: { selected: ["missing"] },
      }),
    ).toThrow("unavailable option");
    expect(() => normalizeConversationQuestionAnswers(questions, {})).toThrow(
      "Missing answer",
    );
    expect(() =>
      normalizeConversationQuestionAnswers(questions, {
        voice: { selected: ["a", "b"] },
      }),
    ).toThrow("only one");
    expect(() =>
      normalizeConversationQuestionAnswers(questions, {
        other: { selected: ["a"] },
      }),
    ).toThrow("unknown question");
    expect(
      normalizeConversationQuestionAnswers(questions, {
        voice: { selected: [], freeText: "Discuss the samples first" },
      }),
    ).toEqual({
      voice: { selected: [], freeText: "Discuss the samples first" },
    });
  });

  it("canonicalizes multi-select answers for duplicate submission identity", () => {
    const questions = conversationQuestionPublicationSchema.parse({
      ...publication,
      questions: [{ ...publication.questions[0], multiSelect: true }],
    }).questions;
    expect(
      normalizeConversationQuestionAnswers(questions, {
        voice: { selected: ["b", "a"] },
      }),
    ).toEqual(
      normalizeConversationQuestionAnswers(questions, {
        voice: { selected: ["a", "b"] },
      }),
    );
    expect(() =>
      normalizeConversationQuestionAnswers(questions, {
        voice: { selected: ["a", "a"] },
      }),
    ).toThrow("duplicate");
  });
});

it("normalizes realistic Claude aliases without losing explanations or previews", () => {
  const parsed = normalizeConversationQuestionPublication({
    body: "Compare these",
    questions: [
      {
        question: "Which?",
        header: "Choice",
        multiSelect: false,
        options: [
          { label: "First", description: "Detail", preview: "<preview>" },
          { label: "Second" },
        ],
      },
    ],
  });
  expect(parsed.questions[0]).toMatchObject({
    id: "question_1",
    prompt: "Which?",
    shortLabel: "Choice",
    allowFreeText: true,
    options: [
      { value: "option_1", label: "First", description: "Detail\n\n<preview>" },
      { value: "option_2", label: "Second" },
    ],
  });
  expect(() =>
    normalizeConversationQuestionPublication({
      kind: "approval",
      questions: [],
    }),
  ).toThrow();
  const marker = conversationQuestionMarker("qst_23456789ab");
  expect(parseConversationQuestionMarker(marker)).toBe("qst_23456789ab");
  expect(parseConversationQuestionMarker(`Some text ${marker}`)).toBeNull();
});
