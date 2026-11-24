// Uji ujung ke ujung terhadap wrangler dev + server Google tiruan.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomBytes, createHash } from "node:crypto";
const B = process.env.APP ?? "http://localhost:8787", G = process.env.MOCK ?? "http://localhost:8799";
const OWNER = /^OWNER_EMAILS=([^,\n]+)/m.exec(readFileSync(new URL("../.dev.vars", import.meta.url), "utf8"))[1].trim();
let cookie = "";
const sha = (b) => createHash("sha256").update(b).digest("hex");
const J = (r) => r.json();
const step = (m) => console.log("ok  ", m);

async function login(email, path = "/auth/login", jar = "") {
  const r1 = await fetch(B + path, { redirect: "manual", headers: { cookie: jar } });
  if (!r1.headers.get("location").startsWith(G)) return { jar, to: r1.headers.get("location") };
  const oc = r1.headers.getSetCookie()[0].split(";")[0];
  const state = new URL(r1.headers.get("location")).searchParams.get("state");
  const r2 = await fetch(`${B}/auth/callback?code=${email}&state=${state}`, { redirect: "manual", headers: { cookie: `${jar}; ${oc}` } });
  const s = r2.headers.getSetCookie().find((c) => c.startsWith("jp_session"));
  return { jar: s ? s.split(";")[0] : jar, to: r2.headers.get("location") };
}
const adm = (m, p, body, h = {}) => fetch(`${B}/api/admin${p}`, { method: m, headers: { cookie, origin: B, "content-type": "application/json", ...h }, body: body && JSON.stringify(body) });
const start = (orderNo, note = "") => fetch(`${B}/api/start`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ orderNo, note }) });
const meta = (t, f) => fetch(`${B}/api/files`, { method: "POST", headers: { authorization: `Bearer ${t}`, "content-type": "application/json" }, body: JSON.stringify(f) });
async function upload(t, name, buf, note = "", hook) {
  let s = await J(await meta(t, { name, size: buf.length, mime: "application/pdf", note, modified: 1 }));
  for (let i = 0; !s.done; i++) {
    assert(i < 200);
    if (hook) await hook(i, s);
    const part = buf.subarray(s.offset, s.offset + 4194304);
    const r = await fetch(`${B}/api/files/${s.id}`, { method: "PUT", headers: { authorization: `Bearer ${t}`, "content-range": `bytes ${s.offset}-${s.offset + part.length - 1}/${buf.length}` }, body: part });
    s = r.ok ? await J(r) : await J(await fetch(`${B}/api/files/${s.id}`, { headers: { authorization: `Bearer ${t}` } }));
  }
  return s;
}
const state = async () => J(await fetch(`${G}/__state`));

assert.equal((await fetch(`${B}/api/admin/me`)).status, 401); step("dashboard tertutup tanpa login");
assert.match((await login("asing@example.test")).to, /e=akses/); step("email asing ditolak");
assert.match((await login("x", "/auth/drive")).to, /e=owner/); step("sambung Drive butuh login pemilik");
const bad = await fetch(`${B}/auth/callback?code=${OWNER}&state=palsu.palsu`, { redirect: "manual" });
assert.match(bad.headers.get("location"), /e=state/); step("state OAuth palsu ditolak");
cookie = (await login(OWNER)).jar; assert.match(cookie, /jp_session/); step("pemilik masuk");
if (!(await J(await adm("GET", "/me"))).drive.connected) { assert.equal((await start("241124NODRIVE1")).status, 503); step("tanpa Drive: pesan jelas 503"); }
cookie = (await login(OWNER, "/auth/drive", cookie)).jar;
assert.equal((await J(await adm("GET", "/me"))).drive.connected, true); step("Drive tersambung");
assert.equal((await adm("PUT", "/settings", { shopName: "X" }, { origin: "https://jahat.test" })).status, 403); step("permintaan lintas situs ditolak");

const no = "261124" + randomBytes(4).toString("hex").toUpperCase();
assert.equal((await start("abc")).status, 400);
const { token } = await J(await start(no.toLowerCase(), "Tolong potong rapi"));
assert.equal((await meta("palsu", { name: "a.pdf", size: 1 })).status, 401); step("token palsu ditolak");
assert.equal((await meta(token, { name: "a.exe", size: 5 })).status, 400);
assert.equal((await meta(token, { name: "a.pdf", size: 0 })).status, 400);
assert.equal((await meta(token, { name: "a.pdf", size: 9e12 })).status, 400); step("jenis dan ukuran file dibatasi");

