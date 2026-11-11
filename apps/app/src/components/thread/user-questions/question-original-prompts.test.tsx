// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { QuestionOriginalPrompts } from "./question-response-presentation";

afterEach(cleanup);
it("keeps original option descriptions readable without presenting a second answer form", () => {
  const view = render(
    <QuestionOriginalPrompts
      publication={{
        body: "",
        materials: [],
        questions: [
          {
            id: "direction",
            prompt: "Which direction?",
            required: true,
            multiSelect: false,
            allowFreeText: true,
            options: [
              {
                value: "a",
                label: "Direction A",
                description: "Keep the source anchored in the conversation",
              },
            ],
          },
        ],
      }}
    />,
  );
  expect(screen.getByText("Which direction?")).toBeTruthy();
  expect(screen.getByText("Direction A")).toBeTruthy();
  expect(
    screen.getByText("Keep the source anchored in the conversation"),
  ).toBeTruthy();
  expect(view.container.querySelector("input, textarea, button")).toBeNull();
});
