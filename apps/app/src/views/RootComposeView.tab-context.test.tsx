// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { createStore, Provider } from "jotai";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { RootComposeView } from "./RootComposeView";

vi.mock("@/views/thread-detail/PaneContext", () => ({
  usePaneContext: () => ({ navigateInPane: vi.fn() }),
}));
vi.mock("@/hooks/mutations/thread-runtime-mutations", () => ({
  useCreateThread: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock("@/components/promptbox/NewThreadComposer", () => ({
  NewThreadComposer: ({ projectId }: { projectId: string }) => (
    <output data-testid="project">{projectId}</output>
  ),
}));

function LocationProbe() {
  const location = useLocation();
  return (
    <output data-testid="location">
      {JSON.stringify({ search: location.search, state: location.state })}
    </output>
  );
}

afterEach(cleanup);

it("restores new-tab project/environment context into the existing composer target and removes only context query parameters", async () => {
  render(
    <Provider store={createStore()}>
      <MemoryRouter
        initialEntries={[
          "/?projectId=proj_one&reuseEnvironmentId=env_one&initialPrompt=hello",
        ]}
      >
        <RootComposeView />
        <LocationProbe />
      </MemoryRouter>
    </Provider>,
  );
  await waitFor(() =>
    expect(
      JSON.parse(screen.getByTestId("location").textContent ?? "{}"),
    ).toEqual({
      search: "?initialPrompt=hello",
      state: { focusPrompt: true, reuseEnvironmentId: "env_one" },
    }),
  );
  expect(screen.getByTestId("project").textContent).toBe("proj_one");
});