const big = randomBytes(13 * 1048576 + 77);
const up = await upload(token, "banner besar.pdf", big, "cetak 2 lembar");
let st = await state();
let f = st.find((x) => x.name === "banner besar.pdf" && x.size === big.length);
assert.equal(sha(Buffer.from(await (await fetch(`${G}/__raw/${f.id}`)).arrayBuffer())), sha(big)); step("13 MB lewat sinyal buruk, isi identik");
assert.equal((await J(await meta(token, { name: "banner besar.pdf", size: big.length, modified: 1 }))).done, true); step("file yang sama tidak dobel");
const mid = randomBytes(9 * 1048576);
await upload(token, "sesi.pdf", mid, "", async (i) => { if (i === 1) await fetch(`${G}/__expire`); });
f = (await state()).find((x) => x.name === "sesi.pdf" && x.size === mid.length);
assert.equal(sha(Buffer.from(await (await fetch(`${G}/__raw/${f.id}`)).arrayBuffer())), sha(mid)); step("sesi Drive kedaluwarsa diulang otomatis");
const other = await J(await start("261124" + randomBytes(4).toString("hex").toUpperCase()));
assert.equal((await fetch(`${B}/api/files/${up.id}`, { headers: { authorization: `Bearer ${other.token}` } })).status, 404); step("token pesanan lain tidak bisa melihat file");

assert.equal((await J(await fetch(`${B}/api/finish`, { method: "POST", headers: { authorization: `Bearer ${token}` } }))).fileCount, 2);
await new Promise((r) => setTimeout(r, 1500));
st = await state();
const folder = st.find((x) => x.name === no);
const txt = st.find((x) => x.name === "CATATAN.txt" && x.parents[0] === folder.id);
assert.match(txt.text, /Tolong potong rapi[\s\S]*banner besar\.pdf:[\s\S]*cetak 2 lembar/); step("CATATAN.txt berisi dua jenis catatan");
const pub = await J(await fetch(`${B}/api/status?no=${no}`));
assert.deepEqual([pub.found, pub.status, pub.fileCount, "files" in pub], [true, "baru", 2, false]); step("status publik tidak membuka nama file");

const list = await J(await adm("GET", `/orders?q=${no}`));
const id = list.orders[0].id;
const dl = await fetch(`${B}/api/admin/files/${up.id}/download`, { headers: { cookie } });
assert.equal(sha(Buffer.from(await dl.arrayBuffer())), sha(big));
assert.match(dl.headers.get("content-disposition"), /^attachment/); step("unduhan admin identik");
assert.equal((await adm("PATCH", `/orders/${id}`, { status: "revisi" })).status, 400);
assert.equal((await adm("PATCH", `/orders/${id}`, { status: "revisi", revisionNote: "Bleed kurang" })).status, 200);
assert.equal((await J(await fetch(`${B}/api/status?no=${no}`))).revisionNote, "Bleed kurang");
await upload(token, "revisi.pdf", randomBytes(1000));
assert.equal((await J(await fetch(`${B}/api/status?no=${no}`))).status, "baru"); step("alur revisi kembali ke Baru");

const typo = no.slice(0, -1) + "Z";
const t2 = (await J(await start(typo, "salah ketik"))).token;
await upload(t2, "banner besar.pdf", big.subarray(0, 5000));
const tid = (await J(await adm("GET", `/orders?q=${typo}`))).orders[0].id;
const ex = await adm("PATCH", `/orders/${tid}`, { orderNo: no });
assert.equal(ex.status, 409);
assert.equal((await adm("POST", `/orders/${tid}/merge`, { intoId: (await J(ex)).otherId })).status, 200);
const d = await J(await adm("GET", `/orders/${id}`));
assert.deepEqual([d.files.length, d.notes.length], [4, 2]);
const ids = new Set(d.files.map((x) => x.drive_file_id));
assert((await state()).filter((x) => ids.has(x.id)).every((x) => x.parents[0] === folder.id)); step("gabung pesanan salah ketik, file pindah folder");
const no2 = "261125" + randomBytes(4).toString("hex").toUpperCase();
assert.equal((await adm("PATCH", `/orders/${id}`, { orderNo: no2 })).status, 200);
assert((await state()).some((x) => x.id === folder.id && x.name === no2)); step("ubah nomor, folder Drive ikut");
assert.equal((await adm("DELETE", `/files/${up.id}`)).status, 200);
assert((await state()).some((x) => x.id === d.files.find((y) => y.id === up.id).drive_file_id && x.trashed)); step("hapus file masuk Trash");

