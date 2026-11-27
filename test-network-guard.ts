// Test-only: no test may leave the machine. Every global fetch and every TCP
// or TLS connect (which covers undici, node:http and node:https) to a host
// other than loopback is refused and fails the running test, even when the
// code under test swallows the error (the hub turns it into a 502).
import net from "node:net";
import { afterEach } from "vitest";

interface Guard {
  blocked: string[];
}

const GUARD = Symbol.for("bb-account-pool.test-network-guard");
const LOOPBACK = /^(localhost|127(?:\.\d{1,3}){3}|::1|::ffff:127(?:\.\d{1,3}){3})$/iu;

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK.test(host.replace(/^\[|\]$/gu, ""));
}

function refusal(target: string): Error {
  return new Error(`Test network guard refused a non-loopback connection to ${target}`);
}

// Where net.Socket#connect would go, or null for a unix socket path.
function connectTarget(args: unknown[]): { host: string; port: unknown } | null {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (typeof first === "object" && first !== null) {
    const options = first as { path?: unknown; host?: unknown; port?: unknown };
    if (typeof options.path === "string") return null;
    return {
      host: typeof options.host === "string" ? options.host : "localhost",
      port: options.port,
    };
  }
  if (typeof first === "string" && !/^\d+$/u.test(first)) return null;
  return { host: typeof args[1] === "string" ? args[1] : "localhost", port: first };
}

function install(): Guard {
  const guard: Guard = { blocked: [] };
  const fetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.protocol !== "data:" && url.protocol !== "blob:" && !isLoopbackHost(url.hostname)) {
      const target = `${url.protocol}//${url.host}`;
      guard.blocked.push(target);
      return Promise.reject(refusal(target));
    }
    return fetch(input, init);
  };
  const connect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function guardedConnect(
    this: net.Socket,
    ...args: unknown[]
  ) {
    const target = connectTarget(args);
    if (target !== null && !isLoopbackHost(target.host)) {
      const name = `${target.host}:${String(target.port)}`;
      guard.blocked.push(name);
      process.nextTick(() => this.destroy(refusal(name)));
      return this;
    }
    return Reflect.apply(connect, this, args) as net.Socket;
  } as typeof connect;
  return guard;
}

const store = globalThis as typeof globalThis & { [GUARD]?: Guard };
const guard = (store[GUARD] ??= install());

// For the guard's own test: returns and clears what was refused.
export function takeBlocked(): string[] {
  return guard.blocked.splice(0);
}

afterEach(() => {
  const blocked = takeBlocked();
  if (blocked.length > 0)
    throw new Error(
      `Test left the machine: ${[...new Set(blocked)].join(", ")}. Point every upstream at a local fake.`,
    );
});
