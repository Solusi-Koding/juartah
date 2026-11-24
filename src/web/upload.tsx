import "./base.css";
import "./upload.css";
import { render } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { ALLOWED_EXT, STATUS_LABEL, extOf, formatBytes, isAcceptableOrderNo, looksLikeShopee, normalizeOrderNo, type Status } from "../shared";
import { turnstileToken } from "./turnstile";
import type { CropView as CropViewT } from "./crop";
import { canCrop, checkFile, type Check } from "./filecheck";
import { CropMarks, Dialog, fmtTime, focusOnce } from "./ui";
import { UploadError, api, post, uploadFile, type Started } from "./uploader";

type Config = { shopName: string; intro: string; maxFileMb: number; turnstileKey: string | null };
type Found = { found: true; status: Status; revisionNote: string; fileCount: number; lastUploadAt: number };
type Item = { key: string; file: File; note: string; noteOpen: boolean; sent: number; state: "siap" | "kirim" | "tunggu" | "terkirim" | "gagal"; error: string; check: Check | null; original?: File };

const PUBLIC_STATUS: Record<Status, string> = {
  baru: "File sudah masuk, menunggu dicek",
  dicek: "File sedang dicek",
  revisi: "Perlu revisi",
  cetak: "Sedang dicetak",
  selesai: "Selesai",
};
const showNo = (no: string) => (looksLikeShopee(no) ? `${no.slice(0, 6)} ${no.slice(6, 10)} ${no.slice(10)}` : no);

const SHOPEE_URL = "https://shopee.co.id/juartah";

const VIEWABLE = ["jpg", "jpeg", "png", "webp", "gif", "bmp", "svg", "heic", "heif", "tif", "tiff", "avif"];

function stateText(it: Item): string {
  if (it.state === "terkirim") return "Terkirim";
  if (it.state === "gagal") return "Gagal";
  if (it.state === "tunggu") return "Menyambung";
  if (it.state === "kirim") return `${Math.floor((it.sent / it.file.size) * 100)}%`;
  return "Menunggu";
}

function problem(f: File, cfg: Config): string {
  if (f.size === 0) return "File kosong.";
  if (f.size > cfg.maxFileMb * 1048576) return `Melebihi batas ${formatBytes(cfg.maxFileMb * 1048576)}.`;
  if (!ALLOWED_EXT.includes(extOf(f.name))) return "Jenis file belum didukung. Kirim dalam bentuk ZIP.";
  return "";
}

function App() {
  const [cfg, setCfg] = useState<Config | null>(null);
  const [cfgErr, setCfgErr] = useState(false);
  // Wadah Turnstile di luar Form, supaya tidak hilang saat form berganti ke tampilan mengirim.
  const guard = useRef<HTMLDivElement>(null);
  const loadCfg = () => { setCfgErr(false); api<Config>("/config").then(setCfg).catch(() => setCfgErr(true)); };
  useEffect(loadCfg, []);
  useEffect(() => { if (cfg) document.title = `Kirim file desain | ${cfg.shopName}`; }, [cfg]);

  return (
    <main class="desk">
      <div class="sheet">
        <CropMarks />
        <header class="head">
          <div class="brand">
            <img class="brand-mark" src="/logo-mark.png" width="503" height="423" alt="" />
            <p class="shop">{cfg?.shopName ?? "Juartah Printing"}</p>
          </div>
          <h1>Kirim file desain untuk pesanan Anda</h1>
          <a class="store" href={SHOPEE_URL} target="_blank" rel="noopener">
            <span class="store-label">Toko kami di Shopee<span class="small muted">Lihat produk dan pesan cetakan</span></span>
            <span class="store-url num">shopee.co.id/juartah
              <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M4 2h8v8M12 2 2 12" fill="none" stroke="currentColor" stroke-width="2" /></svg>
            </span>
            <span class="vh"> (buka di tab baru)</span>
          </a>
        </header>
        {cfgErr ? (
          <div class="part" role="alert">
            <p class="err">Halaman belum bisa dimuat.</p>
            <p>Periksa koneksi internet, lalu coba lagi.</p>
            <p style={{ marginTop: "0.75rem" }}><button class="btn" onClick={loadCfg}>Muat ulang</button></p>
          </div>
        ) : cfg ? <><Form cfg={cfg} guard={guard} /><div ref={guard} /></> :<p class="part muted" role="status">Memuat form...</p>}
      </div>
    </main>
  );
}

