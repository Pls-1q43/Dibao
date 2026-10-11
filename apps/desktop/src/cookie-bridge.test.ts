import { describe, expect, it, vi } from "vitest";
import { desktopCookieHeader, storeDesktopCookies } from "./cookie-bridge.js";

function store() {
  return { get: vi.fn(async () => [] as Electron.Cookie[]), set: vi.fn(async (_details: Electron.CookiesSetDetails) => undefined), remove: vi.fn(async () => undefined) };
}
describe("desktop session cookies", () => {
  it("persists secure HttpOnly login cookies under the fixed application origin", async () => {
    const cookies = store();
    await storeDesktopCookies(new Headers({ "set-cookie": "dibao_session=test-session; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000" }), cookies);
    expect(cookies.set.mock.calls[0][0]).toMatchObject({ url: "https://dibao.localhost", name: "dibao_session", value: "test-session", secure: true, httpOnly: true, path: "/", sameSite: "lax" });
    expect(cookies.set.mock.calls[0][0].expirationDate).toBeGreaterThan(Date.now() / 1000);
    cookies.get.mockResolvedValueOnce([{ name: "dibao_session", value: "test-session" } as Electron.Cookie]);
    expect(await desktopCookieHeader(cookies)).toBe("dibao_session=test-session");
  });
  it("clears logout cookies and rejects cookies belonging to external sites", async () => {
    const cookies = store();
    await storeDesktopCookies(new Headers({ "set-cookie": "dibao_session=; Path=/; Max-Age=0" }), cookies);
    expect(cookies.remove).toHaveBeenCalledWith("https://dibao.localhost/", "dibao_session");
    await expect(storeDesktopCookies(new Headers({ "set-cookie": "session=foreign; Domain=evil.example" }), cookies)).rejects.toThrow("cookie domain");
    expect(cookies.set).not.toHaveBeenCalled();
  });
});
