import { describe, expect, it } from "vitest";
import { desktopRequestAccess } from "./protocol-access.js";

function request(path: string, initiatorOrigin?: string | null, method = "GET") {
  return Object.assign(new Request(`https://dibao.localhost${path}`, { method }), { initiatorOrigin });
}

describe("desktop protocol access", () => {
  it("allows browser and app requests, but no external origins", () => {
    expect(desktopRequestAccess(request("/"))).toBe("trusted");
    expect(desktopRequestAccess(request("/api/settings", "https://dibao.localhost"))).toBe("trusted");
    expect(desktopRequestAccess(request("/api/settings", "https://evil.example"))).toBe("denied");
  });

  it("shares only the anonymous plugin stylesheet with opaque frames", () => {
    for (const origin of [null, "null"]) {
      expect(desktopRequestAccess(request("/api/plugins/ui.css", origin))).toBe("public-style");
      expect(desktopRequestAccess(request("/api/plugins/ui.css", origin, "HEAD"))).toBe("public-style");
      for (const path of ["/api/auth/session", "/api/settings", "/api/articles", "/api/plugins/app.dibao.daily-brief/assets/web/index.html"]) {
        expect(desktopRequestAccess(request(path, origin))).toBe("denied");
      }
      expect(desktopRequestAccess(request("/api/plugins/ui.css", origin, "POST"))).toBe("denied");
    }
  });

});
