import { expect, it, vi, afterEach } from "vitest";
const modal=vi.hoisted(()=>vi.fn());
vi.mock("@/lib/modal-host",()=>({openCoreModal:modal}));
import { buildMarkdownDocumentLinkRouting } from "./markdown-document-link-routing";
afterEach(()=>vi.clearAllMocks());
it("opens contextual native artifacts without adding caller scope and preserves locations",()=>{
  const panel=vi.fn(()=>true);
  const routing=buildMarkdownDocumentLinkRouting({document:{target:{kind:"thread-storage",threadId:"thr_abcd234567",path:"nested/report.md"},threadId:"thr_abcd234567",rootPath:"/storage"},messageRouting:{},openFilePreview:panel});
  expect(routing.localFile?.onOpenLink({path:"/storage/nested/next.md",lineRange:null,openTargetId:null})).toBe(true);
  expect(modal.mock.calls[0]![1].params).toMatchObject({kind:"thread-storage",threadId:"thr_abcd234567",relativePath:"nested/next.md"});
  expect(modal.mock.calls[0]![1].params).not.toHaveProperty("experimental_artifact");
  expect(panel).not.toHaveBeenCalled();
  routing.localFile?.onOpenLink({path:"/storage/nested/next.md",lineRange:{startLineNumber:3,endLineNumber:4},openTargetId:null});
  expect(panel).toHaveBeenCalledWith(expect.objectContaining({location:{kind:"range",startLine:3,endLine:4}}));
});
it("does not invent document context",()=>{
  const panel=vi.fn();
  expect(buildMarkdownDocumentLinkRouting({document:{},messageRouting:{},openFilePreview:panel})).toEqual({});
  expect(panel).not.toHaveBeenCalled();expect(modal).not.toHaveBeenCalled();
});
