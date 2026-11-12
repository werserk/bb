import { describe, expect, it } from "vitest";
import {
  normalizeConversationQuestionPublication,
  conversationQuestionPublicationSchema,
} from "../src/conversation-questions.js";

const card = () => ({
  body: "",
  questions: [
    {
      id: "q",
      prompt: "?",
      shortLabel: "H",
      multiSelect: false,
      allowFreeText: true,
      options: [{ value: "a", label: "A", description: "D" }],
    },
  ],
  materials: [{ path: "report.md", label: "Report" }],
});

describe("new question publication size", () => {
  const fields = [
    [
      "body",
      400,
      (c: ReturnType<typeof card>, s: string) => {
        c.body = s;
      },
    ],
    [
      "prompt",
      200,
      (c: ReturnType<typeof card>, s: string) => {
        c.questions[0]!.prompt = s;
      },
    ],
    [
      "shortLabel",
      48,
      (c: ReturnType<typeof card>, s: string) => {
        c.questions[0]!.shortLabel = s;
      },
    ],
    [
      "label",
      80,
      (c: ReturnType<typeof card>, s: string) => {
        c.questions[0]!.options[0]!.label = s;
      },
    ],
    [
      "description",
      120,
      (c: ReturnType<typeof card>, s: string) => {
        c.questions[0]!.options[0]!.description = s;
      },
    ],
    [
      "material",
      80,
      (c: ReturnType<typeof card>, s: string) => {
        c.materials[0]!.label = s;
      },
    ],
    [
      "id",
      128,
      (c: ReturnType<typeof card>, s: string) => {
        c.questions[0]!.id = s;
      },
    ],
    [
      "value",
      128,
      (c: ReturnType<typeof card>, s: string) => {
        c.questions[0]!.options[0]!.value = s;
      },
    ],
  ] as const;
  it.each(fields)("bounds %s at %i code points", (_field, limit, set) => {
    const c = card();
    set(c, "я".repeat(limit));
    expect(() => normalizeConversationQuestionPublication(c)).not.toThrow();
    set(c, "я".repeat(limit + 1));
    expect(() => normalizeConversationQuestionPublication(c)).toThrow(
      `${limit + 1}/${limit}`,
    );
    expect(() => normalizeConversationQuestionPublication(c)).toThrow(
      "materials",
    );
  });
  it("counts astral emoji as one and joined emoji by code point", () => {
    const c = card();
    c.body = "😀".repeat(400);
    expect(() => normalizeConversationQuestionPublication(c)).not.toThrow();
    c.body += "я";
    expect(() => normalizeConversationQuestionPublication(c)).toThrow(
      "401/400",
    );
    c.body = "👨‍👩‍👧‍👦".repeat(57) + "я";
    expect(() => normalizeConversationQuestionPublication(c)).not.toThrow();
    c.body += "я";
    expect(() => normalizeConversationQuestionPublication(c)).toThrow(
      "401/400",
    );
  });
  it("bounds combined small fields across questions and material labels", () => {
    const c = card();
    c.questions[0]!.shortLabel = "H";
    c.body = "b".repeat(400);
    c.questions[0]!.prompt = "p".repeat(200);
    c.questions[0]!.options[0]!.description = "d".repeat(120);
    c.questions.push({
      ...c.questions[0]!,
      id: "q2",
      prompt: "p".repeat(200),
      shortLabel: "h",
      options: [],
    });
    c.materials = [
      { path: "report.md", label: "m".repeat(40) },
      { path: "other.md", label: "m".repeat(37) },
    ];
    expect(() => normalizeConversationQuestionPublication(c)).not.toThrow();
    c.materials[1]!.label += "m";
    expect(() => normalizeConversationQuestionPublication(c)).toThrow(
      "1001/1000",
    );
  });
  it("normalizes legacy preview with description before checking the shared limit", () => {
    const c = {
      questions: [
        {
          question: "Proceed?",
          header: "Choice",
          options: [{ label: "A", description: "d".repeat(118), preview: "p" }],
        },
      ],
    };
    expect(() => normalizeConversationQuestionPublication(c)).toThrow(
      "121/120",
    );
    c.questions[0]!.options[0]!.description = "d".repeat(117);
    expect(() => normalizeConversationQuestionPublication(c)).not.toThrow();
  });
  it("reports one useful violation even beyond the old cap, without echoing input", () => {
    const c = card();
    c.body = "x".repeat(65537);
    c.questions[0]!.prompt = "p".repeat(201);
    expect(() => normalizeConversationQuestionPublication(c)).toThrow(
      "Question card body: 65537/400 code points. Shorten the question and put the full report in materials.",
    );
  });
  it("keeps stored decoding permissive", () => {
    const c = card();
    c.body = "b".repeat(10000);
    expect(() => conversationQuestionPublicationSchema.parse(c)).not.toThrow();
  });
});

it.each(["header", "label", "preview"])(
  "cannot move oversized legacy text to %s",
  (field) => {
    const option = {
      label: field === "label" ? "я".repeat(81) : "A",
      preview: field === "preview" ? "я".repeat(121) : "",
    };
    expect(() =>
      normalizeConversationQuestionPublication({
        questions: [
          {
            question: "Proceed?",
            header: field === "header" ? "я".repeat(49) : "Choice",
            options: [option],
          },
        ],
      }),
    ).toThrow("materials");
  },
);

it.each(["questions", "options", "materials", "dependencies"])(
  "bounds %s before structural parsing",
  (collection) => {
    const c = card();
    if (collection === "questions")
      c.questions = Array.from({ length: 11 }, (_, i) => ({
        ...c.questions[0]!,
        id: `q${i}`,
      }));
    if (collection === "options")
      c.questions[0]!.options = Array.from({ length: 5 }, (_, i) => ({
        ...c.questions[0]!.options[0]!,
        value: `v${i}`,
      }));
    if (collection === "materials")
      c.materials = Array.from({ length: 21 }, (_, i) => ({
        path: `m${i}.md`,
        label: "M",
      }));
    const input =
      collection === "dependencies"
        ? {
            ...c,
            materials: [
              {
                path: "report.md",
                label: "R",
                dependencies: Array.from(
                  { length: 101 },
                  (_, i) => `a${i}.txt`,
                ),
              },
            ],
          }
        : c;
    expect(() => normalizeConversationQuestionPublication(input)).toThrow(
      "items. Shorten the question and put the full report in materials.",
    );
  },
);

it("rejects the observed 878-character release body but keeps its stored record readable", () => {
  const c = card();
  c.body = "я".repeat(878);
  expect(() => normalizeConversationQuestionPublication(c)).toThrow("878/400");
  expect(() => conversationQuestionPublicationSchema.parse(c)).not.toThrow();
});
