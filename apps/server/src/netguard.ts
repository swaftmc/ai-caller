import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

// Addresses a user-supplied provider URL must never reach: this machine, private networks, cloud metadata.
const blocked = new BlockList();
for (const [net, bits] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  blocked.addSubnet(net, bits, "ipv4");
for (const [net, bits] of [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b::", 96],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const)
  blocked.addSubnet(net, bits, "ipv6");

let allowPrivate = false;
/** For local development and tests only (AICALLER_UNSAFE_ALLOW_PRIVATE_URLS=1). */
export const setAllowPrivateUrls = (on: boolean) => {
  allowPrivate = on;
};

export function isPrivateAddress(ip: string): boolean {
  const mapped = ip.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateAddress(mapped[1]);
  const family = isIP(ip);
  if (!family) return true;
  return blocked.check(ip, family === 4 ? "ipv4" : "ipv6");
}

/** Throws unless the URL is https and every address its host resolves to is public. */
export async function assertPublicUrl(raw: string | URL, resolve: (host: string) => Promise<string[]> = defaultResolve): Promise<void> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Not a valid URL");
  }
  if (allowPrivate) return;
  if (url.protocol !== "https:") throw new Error("Only https:// URLs are allowed");
  if (url.username || url.password) throw new Error("URLs with a user name or password are not allowed");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [host] : await resolve(host).catch(() => [] as string[]);
  if (!addresses.length) throw new Error(`Cannot resolve ${host}`);
  if (addresses.some(isPrivateAddress)) throw new Error(`${host} points to a private or local address, which is not allowed`);
}

const defaultResolve = async (host: string) => (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);

/**
 * fetch for every user-configured provider: checks the URL first and refuses redirects.
 * ponytail: DNS is resolved twice (check, then fetch), so a rebinding DNS server could still slip a private address in
 * between; pinning the checked IP needs a custom undici dispatcher.
 */
export const guardedFetch: typeof fetch = async (input, init) => {
  const url = typeof input === "string" || input instanceof URL ? input : input.url;
  await assertPublicUrl(url);
  return fetch(input, { ...init, redirect: "error" });
};
