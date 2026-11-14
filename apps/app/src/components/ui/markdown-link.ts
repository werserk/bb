interface MarkdownPreviewLink {
  href: string;
  ordinaryActivation?: boolean;
}

export type MarkdownPreviewLinkHandler = (link: MarkdownPreviewLink) => boolean;
