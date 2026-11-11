export { useFrameTheme } from "@bb/shared-ui/use-frame-theme";
const unquoted = (family: string) => family.trim().replace(/^["']|["']$/g, "");

function fontFaceRules(rules: CSSRuleList, found: CSSFontFaceRule[]): void {
  for (const rule of rules) {
    if (rule instanceof CSSFontFaceRule) found.push(rule);
    else if (rule instanceof CSSGroupingRule) {
      fontFaceRules(rule.cssRules, found);
    }
  }
}

const rangeKey = (range: string) =>
  range
    .toUpperCase()
    .replace(/\s+/g, "")
    .replace(/(?<=[+-])0+(?=[0-9A-F?])/g, "");

async function dataUrl(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  let binary = "";
  for (let at = 0; at < bytes.length; at += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  }
  const type = response.headers.get("content-type") ?? "font/woff2";
  return `data:${type};base64,${window.btoa(binary)}`;
}

async function fontFaceCss(face: CSSFontFaceRule, family: string) {
  const base = face.parentStyleSheet?.href ?? document.baseURI;
  const url = /url\(\s*(["']?)([^"')]+)\1\s*\)/.exec(
    face.style.getPropertyValue("src"),
  )?.[2];
  if (url === undefined) return "";
  const declarations = ["font-style", "font-weight", "unicode-range"]
    .map((name) => [name, face.style.getPropertyValue(name)] as const)
    .filter(([, value]) => value.length > 0)
    .map(([name, value]) => `${name}:${value};`)
    .join("");
  const src = await dataUrl(new URL(url, base).href);
  return `@font-face{font-family:"${family}";font-display:swap;${declarations}src:url("${src}");}`;
}

async function loadFontCss(): Promise<string> {
  const stack = window
    .getComputedStyle(document.documentElement)
    .getPropertyValue("--font-sans");
  const family = unquoted(stack.split(",")[0] ?? "");
  if (family.length === 0) return "";
  await document.fonts.ready;
  const loaded = new Set<string>();
  for (const face of document.fonts) {
    if (face.status === "loaded" && unquoted(face.family) === family) {
      loaded.add(rangeKey(face.unicodeRange));
    }
  }
  const faces: CSSFontFaceRule[] = [];
  for (const sheet of document.styleSheets) {
    try {
      fontFaceRules(sheet.cssRules, faces);
    } catch {
      continue;
    }
  }
  const wanted = faces.filter(
    (face) =>
      unquoted(face.style.getPropertyValue("font-family")) === family &&
      loaded.has(rangeKey(face.style.getPropertyValue("unicode-range"))),
  );
  const css = await Promise.all(
    wanted.map((face) => fontFaceCss(face, family)),
  );
  return css.join("");
}

const FONT_WAIT_MS = 1_500;
let fontCss: Promise<string> | null = null;

export function appFontCss(): Promise<string> {
  fontCss ??= loadFontCss().then(
    (css) => {
      if (css.length === 0) fontCss = null;
      return css;
    },
    () => {
      fontCss = null;
      return "";
    },
  );
  const giveUp = new Promise<string>((resolve) => {
    window.setTimeout(() => resolve(""), FONT_WAIT_MS);
  });
  return Promise.race([fontCss, giveUp]);
}
