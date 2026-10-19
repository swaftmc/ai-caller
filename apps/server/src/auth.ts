import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { LoginRequestSchema, LoginVerifySchema, type AdminUser, type Me } from "@ai-caller/shared";
import type { Store } from "./db.js";
import type { Mailer } from "./mail.js";

declare module "fastify" {
  interface FastifyRequest {
    user: AdminUser | null;
  }
}

export const SESSION_COOKIE = "aic_session";
export const SESSION_TTL_MS = 30 * 24 * 3600_000;
export const LINK_TTL_MS = 15 * 60_000;

/** Sliding-window counter per key. ponytail: in memory, so it resets on restart and only works for one process. */
export class RateLimiter {
  private hits = new Map<string, number[]>();
  /** Records a hit and returns false if the key already had `max` hits in the window. */
  allow(key: string, max: number, windowMs: number, now = Date.now()): boolean {
    const recent = (this.hits.get(key) ?? []).filter((t) => t > now - windowMs);
    if (recent.length >= max) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    if (this.hits.size > 50_000) for (const [k, v] of this.hits) if (!v.some((t) => t > now - 3600_000)) this.hits.delete(k);
    return true;
  }
}

export function readCookie(header: string | undefined, name: string): string | null {
  for (const part of (header ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

export const toMe = (u: AdminUser): Me => ({ id: u.id, email: u.email, name: u.name, isAdmin: u.isAdmin });

export function userFromRequest(req: FastifyRequest, store: Store): AdminUser | null {
  const token = readCookie(req.headers.cookie, SESSION_COOKIE);
  return token ? store.sessionUser(token) : null;
}

export interface AuthOptions {
  store: Store;
  publicUrl: string;
  adminEmail: string;
  mailer: Mailer;
  limiter: RateLimiter;
}

/** /api/auth/*: request a sign-in link, verify it (sets the session cookie), sign out. */
export async function registerAuth(app: FastifyInstance, o: AuthOptions) {
  const secure = new URL(o.publicUrl).protocol === "https:";
  const cookie = (value: string, maxAge: number) =>
    `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
  const allowed = (email: string) => email === o.adminEmail || o.store.hasInvite(email);
  const bad = (reply: FastifyReply, err: z.ZodError | string) =>
    reply.code(400).send({ error: typeof err === "string" ? err : z.prettifyError(err) });

  await app.register(
    async (auth) => {
      auth.post("/request", async (req, reply) => {
        const body = LoginRequestSchema.safeParse(req.body);
        if (!body.success) return bad(reply, body.error);
        const email = body.data.email;
        if (!o.limiter.allow(`login-ip:${req.ip}`, 20, 3600_000) || !o.limiter.allow(`login-email:${email}`, 5, 3600_000)) {
          return reply.code(429).send({ error: "Too many sign-in requests. Try again in an hour." });
        }
        // Same answer whether or not the address is invited, so the page does not reveal who has access.
        if (allowed(email)) {
          const token = o.store.createLoginToken(email, LINK_TTL_MS);
          const link = `${o.publicUrl}/login/verify/#t=${token}`;
          const text = `Open this link to sign in to AI Caller. It works once and expires in 15 minutes.\n\n${link}\n\nIf you did not ask for it, ignore this email.`;
          await o.mailer(email, "Your AI Caller sign-in link", text).catch((err: Error) => req.log.error(`sign-in email failed: ${err.message}`));
        }
        return { ok: true };
      });

      auth.post("/verify", async (req, reply) => {
        if (!o.limiter.allow(`verify-ip:${req.ip}`, 30, 3600_000)) return reply.code(429).send({ error: "Too many attempts. Try again later." });
        const body = LoginVerifySchema.safeParse(req.body);
        if (!body.success) return bad(reply, "This sign-in link is not valid.");
        const email = o.store.consumeLoginToken(body.data.token);
        if (!email || !allowed(email)) return bad(reply, "This sign-in link has expired or was already used. Ask for a new one.");
        const isAdmin = email === o.adminEmail;
        let user = o.store.getUserByEmail(email) ?? o.store.createUser(email, isAdmin);
        if (isAdmin && !user.isAdmin) {
          o.store.setAdmin(user.id, true);
          user = o.store.getUser(user.id)!;
        }
        const session = o.store.createSession(user.id, SESSION_TTL_MS);
        reply.header("Set-Cookie", cookie(session, SESSION_TTL_MS / 1000));
        return toMe(user);
      });

      auth.post("/logout", async (req, reply) => {
        const token = readCookie(req.headers.cookie, SESSION_COOKIE);
        if (token) o.store.deleteSession(token);
        reply.header("Set-Cookie", cookie("", 0));
        return { ok: true };
      });
    },
    { prefix: "/api/auth" },
  );
}
