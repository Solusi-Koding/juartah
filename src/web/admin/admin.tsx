import "../base.css";
import "./admin.css";
import { render } from "preact";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { STATUSES, STATUS_LABEL, extOf, formatBytes, looksLikeShopee, normalizeOrderNo, type Status } from "../../shared";
import { CropMarks, Dialog, copyText, fmtTime, focusOnce } from "../ui";

type Settings = { shopName: string; intro: string; maxFileMb: number; autoTrashDays: number; revisionTemplates: string[] };
type Me = { email: string; isOwner: boolean; canDelete: boolean; appUrl: string; settings: Settings; drive: { connected: boolean; broken: boolean; email: string | null }; turnstile: boolean };
type Row = { id: string; order_no: string; status: Status; has_new: number; updated_at: number; last_upload_at: number; trashed_at: number | null; file_count: number; bytes: number; file_notes: number; note_count: number };
type ListData = { orders: Row[]; next: number | null; counts: Partial<Record<Status, number>> };
type FileT = { id: string; name: string; size: number; mime: string; note: string; state: string; created_at: number; completed_at: number | null };
type Detail = { order: { id: string; order_no: string; status: Status; revision_note: string; admin_note: string; drive_folder_id: string | null; trashed_at: number | null }; files: FileT[]; notes: { id: string; body: string; created_at: number }[] };

