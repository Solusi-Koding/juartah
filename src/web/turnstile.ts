type TS = { render: (el: HTMLElement, o: Record<string, unknown>) => string; reset: (id: string) => void; execute: (id: string) => void };
declare global { interface Window { turnstile?: TS } }

let loading: Promise<TS> | null = null;
function load(): Promise<TS> {
  loading ??= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    s.onload = () => resolve(window.turnstile!);
    s.onerror = () => { loading = null; reject(new Error("Pemeriksaan keamanan tidak bisa dimuat. Periksa koneksi, lalu coba lagi.")); };
    document.head.append(s);
  });
  return loading;
}

/** Token sekali pakai. Widget hanya terlihat kalau Cloudflare memang perlu interaksi. */
export async function turnstileToken(el: HTMLElement, sitekey: string): Promise<string> {
  const ts = await load();
  el.replaceChildren();
  const box = document.createElement("div");
  el.append(box);
  return new Promise((resolve, reject) => {
    ts.render(box, {
      sitekey, language: "id", appearance: "interaction-only", callback: resolve,
      "error-callback": () => { reject(new Error("Pemeriksaan keamanan gagal. Muat ulang halaman, lalu coba lagi.")); return true; },
    });
  });
}