function Form({ cfg, guard }: { cfg: Config; guard: { current: HTMLDivElement | null } }) {
  const [orderNo, setOrderNo] = useState(() => normalizeOrderNo(new URLSearchParams(location.search).get("no") ?? ""));
  const [orderErr, setOrderErr] = useState("");
  const [found, setFound] = useState<Found | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [filesErr, setFilesErr] = useState("");
  const [note, setNote] = useState("");
  const [over, setOver] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [stage, setStage] = useState<"isi" | "kirim" | "selesai">("isi");
  const [topErr, setTopErr] = useState("");
  const [total, setTotal] = useState<{ count: number; at: number } | null>(null);
  const [offline, setOffline] = useState(!navigator.onLine);
  const [peek, setPeek] = useState<string | null>(null);
  const [cropKey, setCropKey] = useState<string | null>(null);
  // Pemotong gambar dimuat saat pertama dipakai, supaya halaman awal tetap ringan.
  const [CropView, setCropView] = useState<typeof CropViewT | null>(null);
  const [cropErr, setCropErr] = useState("");
  function openCrop(key: string) {
    setPeek(null); setCropErr(""); setCropKey(key);
    if (!CropView) import("./crop").then((m) => setCropView(() => m.CropView)).catch(() => setCropErr("Alat potong gagal dimuat. Periksa koneksi, lalu coba lagi."));
  }

  const started = useRef<Started | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const orderRef = useRef<HTMLInputElement>(null);
  const headRef = useRef<HTMLHeadingElement>(null);
  const itemsRef = useRef<Item[]>([]);
  itemsRef.current = items;

  const patch = (key: string, p: Partial<Item>) => setItems((l) => l.map((i) => (i.key === key ? { ...i, ...p } : i)));
  const busy = stage === "kirim";

  useEffect(() => {
    const on = () => setOffline(!navigator.onLine);
    addEventListener("online", on); addEventListener("offline", on);
    return () => { removeEventListener("online", on); removeEventListener("offline", on); };
  }, []);

  useEffect(() => {
    if (!busy) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    addEventListener("beforeunload", warn);
    let lock: WakeLockSentinel | undefined;
    const take = () => { if (document.visibilityState === "visible") navigator.wakeLock?.request("screen").then((l) => (lock = l)).catch(() => {}); };
    take();
    document.addEventListener("visibilitychange", take);
    return () => { removeEventListener("beforeunload", warn); document.removeEventListener("visibilitychange", take); lock?.release().catch(() => {}); };
  }, [busy]);

  useEffect(() => { if (stage !== "isi") headRef.current?.focus(); }, [stage]);

  useEffect(() => {
    setFound(null);
    if (!looksLikeShopee(orderNo)) return;
    let live = true;
    const t = setTimeout(() => {
      api<Found | { found: false }>(`/status?no=${orderNo}`).then((r) => { if (live && r.found) setFound(r); }).catch(() => {});
    }, 500);
    return () => { live = false; clearTimeout(t); };
  }, [orderNo, stage]);

  function add(list: FileList | File[] | null) {
    if (!list) return;
    const have = new Set(itemsRef.current.map((i) => i.key));
    const fresh: Item[] = [];
    for (const file of Array.from(list)) {
      const key = `${file.name}|${file.size}|${file.lastModified}`;
      if (have.has(key)) continue;
      have.add(key);
      fresh.push({ key, file, note: "", noteOpen: false, sent: 0, state: "siap", error: problem(file, cfg), check: null });
    }
    setItems((l) => [...l, ...fresh]);
    for (const it of fresh) if (!it.error) runCheck(it.key, it.file);
    setFilesErr("");
  }

  // Hasil cek hanya dipakai bila file di baris itu belum diganti (misalnya sudah dipotong lagi).
  function runCheck(key: string, file: File) {
    checkFile(file).then((check) => setItems((l) => l.map((i) => (i.key === key && i.file === file ? { ...i, check } : i))));
  }
  function swapFile(key: string, file: File, original: File | undefined) {
    setItems((l) => l.map((i) => (i.key === key ? { ...i, file, original, check: null, sent: 0 } : i)));
    runCheck(key, file);
  }

  function review() {
    setTopErr("");
    const no = normalizeOrderNo(orderNo);
    if (!isAcceptableOrderNo(no)) {
      setOrderErr(no ? "Nomor pesanan belum lengkap. Salin lengkap dari aplikasi Shopee." : "Isi nomor pesanan dulu.");
      orderRef.current?.focus();
      return;
    }
    setOrderErr("");
    if (items.length === 0) return setFilesErr("Pilih minimal satu file.");
    if (items.some((i) => i.error && i.state === "siap")) return setFilesErr("Ada file yang tidak bisa dikirim. Hapus file bertanda, lalu kirim lagi.");
    setFilesErr("");
    setConfirm(true);
  }

  async function start(): Promise<Started> {
    const turnstile = cfg.turnstileKey ? await turnstileToken(guard.current!, cfg.turnstileKey) : undefined;
    return post<Started>("/start", { orderNo, note, turnstile });
  }

  async function send() {
    setConfirm(false);
    setTopErr("");
    setStage("kirim");
    try {
      started.current = await start();
    } catch (e) {
      setTopErr(e instanceof TypeError ? "Koneksi internet terputus. Periksa sinyal, lalu kirim lagi." : (e as Error).message);
      setStage("isi");
      return;
    }
    const queue = itemsRef.current.filter((i) => i.state !== "terkirim");
    const worker = async () => {
      for (let it = queue.shift(); it; it = queue.shift()) {
        const key = it.key;
        patch(key, { state: "kirim", error: "" });
        const cur = it;
        const opts = { signal: new AbortController().signal, onProgress: (sent: number) => patch(key, { sent }), onWait: (w: boolean) => patch(key, { state: w ? "tunggu" : "kirim" }) };
        try {
          await uploadFile(cur.file, cur.note.trim(), started.current!, opts);
          patch(key, { state: "terkirim", sent: cur.file.size });
        } catch (e) {
          const u = e as UploadError;
          patch(key, { state: "gagal", error: u.code === "net" ? "Koneksi terputus terlalu lama." : u.message });
        }
      }
    };
    await Promise.all([worker(), worker()]);
    try {
      const r = await post<{ fileCount: number }>("/finish", {}, started.current.token);
      setTotal({ count: r.fileCount, at: Date.now() });
    } catch { setTotal({ count: 0, at: Date.now() }); }
    setStage("selesai");
  }

  function reset(keepOrder: boolean) {
    setItems([]); setNote(""); setTotal(null); setTopErr("");
    if (!keepOrder) { setOrderNo(""); history.replaceState(null, "", "/"); }
    setStage("isi");
  }

  const bytes = items.reduce((s, i) => s + i.file.size, 0);
  const sent = items.reduce((s, i) => s + i.sent, 0);
  const ok = items.filter((i) => i.state === "terkirim").length;
  const failed = items.filter((i) => i.state === "gagal").length;
  const pct = bytes ? Math.min(100, Math.floor((sent / bytes) * 100)) : 0;
  const flagged = items.filter((i) => i.check?.warn.length).length;
  const cropItem = items.find((i) => i.key === cropKey) ?? null;

  if (stage !== "isi") {
    return (
      <>
        {stage === "kirim" ? (
          <section class="part">
            <h2 tabIndex={-1} ref={headRef}>Mengirim {items.length} file ke pesanan <span class="num">{showNo(orderNo)}</span></h2>
            <div class="bar" role="progressbar" aria-label="Total terkirim" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}><i style={{ width: `${pct}%` }} /></div>
            <p class="total"><span>{pct}%</span><span>{formatBytes(sent)} dari {formatBytes(bytes)}</span></p>
            <p role="status">{offline ? "Internet terputus. Pengiriman lanjut sendiri setelah tersambung." : "Biarkan halaman ini terbuka sampai selesai."}</p>
          </section>
        ) : (
          <section class="receipt" role="status">
            <h2 tabIndex={-1} ref={headRef}>{failed === 0 ? "File Anda sudah kami terima" : ok > 0 ? `${ok} file terkirim, ${failed} gagal` : "File belum terkirim"}</h2>
            <p class="num" style={{ margin: "0.5rem 0" }}>{showNo(orderNo)}</p>
            {total && total.count > 0 && <p>{total.count} file tersimpan untuk pesanan ini. {fmtTime(total.at)}.</p>}
            {failed > 0 && <p>File yang gagal akan dilanjutkan dari bagian terakhir yang sudah terkirim.</p>}
            {failed === 0 && <p class="muted">Buka halaman ini lagi dan isi nomor yang sama untuk melihat status atau menambah file.</p>}
          </section>
        )}
        <div class="tear" style={{ marginTop: "1rem" }} />
        <ol class="rows" style={{ borderTop: 0 }}>
          {items.map((it, n) => (
            <li class="row" key={it.key}>
              <span class="row-no">{n + 1}</span>
              <button type="button" class="row-name name-btn" onClick={() => setPeek(it.key)}>{it.file.name}</button>
              <span class="small">{it.state === "gagal" ? <b class="err">Gagal</b> : stateText(it)}</span>
              {it.state === "kirim" || it.state === "tunggu" ? <div class="bar row-wide"><i style={{ width: `${(it.sent / it.file.size) * 100}%` }} /></div> : null}
              {it.error && <p class="row-wide err small">{it.error}</p>}
            </li>
          ))}
        </ol>
        {stage === "selesai" && (
          <div class="actions" style={{ marginTop: "1.25rem" }}>
            {failed > 0 && <button class="btn btn-red" onClick={send}>Kirim ulang yang gagal</button>}
            <button class="btn" onClick={() => reset(true)}>Tambah file lain</button>
            <button class="btn" onClick={() => reset(false)}>Kirim untuk pesanan lain</button>
          </div>
        )}
        <PeekDialog items={items} peek={peek} setPeek={setPeek} />
      </>
    );
  }

  return (
    <form onSubmit={(e) => { e.preventDefault(); review(); }} noValidate>
      {cfg.intro && <p class="part" style={{ whiteSpace: "pre-line" }}>{cfg.intro}</p>}
      {topErr && <p class="notice notice-red" role="alert" style={{ marginTop: "1rem" }}><b>Belum terkirim.</b> {topErr}</p>}

      <section class="part">
        <label class="label" for="no">Nomor pesanan Shopee</label>
        <input id="no" ref={orderRef} class="field order-in" value={orderNo} placeholder="Tempel nomor pesanan" autocomplete="off" autocapitalize="characters" spellcheck={false}
          maxLength={40} aria-invalid={!!orderErr} aria-describedby="no-err"
          onInput={(e) => { const v = normalizeOrderNo(e.currentTarget.value); e.currentTarget.value = v; setOrderNo(v); setOrderErr(""); }} />
        <p id="no-err" class="err" role="alert">{orderErr}</p>
        <details>
          <summary>Di mana nomor pesanan?</summary>
          <p>Buka aplikasi Shopee, masuk ke Saya, pilih pesanan Anda di Pesanan Saya, lalu salin No. Pesanan di rincian pesanan.</p>
        </details>
        {found && (
          <div class={`notice found ${found.status === "revisi" ? "notice-red" : ""}`} role="status">
            <strong>Status: {PUBLIC_STATUS[found.status] ?? STATUS_LABEL[found.status]}</strong>
            <span>{found.fileCount} file tersimpan, terakhir {fmtTime(found.lastUploadAt)}.</span>
            {found.revisionNote && <p style={{ whiteSpace: "pre-line", marginTop: "0.5rem" }}><b>Pesan dari toko:</b> {found.revisionNote}</p>}
          </div>
        )}
      </section>

      <section class="part">
        <h2>File desain</h2>
        <div class={`drop ${over ? "over" : ""}`}
          onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
          onDrop={(e) => { e.preventDefault(); setOver(false); add(e.dataTransfer?.files ?? null); }}>
          <button type="button" class="btn" onClick={() => picker.current!.click()}>{items.length ? "Tambah file" : "Pilih file"}</button>
          <span class="drop-hint muted">atau seret file ke sini</span>
          <span class="small muted">PDF, AI, CDR, PSD, gambar, atau ZIP. Maksimal {formatBytes(cfg.maxFileMb * 1048576)} per file.</span>
          <input ref={picker} class="vh" type="file" multiple tabIndex={-1} aria-hidden="true" onChange={(e) => { add(e.currentTarget.files); e.currentTarget.value = ""; }} />
        </div>
        {items.length > 0 && (
          <ol class="rows" aria-label="File yang akan dikirim">
            {items.map((it, n) => (
              <li class="row" key={it.key}>
                <span class="row-no">{n + 1}</span>
                <span><button type="button" class="row-name name-btn" onClick={() => setPeek(it.key)}>{it.file.name}</button><br /><span class="small muted">{formatBytes(it.file.size)}{it.check?.dims ? `, ${it.check.dims.w} × ${it.check.dims.h} px` : ""}</span></span>
                <button type="button" class="link" aria-label={`Hapus ${it.file.name}`} onClick={() => { setItems((l) => l.filter((x) => x.key !== it.key)); setFilesErr(""); }}>Hapus</button>
                {it.error && <p class="row-wide err small">{it.error}</p>}
                {it.check?.warn.map((w) => <p class="row-wide small warn" key={w}><b>Periksa:</b> {w}</p>)}
                {!it.error && (
                  <div class="row-wide">
                    {it.noteOpen ? (
                      <>
                        <label class="vh" for={`c${n}`}>Catatan untuk {it.file.name}</label>
                        <textarea id={`c${n}`} class="field" style={{ minHeight: "4rem" }} rows={2} maxLength={1000} value={it.note} ref={focusOnce} placeholder="Catatan untuk file ini"
                          onInput={(e) => patch(it.key, { note: e.currentTarget.value })} />
                      </>
                    ) : (
                      <div class="row-acts">
                        <button type="button" class="link" onClick={() => patch(it.key, { noteOpen: true })}>Tambah catatan<span class="vh"> untuk {it.file.name}</span></button>
                        {it.check && canCrop(it.file, it.check.dims?.ch) && <button type="button" class="link" onClick={() => openCrop(it.key)}>Potong gambar<span class="vh"> {it.file.name}</span></button>}
                        {it.original && <button type="button" class="link" onClick={() => swapFile(it.key, it.original!, undefined)}>Kembalikan asli<span class="vh"> {it.file.name}</span></button>}
                      </div>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ol>
        )}
        {items.length > 1 && <p class="total"><span>{items.length} file</span><span>{formatBytes(bytes)}</span></p>}
        <p class="err" role="alert">{filesErr}</p>
      </section>

      <section class="part">
        <label class="label" for="note">Catatan untuk seluruh pesanan <span class="muted" style={{ fontWeight: 400 }}>(opsional)</span></label>
        <textarea id="note" class="field" rows={3} maxLength={2000} value={note} onInput={(e) => setNote(e.currentTarget.value)} />
      </section>

      <button class="btn btn-red send" type="submit">{items.length ? `Kirim ${items.length} file` : "Kirim file"}</button>
      <p class="trust small muted">Halaman ini hanya untuk mengirim file. Kami tidak pernah meminta password, OTP, atau pembayaran di sini. <a href="/privasi/">Kebijakan privasi</a></p>

      <PeekDialog items={items} peek={peek} setPeek={setPeek} onCrop={openCrop} onRestore={(k, f) => swapFile(k, f, undefined)} />
      <Dialog open={!!cropItem} onClose={() => setCropKey(null)} label="Potong gambar" wide>
        {cropItem && (CropView
          ? <CropView file={cropItem.file} onCancel={() => setCropKey(null)}
              onDone={(f) => { swapFile(cropItem.key, f, cropItem.original ?? cropItem.file); setCropKey(null); }} />
          : cropErr
            ? <><p class="err" role="alert">{cropErr}</p><div class="actions" style={{ marginTop: "1rem" }}><button type="button" class="btn" onClick={() => openCrop(cropItem.key)}>Coba lagi</button><button type="button" class="btn" onClick={() => setCropKey(null)}>Tutup</button></div></>
            : <p role="status" class="muted">Memuat alat potong...</p>)}
      </Dialog>

      <Dialog open={confirm} onClose={() => setConfirm(false)} label="Periksa nomor pesanan">
        <h2>Nomor pesanan sudah benar?</h2>
        <p class="num confirm-no">{showNo(orderNo)}</p>
        {!looksLikeShopee(orderNo) && <p class="notice notice-red" style={{ marginBottom: "0.75rem" }}><b>Periksa lagi.</b> Nomor Shopee biasanya 14 huruf dan angka, diawali tanggal pesanan.</p>}
        <p style={{ marginBottom: "1rem" }}>{items.length} file akan dikirim ke pesanan ini.{flagged > 0 && <> <b>{flagged} file bertanda Periksa.</b> Tetap bisa dikirim, tapi hasil cetak mungkin kurang bagus.</>}</p>
        <div class="actions">
          <button type="button" class="btn btn-red" ref={focusOnce} onClick={send}>Benar, kirim file</button>
          <button type="button" class="btn" onClick={() => { setConfirm(false); setTimeout(() => orderRef.current?.focus()); }}>Perbaiki nomor</button>
        </div>
      </Dialog>
    </form>
  );
}

function PeekDialog({ items, peek, setPeek, onCrop, onRestore }: {
  items: Item[]; peek: string | null; setPeek: (k: string | null) => void;
  onCrop?: (key: string) => void; onRestore?: (key: string, f: File) => void;
}) {
  const it = items.find((i) => i.key === peek) ?? null;
  return (
    <Dialog open={!!it} onClose={() => setPeek(null)} label={`File ${it?.file.name ?? ""}`} wide>
      {it && <Peek it={it} close={() => setPeek(null)} onCrop={onCrop} onRestore={onRestore} />}
    </Dialog>
  );
}

function Peek({ it, close, onCrop, onRestore }: { it: Item; close: () => void; onCrop?: (key: string) => void; onRestore?: (key: string, f: File) => void }) {
  const url = useMemo(() => (VIEWABLE.includes(extOf(it.file.name)) ? URL.createObjectURL(it.file) : ""), [it.file]);
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);
  const [bad, setBad] = useState(false);
  useEffect(() => setBad(false), [url]);
  const sending = it.state === "kirim" || it.state === "tunggu";
  const dims = it.check?.dims;
  return (
    <div class="peek">
      {url && !bad
        ? <img class="peek-img" src={url} alt={`Pratinjau ${it.file.name}`} onError={() => setBad(true)} />
        : <p class="peek-none"><b>{extOf(it.file.name).toUpperCase() || "FILE"}</b><span class="small muted">Pratinjau tidak tersedia untuk jenis file ini.</span></p>}
      <h2 class="peek-name">{it.file.name}</h2>
      <p class="small muted">{formatBytes(it.file.size)}{dims ? `, ${dims.w} × ${dims.h} px` : ""}{it.original ? ", hasil potongan" : ""}</p>
      {it.state !== "siap" && (
        <p style={{ marginTop: "0.5rem" }} role="status">
          {it.state === "gagal" ? <b class="err">Gagal terkirim.</b> : it.state === "terkirim" ? <b>Terkirim.</b> : <><b>{stateText(it)}</b> terkirim</>}
          {it.error && <span class="err"> {it.error}</span>}
        </p>
      )}
      {sending && <div class="bar" style={{ marginTop: "0.35rem" }}><i style={{ width: `${(it.sent / it.file.size) * 100}%` }} /></div>}
      {it.check?.warn.map((w) => <p class="small warn" style={{ marginTop: "0.5rem" }} key={w}><b>Periksa:</b> {w}</p>)}
      {it.note.trim() && <p class="f-note" style={{ marginTop: "0.5rem" }}><b>Catatan:</b> {it.note}</p>}
      {it.state === "siap" && dims?.ch === 4 && <p class="small muted" style={{ marginTop: "0.5rem" }}>Gambar CMYK tidak bisa dipotong di sini supaya warnanya tidak berubah. Tulis bagian yang mau dicetak di catatan.</p>}
      <div class="actions" style={{ marginTop: "1rem" }}>
        {it.state === "siap" && onCrop && !it.error && canCrop(it.file, dims?.ch) && <button type="button" class="btn btn-red" onClick={() => onCrop(it.key)}>Potong gambar</button>}
        {it.state === "siap" && onRestore && it.original && <button type="button" class="btn" onClick={() => onRestore(it.key, it.original!)}>Kembalikan file asli</button>}
        <button type="button" class="btn" ref={focusOnce} onClick={close}>Tutup</button>
      </div>
    </div>
  );
}

render(<App />, document.getElementById("app")!);