assert.equal((await adm("POST", "/admins", { email: OWNER })).status, 409); step("pemilik tidak bisa dijadikan staf");
await adm("POST", "/admins", { email: "staf@example.test" });
const team = await J(await adm("GET", "/admins"));
assert(team.owners.includes(OWNER) && team.staff.some((x) => x.email === "staf@example.test")); step("daftar tim memuat pemilik dan staf");
const own = cookie; cookie = (await login("staf@example.test")).jar;
assert.equal((await adm("GET", "/orders")).status, 200);
assert.equal((await adm("PUT", "/settings", {})).status, 403); assert.equal((await adm("GET", "/admins")).status, 403); step("staf bisa kerja, tidak bisa atur");
const asOwner = async (fn) => { const keep = cookie; cookie = own; const r = await fn(); cookie = keep; return r; };
const victim = d.files.find((x) => x.name === "revisi.pdf").id;
assert.equal((await adm("DELETE", `/files/${victim}`)).status, 403);
assert.equal((await adm("PATCH", "/admins/staf%40example.test", { canDelete: true })).status, 403); step("staf baru tidak bisa hapus, tidak bisa memberi izin sendiri");
assert.equal((await asOwner(() => adm("PATCH", "/admins/staf%40example.test", { canDelete: true }))).status, 200);
assert.equal((await J(await adm("GET", "/me"))).canDelete, true);
assert.equal((await adm("DELETE", `/files/${victim}`)).status, 200); step("izin hapus langsung berlaku");
await asOwner(() => adm("PATCH", "/admins/staf%40example.test", { canDelete: false }));
assert.equal((await adm("DELETE", `/files/${d.files.find((x) => x.name === "sesi.pdf").id}`)).status, 403); step("izin dicabut langsung berlaku");
assert.equal((await asOwner(() => adm("PATCH", "/admins/tidakada%40example.test", { canDelete: true }))).status, 404);
const staffCookie = cookie; cookie = own;
await adm("DELETE", "/admins/staf%40example.test"); cookie = staffCookie;
assert.equal((await adm("GET", "/orders")).status, 401); step("staf dicabut langsung keluar"); cookie = own;

const bulkNos = ["261127BULKA001", "261127BULKB002"];
for (const n of bulkNos) await upload((await J(await start(n))).token, "x.pdf", randomBytes(100));
const bulkIds = await Promise.all(bulkNos.map(async (n) => (await J(await adm("GET", `/orders?q=${n}`))).orders[0].id));
assert.equal((await adm("POST", "/orders/bulk", { ids: bulkIds, status: "revisi" })).status, 400);
assert.equal((await adm("POST", "/orders/bulk", { ids: [], status: "cetak" })).status, 400);
assert.equal((await J(await adm("POST", "/orders/bulk", { ids: [...bulkIds, "tidak-ada"], status: "selesai" }))).changed, 2);
assert.equal((await J(await adm("POST", "/orders/bulk", { ids: bulkIds, status: "selesai" }))).changed, 0);
assert((await Promise.all(bulkIds.map(async (i) => (await J(await adm("GET", `/orders/${i}`))).order))).every((o) => o.status === "selesai" && o.finished_at)); step("ubah status banyak pesanan, revisi ditolak");
const keepTpl = (await J(await adm("GET", "/me"))).settings.revisionTemplates;
assert(keepTpl.length > 0);
const saved = await J(await adm("PUT", "/settings", { revisionTemplates: [" Bleed kurang ", "", "Bleed kurang", "x".repeat(300)] }));
assert.deepEqual(saved.revisionTemplates, ["Bleed kurang", "x".repeat(200)]);
assert.deepEqual((await J(await adm("PUT", "/settings", { shopName: "Juartah Printing" }))).revisionTemplates, saved.revisionTemplates);
await adm("PUT", "/settings", { revisionTemplates: keepTpl }); step("template revisi disimpan rapi");

const par = await Promise.all(Array.from({ length: 4 }, () => start("261126" + "PARALEL1")));
assert(par.every((r) => r.status === 200));
assert.equal((await state()).filter((x) => x.name === "261126PARALEL1" && !x.trashed).length, 1); step("permintaan bersamaan tetap satu folder");
await fetch(`${B}/__scheduled?cron=17+*+*+*+*`); step("cron jalan");
console.log("SEMUA LULUS");
