const ACTIVE_SESSION_COOKIE = "boxedagent_active_session";
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

export function readActiveSessionCookie(): string | undefined {
  if (typeof document === "undefined") return undefined;
  const prefix = `${ACTIVE_SESSION_COOKIE}=`;
  for (const part of document.cookie.split(";")) {
    const item = part.trim();
    if (!item.startsWith(prefix)) continue;
    const value = safeDecode(item.slice(prefix.length)).trim();
    return isValidSessionCookieValue(value) ? value : undefined;
  }
  return undefined;
}

export function writeActiveSessionCookie(sessionId?: string) {
  if (typeof document === "undefined") return;
  const secure = location.protocol === "https:" ? "; Secure" : "";
  if (!sessionId) {
    document.cookie = `${ACTIVE_SESSION_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax${secure}`;
    return;
  }
  document.cookie = `${ACTIVE_SESSION_COOKIE}=${encodeURIComponent(sessionId)}; Path=/; Max-Age=${COOKIE_MAX_AGE_SECONDS}; SameSite=Lax${secure}`;
}

function safeDecode(value: string): string {
  try { return decodeURIComponent(value); }
  catch { return value; }
}

function isValidSessionCookieValue(value: string): boolean {
  return value.length > 0 && value.length <= 200 && !/[;\r\n]/.test(value);
}