class ApiErr extends Error { constructor(m: string, public status: number, public data: Record<string, string>) { super(m); } }
async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api/admin${path}`, { method, headers: body === undefined ? {} : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch { throw new ApiErr("Koneksi internet terputus.", 0, {}); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiErr(data.error ?? "Ada gangguan di server.", res.status, data);
  return data as T;
}

const showNo = (no: string) => (looksLikeShopee(no) ? `${no.slice(0, 6)} ${no.slice(6, 10)} ${no.slice(10)}` : no);
const parseHash = () => {
  const h = location.hash.slice(1);
  return h.startsWith("p/") ? { view: "order" as const, id: h.slice(2) } : h === "pengaturan" ? { view: "set" as const, id: "" } : { view: "list" as const, id: "" };
};
const bare = (l: string) => l.replace(/^\s*-\s*/, "").trim();
const hasReason = (text: string, t: string) => text.split("\n").some((l) => bare(l) === t);
/** Alasan siap pakai ditulis sebagai daftar "- ...", supaya tetap rapi saat ditempel di chat. */
function toggleReason(text: string, t: string): string {
  if (hasReason(text, t)) return text.split("\n").filter((l) => bare(l) !== t).join("\n");
  const base = text.trimEnd();
  return `${base}${base ? "\n" : ""}- ${t}`;
}

const LOGIN_ERR: Record<string, string> = {
  akses: "Akun itu belum diberi akses. Minta pemilik menambahkan email Anda di Pengaturan.",
  state: "Waktu masuk habis. Coba sekali lagi.",
  batal: "Proses masuk dibatalkan.",
  google: "Google menolak permintaan masuk. Coba sekali lagi.",
  owner: "Hanya pemilik yang bisa menyambungkan Drive.",
  izin: "Izin Drive belum dicentang. Sambungkan lagi dan setujui akses file Drive.",
};

let toastTimer = 0;
function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [err, setErr] = useState<ApiErr | null>(null);
  const [route, setRoute] = useState(parseHash());
  const [toast, setToast] = useState("");
  const [flash] = useState(() => LOGIN_ERR[new URLSearchParams(location.search).get("e") ?? ""] ?? "");

  const say = useCallback((m: string) => { setToast(m); clearTimeout(toastTimer); toastTimer = window.setTimeout(() => setToast(""), 3500); }, []);
  const load = useCallback(() => { setErr(null); call<Me>("GET", "/me").then(setMe).catch(setErr); }, []);
  useEffect(() => {
    load();
    const on = () => setRoute(parseHash());
    addEventListener("hashchange", on);
    if (location.search) history.replaceState(null, "", location.pathname + location.hash);
    return () => removeEventListener("hashchange", on);
  }, []);

  if (err?.status === 401) {
    return (
      <main class="login"><div class="sheet"><CropMarks />
        <p class="shop">Juartah Printing</p>
        <h1 style={{ fontSize: "1.25rem" }}>Kelola file pelanggan</h1>
        {flash && <p class="notice notice-red" role="alert" style={{ marginTop: "1rem" }}>{flash}</p>}
        <p style={{ margin: "1rem 0" }} class="muted">Khusus pemilik dan staf toko.</p>
        <a class="btn btn-red" href="/auth/login">Masuk dengan Google</a>
        <p class="small" style={{ marginTop: "1rem" }}><a href="/privasi/">Kebijakan privasi</a></p>
      </div></main>
    );
  }
  if (err) return <main class="login"><div class="sheet"><p class="err" role="alert">{err.message}</p><p style={{ marginTop: "1rem" }}><button class="btn" onClick={load}>Muat ulang</button></p></div></main>;
  if (!me) return <p class="bench muted" role="status">Memuat dashboard...</p>;

  const driveBad = !me.drive.connected || me.drive.broken;
  return (
    <>
      <header class="top">
        <a class="shop" href="#">{me.settings.shopName}</a>
        <nav>{route.view === "set" ? <a class="btn" href="#">Daftar pesanan</a> : <a class="btn" href="#pengaturan">Pengaturan</a>}</nav>
      </header>
      {driveBad && (
        <p class="alertbar" role="alert">{me.drive.broken ? "Google Drive terputus, pelanggan tidak bisa mengirim file." : "Google Drive belum tersambung, pelanggan belum bisa mengirim file."}{" "}
          {me.isOwner ? <a href="/auth/drive">Sambungkan Drive</a> : "Hubungi pemilik."}</p>
      )}
      {flash && <p class="alertbar" role="alert">{flash}</p>}
      <main class="bench">{route.view === "set" ? <SettingsView me={me} reload={load} say={say} /> : <Bench me={me} openId={route.id} say={say} />}</main>
      <div role="status" aria-live="polite">{toast && <p class="toast">{toast}</p>}</div>
    </>
  );
}

function Bench({ me, openId, say }: { me: Me; openId: string; say: (m: string) => void }) {
  const [data, setData] = useState<ListData | null>(null);
  const [err, setErr] = useState("");
  const [status, setStatus] = useState<Status | "">("");
  const [q, setQ] = useState("");
  const [more, setMore] = useState(false);
  const [picking, setPicking] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [to, setTo] = useState<Status | "">("");
  const [bulkBusy, setBulkBusy] = useState(false);
  const [ver, setVer] = useState(0);
  const extended = useRef(false);
  const seq = useRef(0);

  const url = (before?: number) => `/orders?${new URLSearchParams({ status, q, ...(before ? { before: String(before) } : {}) })}`;
  const load = useCallback(async () => {
    const n = ++seq.current;
    try { const d = await call<ListData>("GET", url()); if (n === seq.current) { setData(d); setErr(""); } }
    catch (e) { if (n === seq.current) setErr((e as Error).message); }
  }, [status, q]);

  useEffect(() => {
    extended.current = false;
    const t = setTimeout(load, q ? 250 : 0);
    // Penyegaran berkala berhenti setelah daftar diperpanjang, supaya posisi gulir tidak hilang.
    const tick = setInterval(() => { if (document.visibilityState === "visible" && !extended.current) load(); }, 30_000);
    const vis = () => { if (document.visibilityState === "visible" && !extended.current) load(); };
    document.addEventListener("visibilitychange", vis);
    return () => { clearTimeout(t); clearInterval(tick); document.removeEventListener("visibilitychange", vis); };
  }, [load]);

  async function loadMore() {
    if (!data?.next) return;
    setMore(true);
    try { const d = await call<ListData>("GET", url(data.next)); extended.current = true; setData({ ...d, orders: [...data.orders, ...d.orders] }); }
    catch (e) { say((e as Error).message); }
    setMore(false);
  }

  useEffect(() => setPicked(new Set()), [status, q]);

  function pick(id: string, on: boolean) {
    setPicked((p) => { const n = new Set(p); if (on) n.add(id); else n.delete(id); return n; });
  }
  function stopPicking() { setPicking(false); setPicked(new Set()); setTo(""); }
  async function applyBulk() {
    if (!to || !picked.size) return;
    setBulkBusy(true);
    try {
      const r = await call<{ changed: number }>("POST", "/orders/bulk", { ids: [...picked], status: to });
      say(r.changed ? `${r.changed} pesanan diubah ke ${STATUS_LABEL[to]}` : `Pesanan terpilih sudah berstatus ${STATUS_LABEL[to]}`);
      setPicked(new Set()); setTo(""); setVer((v) => v + 1); await load();
    } catch (e) { say((e as Error).message); }
    setBulkBusy(false);
  }

  const all = data ? STATUSES.reduce((s, k) => s + (data.counts[k] ?? 0), 0) : 0;
  const shown = data?.orders ?? [];
  const allPicked = shown.length > 0 && shown.every((o) => picked.has(o.id));
  return (
    <div class="split" data-open={openId ? "true" : "false"}>
      <section class="pane-list" aria-label="Daftar pesanan">
        <label class="vh" for="q">Cari nomor pesanan</label>
        <input id="q" class="field" type="search" placeholder="Cari nomor pesanan" value={q} autocomplete="off" onInput={(e) => setQ(normalizeOrderNo(e.currentTarget.value))} />
        <div class="filters" role="group" aria-label="Saring status">
          <button aria-pressed={status === ""} onClick={() => setStatus("")}>Semua <b>{all}</b></button>
          {STATUSES.map((s) => <button key={s} aria-pressed={status === s} onClick={() => setStatus(s)}>{STATUS_LABEL[s]} <b>{data?.counts[s] ?? 0}</b></button>)}
        </div>
        {err && <div class="notice notice-red" role="alert">{err} <button class="link" onClick={load}>Coba lagi</button></div>}
        {!data && !err && <p class="empty muted" role="status">Memuat pesanan...</p>}
        {data && data.orders.length === 0 && (
          <div class="empty">
            {q || status ? <p>Tidak ada pesanan yang cocok. <button class="link" onClick={() => { setQ(""); setStatus(""); }}>Tampilkan semua</button></p> : (
              <><p><b>Belum ada file masuk.</b> Bagikan link ini ke pelanggan:</p><p>{me.appUrl}</p>
                <p><button class="btn" onClick={async () => say((await copyText(me.appUrl)) ? "Link disalin" : "Gagal menyalin, salin manual")}>Salin link upload</button></p></>
            )}
          </div>
        )}
        {shown.length > 0 && (
          <div class="listbar">
            {picking ? (
              <>
                <label class="check"><input type="checkbox" checked={allPicked} onChange={(e) => setPicked(e.currentTarget.checked ? new Set(shown.map((o) => o.id)) : new Set())} />Pilih semua yang tampil</label>
                <button class="link" onClick={stopPicking}>Selesai memilih</button>
              </>
            ) : <button class="link" style={{ paddingLeft: 0 }} onClick={() => setPicking(true)}>Pilih beberapa pesanan</button>}
          </div>
        )}
        {shown.length > 0 && (
          <ul class="orders">
            {shown.map((o) => {
              const body = <>
                <span class="num">{showNo(o.order_no)}</span><span class="st">{STATUS_LABEL[o.status]}</span>
                <span class="small muted">{o.trashed_at ? "File di Trash" : `${o.file_count} file, ${formatBytes(o.bytes)}`}{o.note_count + o.file_notes > 0 ? ", ada catatan" : ""}<br />{fmtTime(o.last_upload_at)}</span>
                {o.has_new ? <span class="new small">File baru</span> : null}
              </>;
              return <li key={o.id}>{picking
                ? <label class="pick"><input type="checkbox" checked={picked.has(o.id)} onChange={(e) => pick(o.id, e.currentTarget.checked)} />{body}</label>
                : <a href={`#p/${o.id}`} aria-current={o.id === openId ? "true" : undefined}>{body}</a>}</li>;
            })}
          </ul>
        )}
        {data?.next && <p style={{ marginTop: "0.75rem" }}><button class="btn" disabled={more} onClick={loadMore}>{more ? "Memuat..." : "Muat pesanan lama"}</button></p>}
        {picking && (
          <div class="bulkbar" role="group" aria-label="Ubah status pesanan terpilih">
            <p><b>{picked.size}</b> pesanan dipilih</p>
            <label class="vh" for="bt">Status baru</label>
            <select id="bt" class="field" value={to} onChange={(e) => setTo(e.currentTarget.value as Status | "")}>
              <option value="">Pilih status baru</option>
              {STATUSES.filter((s) => s !== "revisi").map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
            </select>
            <button class="btn btn-red" disabled={bulkBusy || !to || !picked.size} onClick={applyBulk}>{bulkBusy ? "Menyimpan..." : "Ubah status"}</button>
          </div>
        )}
      </section>
      <section class="pane-detail" aria-label="Rincian pesanan">
        {openId ? <OrderView key={`${openId}.${ver}`} id={openId} me={me} say={say} changed={load} /> : <p class="muted" style={{ paddingTop: "0.75rem" }}>Pilih pesanan di daftar untuk melihat filenya.</p>}
      </section>
    </div>
  );
}

