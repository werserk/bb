// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
const mocks=vi.hoisted(()=>({open:vi.fn(),toast:vi.fn()}));
vi.mock("@/lib/app-navigation-host",()=>({useAppNavigationHost:()=>({openUrl:mocks.open,openFilePreview:vi.fn()})}));
vi.mock("@/components/thread/timeline/ThreadTimelineNavigationContext",()=>({useThreadTimelineNavigation:()=>null}));
vi.mock("@/components/ui/app-toast",()=>({appToast:{error:mocks.toast}}));
vi.mock("@/components/ui/markdown-preview",()=>({MarkdownPreview:({linkRouting}:{linkRouting:{onOpenLink:(link:{href:string})=>boolean}})=><button onClick={()=>linkRouting.onOpenLink({href:"report.md"})}>Local evidence</button>}));
import { PluginMarkdown } from "./PluginMarkdown";
afterEach(()=>{cleanup();vi.clearAllMocks();});
it("refuses context-free local evidence without SPA routing",()=>{
  render(<PluginMarkdown content="[report](report.md)"/>);
  fireEvent.click(screen.getByText("Local evidence"));
  expect(mocks.open).not.toHaveBeenCalled();
  expect(mocks.toast).toHaveBeenCalledWith("Can't open this file here",expect.objectContaining({action:expect.objectContaining({label:"Copy path"})}));
});
