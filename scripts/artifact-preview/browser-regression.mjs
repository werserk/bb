import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { build } from "esbuild";
import { artifactPreviewCsp } from "../../packages/domain/src/artifact-preview.ts";

const [playwrightPackage, output] = process.argv.slice(2);
assert(
  playwrightPackage && output,
  "Provide an existing Playwright package.json and durable output directory; no browser installation",
);
const require = createRequire(resolve(playwrightPackage));
const { chromium } = require("playwright");
const root = fileURLToPath(new URL("../../", import.meta.url));
const component = resolve(
  root,
  "apps/app/src/components/plugin/local-file-viewer/ScopedHtmlFrame.tsx",
);
const decoder = resolve(
  root,
  "apps/app/src/components/plugin/local-file-viewer/artifact-html.ts",
);
const result = await build({
  absWorkingDir: resolve(root, "apps/app"),
  stdin: {
    contents: `import React from 'react';import{createRoot}from'react-dom/client';import{ScopedHtmlFrame}from${JSON.stringify(component)};import{decodeArtifactHtml}from${JSON.stringify(decoder)};(async()=>{try{const url=new URL('/api/v1/file-previews/browser-fixture/doc.html'+location.search,location.origin);const response=await fetch(url,{redirect:'error'});if(!response.ok)throw Error('HTTP '+response.status);const text=decodeArtifactHtml(new Uint8Array(await response.arrayBuffer()),response.headers.get('content-type'));url.search='';createRoot(document.getElementById('app')).render(<ScopedHtmlFrame content={text} url={url.href} baseUrl={location.origin+'/api/v1/file-previews/browser-fixture'} title="Actual scoped HTML"/>);}catch(error){document.getElementById('app').textContent=String(error);}})();`,
    loader: "tsx",
    resolveDir: resolve(root, "apps/app"),
  },
  bundle: true,
  write: false,
  format: "iife",
  conditions: ["source"],
  jsx: "automatic",
  define: { "process.env.NODE_ENV": '"production"' },
});
const bundle = result.outputFiles[0].text;
const prefix = "/api/v1/file-previews/browser-fixture/";
const requests = [];
let origin;
const escape = (value) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;");
const attacks = {
  "location-assign": `location.assign('/native/secret.html')`,
  "location-replace": `location.replace('/native/secret.html')`,
  "same-lease-sibling": `location.assign('other.html')`,
  "same-candidate": `location.replace('doc.html?other=1')`,
  "meta-refresh": `document.head.insertAdjacentHTML('beforeend','<meta http-equiv="refresh" content="0;url=/native/secret.html">')`,
  "sibling-meta": `document.head.insertAdjacentHTML('beforeend','<meta http-equiv="refresh" content="0;url=other.html">')`,
  "parent-navigation": `parent.location='/native/secret.html'`,
  "top-navigation": `top.location='/native/secret.html'`,
  "window-open": `window.open('/native/secret.html','_blank')`,
  form: `var f=document.createElement('form');f.action='/native/secret.html';document.body.append(f);f.submit()`,
  "data-navigation": `location='data:text/html,escaped'`,
  "blob-navigation": `location=URL.createObjectURL(new Blob(['<script>location="/native/secret.html"<\/script>'],{type:'text/html'}))`,
  "about-blank": `location='about:blank';setTimeout(()=>location='/native/secret.html',10)`,
  "child-srcdoc": `var f=document.createElement('iframe');f.srcdoc='<script>location="${prefix}other.html"<\/script>';document.body.append(f)`,
  "grandchild-srcdoc": `var f=document.createElement('iframe');f.srcdoc='<iframe src="/native/secret.html"></iframe>';document.body.append(f)`,
  "document-write": `document.open();document.write('<h1>Changed</h1><script>location="${prefix}other.html"<\/script>');document.close()`,
  prefetch: `var l=document.createElement('link');l.rel='prefetch';l.href='/native/secret.html';document.head.append(l)`,
  preload: `var l=document.createElement('link');l.rel='preload';l.as='script';l.href='/native/escape.js';document.head.append(l)`,
  modulepreload: `var l=document.createElement('link');l.rel='modulepreload';l.href='/native/escape.js';document.head.append(l)`,
  fetch: `fetch('/native/secret.html').catch(()=>{})`,
  "css-url-import": `var s=document.createElement('style');s.textContent='@import url(/native/escape.css);body{background:url(/native/escape.png)}';document.head.append(s)`,
  "base-csp-parent": `document.head.insertAdjacentHTML('afterbegin','<base href="/native/"><meta http-equiv="Content-Security-Policy" content="default-src *">');try{parent.document.body.innerHTML='escape'}catch(e){};location='secret.html'`,
  speculation: `var s=document.createElement('script');s.type='speculationrules';s.textContent=JSON.stringify({prefetch:[{source:'list',urls:['/native/secret.html']}]});document.head.append(s)`,
};
const sentinel = "Привет café — 世界 & «ok»";
const parityHtml = (value) =>
  `<title>${value}</title><p id="sentinel">${value}</p><p id="script-output"></p><script>document.getElementById('script-output').textContent=document.getElementById('sentinel').textContent;</script>`;