function OrderView({ id, me, say, changed }: { id: string; me: Me; say: (m: string) => void; changed: () => void }) {
  const [d, setD] = useState<Detail | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [rev, setRev] = useState<string | null>(null);
  const [memo, setMemo] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [mergeId, setMergeId] = useState("");
  const [del, setDel] = useState<FileT | null>(null);
  const [view, setView] = useState<FileT | null>(null);

  const load = useCallback(() => call<Detail>("GET", `/orders/${id}`).then((x) => { setD(x); setErr(""); }).catch((e) => setErr(e.message)), [id]);
  useEffect(() => { load(); call("POST", `/orders/${id}/seen`).then(changed).catch(() => {}); scrollTo(0, 0); }, [id]);

  async function act(fn: () => Promise<unknown>, done: string) {
    setBusy(true);
    try { await fn(); say(done); await load(); changed(); return true; }
    catch (e) { const a = e as ApiErr; if (a.data?.code === "exists") setMergeId(a.data.otherId); else say(a.message); return false; }
    finally { setBusy(false); }
  }
  const patch = (b: object, done: string) => act(() => call("PATCH", `/orders/${id}`, b), done);

  if (err) return <div class="notice notice-red" role="alert">{err} <button class="link" onClick={load}>Coba lagi</button> <a class="btn only-narrow" href="#">Kembali ke daftar</a></div>;
  if (!d) return <p class="muted" role="status">Memuat rincian pesanan...</p>;
  const { order: o, notes } = d;
  const files = d.files.filter((f) => f.state === "done");
  const going = d.files.filter((f) => f.state === "uploading");
  const link = `${me.appUrl}/?no=${o.order_no}`;
  const copy = async (t: string, m: string) => say((await copyText(t)) ? m : "Gagal menyalin, salin manual");

  async function downloadAll() {
    for (const f of files) {
      const a = document.createElement("a");
      a.href = `/api/admin/files/${f.id}/download`;
      a.download = f.name;
      document.body.append(a); a.click(); a.remove();
      await new Promise((r) => setTimeout(r, 900));
    }
  }

  return (
    <>
      <p style={{ marginBottom: "1.1rem" }} class="only-narrow"><a class="btn" href="#">Kembali ke daftar</a></p>
      <article class="sheet"><CropMarks />
        <header class="d-head">
          <h1 class="num">{showNo(o.order_no)}</h1>
          <div class="actions"><button class="link" onClick={() => copy(o.order_no, "Nomor disalin")}>Salin nomor</button><button class="link" onClick={() => setRenaming(o.order_no)}>Ubah nomor</button></div>
        </header>

        <section class="block">
          <h2>Status</h2>
          <div class="steps" role="group" aria-label="Ubah status">
            {STATUSES.map((s) => <button key={s} class="btn" disabled={busy} aria-pressed={o.status === s} onClick={() => (s === "revisi" ? setRev(o.revision_note) : s !== o.status && (setRev(null), patch({ status: s }, `Status: ${STATUS_LABEL[s]}`)))}>{STATUS_LABEL[s]}</button>)}
          </div>
          {rev !== null && (
            <form style={{ marginTop: "0.9rem" }} onSubmit={async (e) => { e.preventDefault(); if (await patch({ status: "revisi", revisionNote: rev }, "Permintaan revisi disimpan")) setRev(null); }}>
              <label class="label" for="rev">Apa yang perlu diperbaiki pelanggan?</label>
              {me.settings.revisionTemplates.length > 0 && (
                <div class="chips" role="group" aria-label="Alasan siap pakai">
                  {me.settings.revisionTemplates.map((t) => <button type="button" key={t} class="chip" aria-pressed={hasReason(rev, t)} onClick={() => setRev(toggleReason(rev, t))}>{t}</button>)}
                </div>
              )}
              <textarea id="rev" class="field" ref={focusOnce} required rows={4} value={rev} placeholder="Pilih alasan di atas atau tulis sendiri" onInput={(e) => setRev(e.currentTarget.value)} />
              <div class="actions" style={{ marginTop: "0.6rem" }}><button class="btn btn-red" disabled={busy}>Simpan permintaan revisi</button><button type="button" class="btn" onClick={() => setRev(null)}>Batal</button></div>
            </form>
          )}
          {rev === null && o.status === "revisi" && (
            <div class="notice notice-red" style={{ marginTop: "0.9rem" }}><p style={{ whiteSpace: "pre-line" }}>{o.revision_note}</p>
              <button class="link" style={{ paddingLeft: 0 }} onClick={() => copy(`Halo kak, file pesanan ${o.order_no} perlu diperbaiki:\n${o.revision_note}\n\nSilakan kirim file perbaikan di: ${link}`, "Pesan disalin, tempel di chat")}>Salin pesan untuk pelanggan</button></div>
          )}
        </section>

        {notes.length > 0 && <section class="block"><h2>Catatan pelanggan</h2>{notes.map((n) => <div class="said" key={n.id}><span class="small muted">{fmtTime(n.created_at)}</span><br />{n.body}</div>)}</section>}

        <section class="block">
          <h2>{files.length} file</h2>
          {o.trashed_at && <p class="notice">File pesanan ini sudah dipindah ke Trash Google Drive pada {fmtTime(o.trashed_at)}.</p>}
          {!o.trashed_at && files.length === 0 && <p class="muted">Tidak ada file tersimpan di pesanan ini.</p>}
          {files.length > 0 && (
            <>
              <div class="actions" style={{ marginBottom: "0.9rem" }}>
                {files.length > 1 && <button class="btn" onClick={downloadAll}>Unduh semua</button>}
                {o.drive_folder_id && <a class="btn" target="_blank" rel="noreferrer" href={`https://drive.google.com/drive/folders/${o.drive_folder_id}`}>Buka di Drive</a>}
              </div>
              <ul class="files">{files.map((f) => (
                <li key={f.id}>
                  <Thumb f={f} open={() => setView(f)} />
                  <div><b>{f.name}</b><br /><span class="small muted">{formatBytes(f.size)}{f.completed_at ? `, ${fmtTime(f.completed_at)}` : ""}</span>{f.note && <p class="f-note">{f.note}</p>}</div>
                  <div class="f-act"><a class="btn" href={`/api/admin/files/${f.id}/download`} download={f.name}>Unduh<span class="vh"> {f.name}</span></a>{me.canDelete && <button class="link" onClick={() => setDel(f)}>Hapus<span class="vh"> {f.name}</span></button>}</div>
                </li>))}</ul>
            </>
          )}
          {going.length > 0 && <p class="muted" style={{ marginTop: "0.75rem" }}>{going.length} file belum selesai dikirim pelanggan: {going.map((f) => f.name).join(", ")}.</p>}
        </section>

        <section class="block">
          <label class="label" for="memo">Catatan toko <span class="muted" style={{ fontWeight: 400 }}>(tidak terlihat pelanggan)</span></label>
          <textarea id="memo" class="field" value={memo ?? o.admin_note} onInput={(e) => setMemo(e.currentTarget.value)} />
          <div class="actions" style={{ marginTop: "0.6rem" }}>
            <button class="btn" disabled={busy || memo === null || memo === o.admin_note} onClick={async () => { if (await patch({ adminNote: memo }, "Catatan disimpan")) setMemo(null); }}>Simpan catatan</button>
            <button class="btn" onClick={() => copy(link, "Link disalin")}>Salin link upload pesanan ini</button>
          </div>
        </section>
      </article>

      <Dialog open={renaming !== null} onClose={() => { setRenaming(null); setMergeId(""); }} label="Ubah nomor pesanan">
        <form onSubmit={async (e) => { e.preventDefault(); if (await patch({ orderNo: renaming }, "Nomor pesanan diubah")) setRenaming(null); }}>
          <h2>Ubah nomor pesanan</h2>
          <label class="label" for="rn" style={{ marginTop: "1rem" }}>Nomor yang benar</label>
          <input id="rn" class="field num" ref={focusOnce} value={renaming ?? ""} onInput={(e) => { setRenaming(normalizeOrderNo(e.currentTarget.value)); setMergeId(""); }} />
          {mergeId ? (
            <><p class="notice notice-red" style={{ margin: "0.9rem 0" }}>Nomor itu sudah ada. Gabungkan semua file dan catatan ke pesanan tersebut? Penggabungan tidak bisa dipisah lagi.</p>
              <div class="actions"><button type="button" class="btn btn-red" disabled={busy} onClick={async () => {
                setBusy(true);
                try { await call("POST", `/orders/${id}/merge`, { intoId: mergeId }); say("Pesanan digabung"); changed(); location.hash = `p/${mergeId}`; }
                catch (e) { say((e as Error).message); } finally { setBusy(false); }
              }}>Gabungkan pesanan</button><button type="button" class="btn" onClick={() => { setRenaming(null); setMergeId(""); }}>Batal</button></div></>
          ) : <div class="actions" style={{ marginTop: "1rem" }}><button class="btn btn-red" disabled={busy}>Simpan nomor</button><button type="button" class="btn" onClick={() => setRenaming(null)}>Batal</button></div>}
        </form>
      </Dialog>

      <Dialog open={!!del} onClose={() => setDel(null)} label="Hapus file">
        <h2>Pindahkan file ke Trash?</h2>
        <p style={{ margin: "0.75rem 0 1rem" }}><b>{del?.name}</b> hilang dari dashboard. Di Google Drive masih bisa dipulihkan dari Trash.</p>
        <div class="actions"><button class="btn btn-red" disabled={busy} onClick={async () => { if (await act(() => call("DELETE", `/files/${del!.id}`), "File dipindah ke Trash")) setDel(null); }}>Pindahkan ke Trash</button><button class="btn" ref={focusOnce} onClick={() => setDel(null)}>Batal</button></div>
      </Dialog>

      <Dialog open={!!view} onClose={() => setView(null)} label={`Pratinjau ${view?.name ?? ""}`}>
        <div class="preview-in"><img style={{ display: "block", maxWidth: "100%", maxHeight: "65dvh", margin: "0 auto 1rem" }} src={`/api/admin/files/${view?.id}/thumb?besar=1`} alt={`Pratinjau ${view?.name}`} />
          <p style={{ marginBottom: "0.75rem" }}><b>{view?.name}</b>{view?.note && <><br />{view.note}</>}</p>
          <div class="actions"><a class="btn btn-red" href={`/api/admin/files/${view?.id}/download`} download={view?.name}>Unduh file asli</a><button class="btn" onClick={() => setView(null)}>Tutup</button></div></div>
      </Dialog>
    </>
  );
}

