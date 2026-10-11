import { describe, expect, it } from "vitest";
import { openDatabase } from "@dibao/db";
import { buildServer } from "./app.js";

describe("desktop private service boundary", () => {
  it("protects health and auth endpoints while retaining account authentication", async () => {
    const db = openDatabase(":memory:", { migrate: true });
    const app = buildServer({ db, logger: false, desktopRuntimeToken: "private-desktop-capability", upgradeAutoStart: false });
    try {
      expect((await app.inject({ url: "/api/system/health" })).statusCode).toBe(403);
      expect((await app.inject({ url: "/api/auth/session", headers: { "x-dibao-desktop-token": "incorrect" } })).statusCode).toBe(403);
      const headers = { "x-dibao-desktop-token": "private-desktop-capability" };
      expect((await app.inject({ url: "/api/system/health", headers })).statusCode).toBe(200);
      const session = await app.inject({ url: "/api/auth/session", headers });
      expect(session.statusCode).toBe(200); expect(session.json().data.authenticated).toBe(false);
      expect((await app.inject({ url: "/api/articles", headers })).statusCode).toBe(401);
      const hostile = await app.inject({ method: "POST", url: "/api/auth/setup", headers: { ...headers, origin: "https://evil.example" }, payload: { username: "Desktop", password: "desktop-password" } });
      expect(hostile.statusCode).toBe(403); expect(hostile.json().error.code).toBe("CSRF_ORIGIN_MISMATCH");
    } finally { await app.close(); db.close(); }
  });
});
