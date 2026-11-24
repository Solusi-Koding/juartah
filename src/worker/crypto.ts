const enc = new TextEncoder();

export function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function unb64url(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
export const randomId = (n = 16) => b64url(crypto.getRandomValues(new Uint8Array(n)));

export async function sha256(s: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s))));
}

async function hmacKey(secret: string, purpose: string) {
  return crypto.subtle.importKey("raw", enc.encode(`${purpose}:${secret}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

/** Token bertanda tangan. `purpose` memisahkan jenis token agar tidak saling tertukar. */
export async function signToken(secret: string, purpose: string, payload: Record<string, unknown>, ttlMs: number): Promise<string> {
  const body = b64url(enc.encode(JSON.stringify({ ...payload, exp: Date.now() + ttlMs })));
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret, purpose), enc.encode(body));
  return `${body}.${b64url(new Uint8Array(sig))}`;
}

export async function verifyToken<T>(secret: string, purpose: string, token: string | undefined | null): Promise<T | null> {
  const [body, sig] = (token ?? "").split(".");
  if (!body || !sig) return null;
  try {
    const ok = await crypto.subtle.verify("HMAC", await hmacKey(secret, purpose), unb64url(sig), enc.encode(body));
    if (!ok) return null;
    const data = JSON.parse(new TextDecoder().decode(unb64url(body)));
    return typeof data.exp === "number" && data.exp > Date.now() ? (data as T) : null;
  } catch {
    return null;
  }
}

async function aesKey(secret: string) {
  const raw = await crypto.subtle.digest("SHA-256", enc.encode(`aes:${secret}`));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}
export async function encrypt(secret: string, text: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(secret), enc.encode(text));
  return `${b64url(iv)}.${b64url(new Uint8Array(ct))}`;
}
export async function decrypt(secret: string, data: string): Promise<string> {
  const [iv, ct] = data.split(".");
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64url(iv) }, await aesKey(secret), unb64url(ct));
  return new TextDecoder().decode(pt);
}
