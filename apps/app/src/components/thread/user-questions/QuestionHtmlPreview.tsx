import { useEffect, useMemo, useRef, useState } from "react";
import {
  frameDocument,
  frameHeight,
  frameThemeMessage,
  frameResult,
  readFrameContentHeight,
  readFrameLinkRequest,
} from "@bb/shared-ui/html-frame";
import { useFrameTheme } from "@bb/shared-ui/use-frame-theme";

export function QuestionHtmlPreview({
  content,
  url,
  title,
}: {
  content: string;
  url: string;
  title: string;
}) {
  const theme = useFrameTheme();
  const frame = useRef<HTMLIFrameElement>(null);
  const [initialTheme] = useState(theme);
  const [contentHeight, setContentHeight] = useState<number>();
  const srcDoc = useMemo(
    () =>
      frameDocument(content, {
        theme: initialTheme,
        baseHref: new URL(url, window.location.origin).href,
      }),
    [content, url, initialTheme],
  );
  useEffect(() => {
    frame.current?.contentWindow?.postMessage(frameThemeMessage(theme), "*");
  }, [theme]);
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (!frame.current || event.source !== frame.current.contentWindow)
        return;
      const height = readFrameContentHeight(event.data);
      if (height !== undefined) {
        setContentHeight(height);
        return;
      }
      const link = readFrameLinkRequest(event.data);
      if (
        link &&
        document.activeElement === frame.current &&
        navigator.userActivation?.isActive !== false
      ) {
        window.open(link.url, "_blank", "noopener,noreferrer");
        frame.current.contentWindow?.postMessage(frameResult(link.id), "*");
      }
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, []);
  return (
    <div
      className="overflow-auto rounded-md border"
      style={{ resize: "vertical", minHeight: 224 }}
    >
      <iframe
        ref={frame}
        title={title}
        sandbox="allow-scripts"
        srcDoc={srcDoc}
        onLoad={() =>
          frame.current?.contentWindow?.postMessage(
            frameThemeMessage(theme),
            "*",
          )
        }
        className="block w-full border-0"
        style={{
          height: frameHeight({
            requested: null,
            contentHeight,
            remembered: undefined,
          }),
          colorScheme: theme.appearance,
        }}
      />
    </div>
  );
}
