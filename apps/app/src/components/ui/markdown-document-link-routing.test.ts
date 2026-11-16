// @vitest-environment jsdom
import { cleanup, renderHook } from "@testing-library/react";
import { expect, it, vi, afterEach } from "vitest";
import { useLocalFileLinkOpener } from "@/hooks/useLocalFileLinkOpener";
const modal = vi.hoisted(() => vi.fn());
vi.mock("@/lib/modal-host", () => ({ openCoreModal: modal }));
vi.mock("@/hooks/useLiveFileOpenTargets", () => ({
  useLiveFileOpenTargets: () => ({
    fileOpenTargets: [],
    openPathInFileTarget: vi.fn(),
  }),
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
it.each([
  ["next.md", true, undefined, null, true],
  ["next.md", false, undefined, null, false],
  ["next.md", undefined, undefined, null, false],
  ["app.ts", true, undefined, null, false],
  ["next.md", true, "abc1234", null, false],
  ["next.md", true, undefined, { startLineNumber: 3, endLineNumber: 4 }, false],
] as const)(
  "routes contextual %s activation %s ref %s location %s",
  (path, ordinaryActivation, ref, lineRange, popup) => {
    const panel = vi.fn(() => true);
    const { result } = renderHook(() =>
      useLocalFileLinkOpener({
        canOpenInEditor: false,
        hostId: "host_test",
        openFilePreview: panel,
        threadStorage: null,
        workspace: {
          environmentId: "env_document",
          rootPath: "/document",
          ...(ref ? { experimental_ref: ref } : {}),
        },
      }),
    );
    expect(
      result.current.openLink({
        path: `/document/nested/${path}`,
        lineRange,
        openTargetId: null,
        ordinaryActivation,
      }),
    ).toBe(true);
    if (popup) {
      expect(modal).toHaveBeenCalledOnce();
      expect(modal.mock.calls[0]![1].params).toMatchObject({
        kind: "workspace",
        environmentId: "env_document",
        relativePath: `nested/${path}`,
      });
      expect(modal.mock.calls[0]![1].params).not.toHaveProperty(
        "experimental_artifact",
      );
      expect(panel).not.toHaveBeenCalled();
    } else {
      expect(modal).not.toHaveBeenCalled();
      expect(panel).toHaveBeenCalledOnce();
    }
  },
);
