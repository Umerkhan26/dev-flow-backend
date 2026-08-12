import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.js";

describe("API smoke", () => {
  const app = createApp();

  it("health is public", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
  });

  it("rejects unauthenticated workspace list", async () => {
    const res = await request(app).get("/api/workspaces");
    expect(res.status).toBe(401);
  });

  it("validates login body", async () => {
    const res = await request(app).post("/api/auth/login").send({});
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe("VALIDATION_ERROR");
  });

  it("rejects unknown /api paths without a token (routers enforce auth)", async () => {
    const res = await request(app).get("/api/does-not-exist");
    expect(res.status).toBe(401);
  });
});
