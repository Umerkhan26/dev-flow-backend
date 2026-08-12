import { describe, expect, it } from "vitest";
import { hashPassword, hashToken, slugify, verifyPassword } from "../modules/auth/auth.service.js";

describe("auth.service", () => {
  it("hashes and verifies passwords", async () => {
    const hash = await hashPassword("secret-pass-123");
    expect(hash).not.toEqual("secret-pass-123");
    expect(await verifyPassword("secret-pass-123", hash)).toBe(true);
    expect(await verifyPassword("wrong", hash)).toBe(false);
  });

  it("hashes tokens stably", () => {
    const a = hashToken("abc");
    const b = hashToken("abc");
    const c = hashToken("xyz");
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
    expect(a).toHaveLength(64);
  });

  it("slugifies workspace names", () => {
    expect(slugify("Acme Portal!")).toBe("acme-portal");
    expect(slugify("  Hello   World  ")).toBe("hello-world");
  });
});

describe("RBAC role rank", () => {
  const roleRank: Record<string, number> = {
    GUEST: 1,
    MEMBER: 2,
    MANAGER: 3,
    ADMIN: 4,
    OWNER: 5,
  };

  it("orders roles for tenant checks", () => {
    expect(roleRank.GUEST).toBeLessThan(roleRank.MEMBER);
    expect(roleRank.MEMBER).toBeLessThan(roleRank.ADMIN);
    expect(roleRank.ADMIN).toBeLessThan(roleRank.OWNER);
  });

  it("blocks lower roles from higher privileges", () => {
    const actor = "MEMBER";
    const required = "ADMIN";
    expect(roleRank[actor] < roleRank[required]).toBe(true);
  });
});
