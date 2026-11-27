import http from "node:http";
import net from "node:net";
import { request } from "undici";
import { describe, expect, it } from "vitest";
import { isLoopbackHost, takeBlocked } from "../test-network-guard.js";

describe("test network guard", () => {
  it("refuses fetch, undici and raw sockets to non-loopback hosts", async () => {
    await expect(fetch("https://example.invalid/v1")).rejects.toThrow(
      "refused a non-loopback connection to https://example.invalid",
    );
    await expect(request("https://example.invalid/v1")).rejects.toThrow(
      "refused a non-loopback connection to example.invalid:443",
    );
    const socket = net.connect({ host: "192.0.2.1", port: 80 });
    await expect(
      new Promise((_resolve, reject) => socket.once("error", reject)),
    ).rejects.toThrow("192.0.2.1:80");
    expect(takeBlocked()).toEqual([
      "https://example.invalid",
      "example.invalid:443",
      "192.0.2.1:80",
    ]);
  });

  it("lets loopback through", async () => {
    const server = http.createServer((_request, response) => response.end("ok"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no port");
    try {
      expect(await (await fetch(`http://127.0.0.1:${address.port}/`)).text()).toBe("ok");
      expect(await (await request(`http://localhost:${address.port}/`)).body.text()).toBe("ok");
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    expect(takeBlocked()).toEqual([]);
    for (const host of ["127.0.0.1", "localhost", "::1", "[::1]", "::ffff:127.0.0.1"])
      expect(isLoopbackHost(host)).toBe(true);
    for (const host of ["api.openai.com", "10.0.0.1", "localhost.evil.example", "128.0.0.1"])
      expect(isLoopbackHost(host)).toBe(false);
  });
});
