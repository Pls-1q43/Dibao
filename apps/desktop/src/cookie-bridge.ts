import { parse } from "set-cookie-parser";
import { DESKTOP_ORIGIN } from "@dibao/shared";

type CookieStore = Pick<Electron.Cookies, "get" | "set" | "remove">;

export async function desktopCookieHeader(cookies: CookieStore, url = DESKTOP_ORIGIN): Promise<string> {
  return (await cookies.get({ url })).map(cookie => `${cookie.name}=${cookie.value}`).join("; ");
}

export async function storeDesktopCookies(headers: Headers, cookies: CookieStore): Promise<void> {
  for (const cookie of parse(headers.getSetCookie(), { decodeValues: false })) {
    if (cookie.domain && cookie.domain.replace(/^\./, "") !== "dibao.localhost") throw new Error("Invalid desktop cookie domain");
    const expirationDate = cookie.maxAge !== undefined
      ? Date.now() / 1000 + cookie.maxAge
      : cookie.expires?.getTime() !== undefined ? cookie.expires.getTime() / 1000 : undefined;
    if (expirationDate !== undefined && expirationDate <= Date.now() / 1000) {
      await cookies.remove(`${DESKTOP_ORIGIN}${cookie.path ?? "/"}`, cookie.name);
      continue;
    }
    await cookies.set({
      url: DESKTOP_ORIGIN, name: cookie.name, value: cookie.value,
      path: cookie.path ?? "/", httpOnly: cookie.httpOnly, secure: true,
      sameSite: cookie.sameSite?.toLowerCase() === "strict" ? "strict" : "lax",
      expirationDate
    });
  }
}
