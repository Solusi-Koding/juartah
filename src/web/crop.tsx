import Cropper from "cropperjs";
import "cropperjs/dist/cropper.css";
import "./crop.css";
import { useEffect, useRef, useState } from "preact/hooks";
import { extOf } from "../shared";
import { CROP_TYPES as TYPES } from "./filecheck";

// Batas kanvas Safari di iPhone. Di atas ini hasilnya kosong tanpa pesan error.
const MAX_AREA = 16_777_216;
const RATIOS: [string, number][] = [["Bebas", NaN], ["Persegi", 1], ["A4/A3 tegak", 210 / 297], ["A4/A3 mendatar", 297 / 210]];
const GOOD_DPI = 150;

function croppedName(name: string): string {
  const i = name.lastIndexOf(".");
  const base = name.slice(0, i).replace(/ \(dipotong\)$/, "");
  return `${base} (dipotong)${name.slice(i)}`;
}

export function CropView({ file, onDone, onCancel }: { file: File; onDone: (f: File) => void; onCancel: () => void }) {
  const img = useRef<HTMLImageElement>(null);
  const cropper = useRef<Cropper | null>(null);
  const [url] = useState(() => URL.createObjectURL(file));
  const [ready, setReady] = useState(false);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [ratio, setRatio] = useState(NaN);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    const c = new Cropper(img.current!, {
      viewMode: 1, dragMode: "none", autoCropArea: 1, zoomable: false, movable: false, rotatable: false, scalable: false,
      checkOrientation: false, toggleDragModeOnDblclick: false, background: false,
      ready: () => setReady(true),
      // Dibulatkan sama seperti saat menyimpan, supaya angka di layar sama dengan hasil.
      crop: () => { const d = cropper.current?.getData(true); if (!d) return; setSize({ w: d.width, h: d.height }); setErr(""); },
    });
    cropper.current = c;
    return () => { c.destroy(); URL.revokeObjectURL(url); };
  }, []);

  function pickRatio(r: number) { setRatio(r); cropper.current?.setAspectRatio(r); }

  function save() {
    const c = cropper.current!;
    const d = c.getData(true);
    const full = c.getImageData();
    if (d.x <= 0 && d.y <= 0 && d.width >= full.naturalWidth - 1 && d.height >= full.naturalHeight - 1) return onCancel();
    if (d.width * d.height > MAX_AREA) return setErr("Bagian yang dipilih terlalu besar untuk dipotong di perangkat ini. Kirim file apa adanya, lalu tulis bagian yang mau dicetak di catatan.");
    setBusy(true);
    const type = TYPES[extOf(file.name)];
    // Biarkan tulisan "Memproses" tampil dulu, karena menyimpan gambar besar bisa beberapa detik.
    setTimeout(() => {
      const canvas = c.getCroppedCanvas({ imageSmoothingEnabled: true, imageSmoothingQuality: "high" });
      canvas.toBlob((blob) => {
        setBusy(false);
        if (!blob) return setErr("Gambar gagal dipotong. Kirim file apa adanya, lalu tulis bagian yang mau dicetak di catatan.");
        onDone(new File([blob], croppedName(file.name), { type, lastModified: Date.now() }));
      }, type, 0.95);
    }, 30);
  }

  const cm = (px: number) => Math.max(1, Math.round((px / GOOD_DPI) * 2.54));
  return (
    <div class="cropping">
      <h2>Potong gambar</h2>
      <p class="small muted" style={{ margin: "0.25rem 0 0.75rem" }}>Geser kotak atau tarik sudutnya. File asli tetap bisa dikembalikan.</p>
      <div class="chips" role="group" aria-label="Bentuk potongan">
        {RATIOS.map(([label, r]) => (
          <button type="button" key={label} class="chip" disabled={!ready} aria-pressed={Object.is(ratio, r)} onClick={() => pickRatio(r)}>{label}</button>
        ))}
      </div>
      <div class="cropbox"><div class="cropstage"><img ref={img} src={url} alt={`Gambar ${file.name}`} /></div></div>
      <p class="small" role="status" style={{ marginTop: "0.5rem" }}>
        {size ? <>Hasil: {size.w} × {size.h} px, tajam sampai sekitar {cm(size.w)} × {cm(size.h)} cm.</> : "Memuat gambar..."}
      </p>
      {err && <p class="err small" role="alert">{err}</p>}
      <div class="actions" style={{ marginTop: "0.75rem" }}>
        <button type="button" class="btn btn-red" disabled={!ready || busy} onClick={save}>{busy ? "Memproses..." : "Pakai potongan"}</button>
        <button type="button" class="btn" disabled={busy} onClick={onCancel}>Batal</button>
      </div>
    </div>
  );
}