function Thumb({ f, open }: { f: FileT; open: () => void }) {
  const [bad, setBad] = useState(false);
  if (bad) return <span class="thumb" aria-hidden="true">{extOf(f.name).toUpperCase()}</span>;
  return <button class="thumb" onClick={open} aria-label={`Pratinjau ${f.name}`}><img src={`/api/admin/files/${f.id}/thumb`} alt="" loading="lazy" onError={() => setBad(true)} /></button>;
}

type Staff = { email: string; can_delete: number };
type TeamData = { owners: string[]; staff: Staff[] };

function Team({ me, say }: { me: Me; say: (m: string) => void }) {
  const [team, setTeam] = useState<TeamData | null>(null);
  const [loadErr, setLoadErr] = useState("");
  const [email, setEmail] = useState("");
  const [addErr, setAddErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [drop, setDrop] = useState("");
  const loginUrl = `${me.appUrl}/admin/`;

  const load = () => call<TeamData>("GET", "/admins").then((t) => { setTeam(t); setLoadErr(""); }).catch((e) => setLoadErr(e.message));
  useEffect(() => { load(); }, []);

  async function add(e: Event) {
    e.preventDefault();
    setAddErr("");
    setBusy(true);
    try { await call("POST", "/admins", { email }); say(`${email.trim()} ditambahkan sebagai staf`); setEmail(""); await load(); }
    catch (x) { setAddErr((x as Error).message); }
    setBusy(false);
  }
  async function allowDelete(a: Staff, canDelete: boolean) {
    const show = (v: number) => setTeam((t) => t && { ...t, staff: t.staff.map((s) => (s.email === a.email ? { ...s, can_delete: v } : s)) });
    show(canDelete ? 1 : 0);
    setBusy(true);
    try { await call("PATCH", `/admins/${encodeURIComponent(a.email)}`, { canDelete }); say(canDelete ? `${a.email} boleh hapus file` : `${a.email} tidak boleh hapus file`); }
    catch (x) { show(a.can_delete); say((x as Error).message); }
    setBusy(false);
  }
  async function remove() {
    setBusy(true);
    try { await call("DELETE", `/admins/${encodeURIComponent(drop)}`); say("Akses dicabut"); setDrop(""); await load(); }
    catch (x) { say((x as Error).message); }
    setBusy(false);
  }

  return (
    <section class="block"><h2>Admin dan staf</h2>
      <p class="muted">Staf bisa melihat file dan mengubah status pesanan, tapi tidak bisa mengubah pengaturan toko. Izin menghapus file Anda atur per staf.</p>
      {loadErr && <p class="notice notice-red" role="alert">{loadErr} <button class="link" onClick={load}>Coba lagi</button></p>}
      {!team && !loadErr && <p role="status" class="muted">Memuat daftar...</p>}
      {team && (
        <ul class="staff">
          {team.owners.map((o) => <li key={o}><span><b>{o}</b><br /><span class="small muted">Admin (pemilik){o === me.email ? ", Anda" : ""}</span></span></li>)}
          {team.staff.map((a) => <li key={a.email}><span><b>{a.email}</b><br /><span class="small muted">Staf</span>
            <label class="check"><input type="checkbox" checked={a.can_delete === 1} disabled={busy} onChange={(e) => allowDelete(a, e.currentTarget.checked)} />Boleh hapus file<span class="vh"> untuk {a.email}</span></label></span><button class="link" onClick={() => setDrop(a.email)}>Cabut akses<span class="vh"> {a.email}</span></button></li>)}
        </ul>
      )}
      <form onSubmit={add}>
        <label class="label" for="em" style={{ marginTop: "0.9rem" }}>Tambah staf dengan email Google</label>
        <div class="row-form">
          <input id="em" class="field" type="email" required autocomplete="off" placeholder="email@contoh.com" value={email} aria-invalid={!!addErr} aria-describedby="em-err" onInput={(e) => { setEmail(e.currentTarget.value); setAddErr(""); }} />
          <button class="btn" disabled={busy}>Tambah staf</button>
        </div>
        <p id="em-err" class="err" role="alert">{addErr}</p>
      </form>
      <p class="small muted" style={{ marginTop: "0.5rem" }}>Tidak ada email undangan. Kirim alamat masuk ini ke staf: {loginUrl}</p>
      <button class="link" style={{ paddingLeft: 0 }} onClick={async () => say((await copyText(loginUrl)) ? "Alamat masuk disalin" : "Gagal menyalin, salin manual")}>Salin alamat masuk staf</button>

      <Dialog open={!!drop} onClose={() => setDrop("")} label="Cabut akses staf">
        <h2>Cabut akses staf?</h2>
        <p style={{ margin: "0.75rem 0 1rem" }}><b>{drop}</b> langsung keluar dari semua perangkat. Anda bisa menambahkannya lagi kapan saja.</p>
        <div class="actions"><button class="btn btn-red" disabled={busy} onClick={remove}>Cabut akses</button><button class="btn" ref={focusOnce} onClick={() => setDrop("")}>Batal</button></div>
      </Dialog>
    </section>
  );
}

function SettingsView({ me, reload, say }: { me: Me; reload: () => void; say: (m: string) => void }) {
  const [s, setS] = useState(me.settings);
  const [tpl, setTpl] = useState(me.settings.revisionTemplates.join("\n"));
  const [busy, setBusy] = useState(false);
  const [quota, setQuota] = useState<{ limit: number | null; usage: number } | null>(null);
  const [quotaErr, setQuotaErr] = useState("");
  useEffect(() => {
    if (me.drive.connected) call<{ limit: number | null; usage: number }>("GET", "/storage").then(setQuota).catch((e) => setQuotaErr(e.message));
  }, []);

  const pct = quota?.limit ? Math.min(100, (quota.usage / quota.limit) * 100) : 0;
  return (
    <div class="sheet set"><CropMarks />
      <h1 style={{ borderBottom: "3px solid var(--ink)", paddingBottom: "0.75rem" }}>Pengaturan</h1>

      <section class="block"><h2>Link untuk pelanggan</h2><p>{me.appUrl}</p>
        <p style={{ marginTop: "0.5rem" }}><button class="btn" onClick={async () => say((await copyText(me.appUrl)) ? "Link disalin" : "Gagal menyalin, salin manual")}>Salin link</button></p></section>

      {me.isOwner && <Team me={me} say={say} />}

      <section class="block"><h2>Google Drive</h2>
        {me.drive.connected && !me.drive.broken ? <p>Tersambung{me.drive.email ? ` ke ${me.drive.email}` : ""}.</p> : <p class="err">{me.drive.broken ? "Koneksi terputus." : "Belum tersambung."}</p>}
        {me.drive.connected && !quota && !quotaErr && <p class="muted" role="status">Memeriksa kuota...</p>}
        {quotaErr && <p class="err">{quotaErr}</p>}
        {quota && <>{quota.limit && <div class="quota" aria-hidden="true"><i style={{ width: `${pct}%` }} /></div>}<p>{formatBytes(quota.usage)} terpakai{quota.limit ? ` dari ${formatBytes(quota.limit)}` : ""}.</p></>}
        {me.isOwner && <p style={{ marginTop: "0.5rem" }}><a class="btn" href="/auth/drive">{me.drive.connected ? "Sambungkan ulang" : "Sambungkan Drive"}</a></p>}
        {!me.turnstile && <p class="notice" style={{ marginTop: "0.9rem" }}>Anti-bot (Turnstile) belum aktif. Pasang sebelum link dibagikan.</p>}
      </section>

      {me.isOwner && <>
        <form class="block" onSubmit={async (e) => { e.preventDefault(); setBusy(true); try { const n = await call<Settings>("PUT", "/settings", { ...s, revisionTemplates: tpl.split("\n") }); setS(n); setTpl(n.revisionTemplates.join("\n")); say("Pengaturan disimpan"); reload(); } catch (x) { say((x as Error).message); } setBusy(false); }}>
          <h2>Halaman upload</h2>
          <label class="label" for="sn">Nama toko</label><input id="sn" class="field" required maxLength={60} value={s.shopName} onInput={(e) => setS({ ...s, shopName: e.currentTarget.value })} />
          <label class="label" for="in" style={{ marginTop: "0.9rem" }}>Petunjuk untuk pelanggan <span class="muted" style={{ fontWeight: 400 }}>(opsional)</span></label><textarea id="in" class="field" maxLength={400} placeholder="Contoh: kirim PDF ukuran jadi, sisakan bleed 3 mm" value={s.intro} onInput={(e) => setS({ ...s, intro: e.currentTarget.value })} />
          <label class="label" for="mx" style={{ marginTop: "0.9rem" }}>Batas ukuran per file (MB)</label><input id="mx" class="field" type="number" inputMode="numeric" min={1} max={10240} value={s.maxFileMb} onInput={(e) => setS({ ...s, maxFileMb: Number(e.currentTarget.value) })} />
          <label class="label" for="at" style={{ marginTop: "0.9rem" }}>Pindahkan file pesanan selesai ke Trash setelah (hari)</label><input id="at" class="field" type="number" inputMode="numeric" min={0} max={3650} value={s.autoTrashDays} aria-describedby="ath" onInput={(e) => setS({ ...s, autoTrashDays: Number(e.currentTarget.value) })} />
          <p id="ath" class="small muted">Isi 0 untuk menyimpan terus. Google menghapus isi Trash setelah 30 hari.</p>
          <label class="label" for="tp" style={{ marginTop: "0.9rem" }}>Alasan revisi siap pakai</label>
          <textarea id="tp" class="field" rows={7} value={tpl} aria-describedby="tph" onInput={(e) => setTpl(e.currentTarget.value)} />
          <p id="tph" class="small muted">Satu alasan per baris, maksimal 15. Muncul sebagai pilihan saat Anda menandai pesanan Perlu revisi.</p>
          <p style={{ marginTop: "0.9rem" }}><button class="btn btn-red" disabled={busy}>Simpan pengaturan</button></p>
        </form>
      </>}

      <section class="block"><h2>Akun</h2><p>Masuk sebagai {me.email}.</p>
        <p style={{ marginTop: "0.5rem" }}><button class="btn" onClick={async () => { await fetch("/auth/logout", { method: "POST" }); location.href = "/admin/"; }}>Keluar</button></p></section>
    </div>
  );
}

render(<App />, document.getElementById("app")!);