const utf8 = Buffer.from(parityHtml(sentinel.replaceAll("&", "&amp;")));
const utf16 = Buffer.from(
  parityHtml(sentinel.replaceAll("&", "&amp;")),
  "utf16le",
);
const legacy = Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]);
const encodings = {
  "encoding-utf8": utf8,
  "encoding-utf8-bom": Buffer.concat([Buffer.from([239, 187, 191]), utf8]),
  "encoding-utf16le": Buffer.concat([Buffer.from([255, 254]), utf16]),
  "encoding-utf16be": Buffer.concat([
    Buffer.from([254, 255]),
    Buffer.from(utf16).swap16(),
  ]),
  "encoding-cp1251": Buffer.concat([
    Buffer.from('<meta charset="windows-1251"><title>'),
    legacy,
    Buffer.from('</title><p id="sentinel">'),
    legacy,
    Buffer.from(
      '</p><p id="script-output"></p><script>document.getElementById("script-output").textContent=document.getElementById("sentinel").textContent;</script>',
    ),
  ]),
};
const server = createServer((req, res) => {
  const url = new URL(req.url, origin);
  requests.push({
    path: url.pathname,
    query: url.search,
    destination: req.headers["sec-fetch-dest"] ?? null,
  });
  res.setHeader("cache-control", "no-store");
  if (url.pathname === "/harness") {
    res.setHeader("content-type", "text/html; charset=utf-8");
    return res.end(
      (encodings[url.searchParams.get("case")]
        ? '<iframe id="baseline" sandbox="allow-scripts" src="/native/baseline?case=' +
          url.searchParams.get("case") +
          '"></iframe>'
        : "") +
        '<div id="app" style="height:600px"></div><script src="/bundle.js"></script>',
    );
  }
  if (url.pathname === "/bundle.js") {
    res.setHeader("content-type", "application/javascript");
    return res.end(bundle);
  }
  if (url.pathname === prefix + "doc.html") {
    const name = url.searchParams.get("case");
    if (name === "controlled-redirect") {
      res.writeHead(302, { location: "/native/secret.html" });
      return res.end();
    }
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.setHeader(
      "content-security-policy",
      `sandbox allow-scripts; ${artifactPreviewCsp(origin + prefix)}`,
    );
    if (encodings[name]) return res.end(encodings[name]);
    const staticMeta =
      name === "static-meta"
        ? '<meta http-equiv="refresh" content="0;url=/native/secret.html">'
        : "";
    const script = name === "asset-redirect" ? "redirect.js" : "script.js";
    return res.end(
      `<!doctype html>${staticMeta}<link rel="stylesheet" href="style.css"><h1 id="legitimate">Legitimate HTML</h1><script>document.body.dataset.inlineScript='yes'</script><script src="${script}"></script><img id="image" src="image.svg"><img id="data" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='1' height='1'/%3E"><button id="run" onclick="${escape(attacks[name] ?? "")}">Run</button><a id="sibling" href="other.html" ping="/native/ping">Sibling</a>${["_self", "_top", "_parent", "_blank"].map((target) => `<a id="link${target}" target="${target}" href="/native/secret.html">${target}</a>`).join("")}<a id="download" download href="/native/secret.html">Download</a><a id="fragment" href="#destination">Jump</a><div style="height:1400px"></div><h2 id="destination">Destination</h2><p>&quot;&lt;/iframe&gt;&lt;script&gt;parent.escape=true&lt;/script&gt;</p>`,
    );
  }
  if (url.pathname === "/native/baseline") {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.setHeader("content-security-policy", "sandbox allow-scripts");
    return res.end(encodings[url.searchParams.get("case")]);
  }
  if (url.pathname === prefix + "redirect.js") {
    res.writeHead(302, { location: "/native/escape.js" });
    return res.end();
  }
  if (
    url.pathname.endsWith("script.js") ||
    url.pathname === "/native/escape.js"
  ) {
    res.setHeader("content-type", "application/javascript");
    return res.end('document.body.dataset.externalScript="yes"');
  }
  if (url.pathname === prefix + "style.css") {
    res.setHeader("content-type", "text/css");
    return res.end("#legitimate{color:rgb(1, 2, 3)}");
  }
  if (url.pathname === prefix + "image.svg") {
    res.setHeader("content-type", "image/svg+xml");
    return res.end(
      '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"/>',
    );
  }
  res.setHeader("content-type", "text/html");
  res.end('<h1 id="escaped">Out of candidate</h1>');
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
assert(![38900, 38901, 38910, 38911].includes(port));
origin = `http://127.0.0.1:${port}`;
await mkdir(output, { recursive: true });
const receipt = {
  kind: "actual-ScopedHtmlFrame/shared-CSP-browser-regression",
  bbRuntime: false,
  browser: null,
  playwright: require("playwright/package.json").version,
  cases: [],
  unsupported: [],
  missing: [
    "Installed runtime/front-proxy acceptance",
    "Live Windows host",
    "Firefox executable and WebKit host dependencies (not installed)",
  ],
};
const browser = await chromium.launch({ headless: true });
receipt.browser = browser.version();
const save = () =>
  writeFile(
    resolve(output, "receipt.json"),
    JSON.stringify(receipt, null, 2) + "\n",
  );
try {
  const cases = [
    "positive",
    "fragment",
    "sibling",
    "download",
    ...["_self", "_top", "_parent", "_blank"].map((t) => "link" + t),
    ...Object.keys(attacks),
    "static-meta",
    "controlled-redirect",
    "asset-redirect",
    ...Object.keys(encodings),
  ];
  for (const name of cases) {
    const page = await browser.newPage();
    const start = requests.length;
    const errors = [];
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    await page.goto(origin + "/harness?case=" + name);
    if (encodings[name]) {
      const inner = page
        .frameLocator('iframe[title="Actual scoped HTML"]')
        .frameLocator("iframe");
      const native = page.frameLocator("#baseline");
      await inner.locator("#script-output").waitFor();
      await native.locator("#script-output").waitFor();
      const snapshot = (el) => ({
        title: document.title,
        text: document.getElementById("sentinel").textContent,
        body: document.body.textContent,
        script: el.textContent,
        charset: document.characterSet,
      });
      const a = await native.locator("#script-output").evaluate(snapshot),
        b = await inner.locator("#script-output").evaluate(snapshot);
      const { charset: ac, ...av } = a,
        { charset: bc, ...bv } = b;
      assert.deepEqual(av, bv);
      receipt.cases.push({
        name,
        parity: true,
        native: a,
        scoped: b,
        requests: requests.slice(start),
      });
      await save();
      await page.close();
      continue;
    }
    if (name === "controlled-redirect") {
      await page.getByText(/TypeError/).waitFor();
      assert.equal(
        requests.slice(start).filter((r) => r.path.startsWith("/native/"))
          .length,
        0,
      );
      receipt.cases.push({
        name,
        controlledRedirectRejected: true,
        requests: requests.slice(start),
      });
      await page.close();
      continue;
    }
    const locator = page
      .frameLocator('iframe[title="Actual scoped HTML"]')
      .frameLocator("iframe");
    if (name !== "static-meta") {
      await locator.locator("#legitimate").waitFor();
      const frame = page
        .frames()
        .find((frame) => frame.parentFrame()?.parentFrame());
      assert(frame);
      if (name === "positive" || name === "fragment") {
        await locator.locator('body[data-external-script="yes"]').waitFor();
        const positive = await locator
          .locator("#legitimate")
          .evaluate((el) => ({
            inline: document.body.dataset.inlineScript,
            external: document.body.dataset.externalScript,
            color: getComputedStyle(el).color,
            image: document.getElementById("image").naturalWidth,
            data: document.getElementById("data").naturalWidth,
          }));
        assert.deepEqual(positive, {
          inline: "yes",
          external: "yes",
          color: "rgb(1, 2, 3)",
          image: 2,
          data: 1,
        });
      }
      if (name === "fragment") {
        const before = requests.length;
        await locator.locator("#fragment").click();
        assert.equal(await frame.evaluate(() => location.hash), "#destination");
        assert(
          (await locator
            .locator("#destination")
            .evaluate((el) => el.getBoundingClientRect().top)) < 600,
        );
        assert.equal(
          await locator.locator("#legitimate").textContent(),
          "Legitimate HTML",
        );
        assert.equal(requests.length, before);
      } else if (
        name === "sibling" ||
        name === "download" ||
        name.startsWith("link")
      )
        await locator.locator("#" + name).click();
      else if (name in attacks) await locator.locator("#run").click();
    }
    await page.waitForTimeout(250);
    const hits = requests.slice(start);
    const escapeRequests = hits.filter(
      (r) =>
        r.path.startsWith("/native/") ||
        (r.path.startsWith(prefix) && r.destination === "iframe"),
    );
    if (name === "asset-redirect") {
      assert(
        hits.some((r) => r.path === "/native/escape.js"),
        "Synthetic backend redirect exposes CSP path matching limit",
      );
      receipt.unsupported.push({
        name,
        reason:
          "CSP does not enforce resource path after an injected 3xx; supported strict routes must emit no3xx; proxy boundary remains acceptance gate",
        requests: escapeRequests,
      });
    } else
      assert.equal(
        escapeRequests.length,
        0,
        name + " made no unscoped or new document request",
      );
    assert.equal(
      await page
        .getByText("Links to other documents are blocked in this preview.")
        .count(),
      1,
    );
    assert.equal(await page.evaluate(() => window.escape), undefined);
    receipt.cases.push({
      name,
      escapeRequests,
      requests: hits,
      errors,
      frames: page.frames().map((f) => f.url()),
    });
    await save();
    await page.close();
  }
  console.log(
    JSON.stringify({
      browser: receipt.browser,
      cases: receipt.cases.length,
      unsupported: receipt.unsupported.length,
      bbRuntime: false,
    }),
  );
} catch (error) {
  receipt.failure = String(error);
  throw error;
} finally {
  await save();
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
