import type { ComponentChildren } from "preact";
import { useLayoutEffect, useRef } from "preact/hooks";

export const CropMarks = () => (
  <>{["tl", "tr", "bl", "br"].map((k) => <span key={k} class={`crop ${k}`} aria-hidden="true" />)}</>
);

export function Dialog({ open, onClose, children, label, wide }: { open: boolean; onClose: () => void; children: ComponentChildren; label: string; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const downOutside = useRef(false);
  // Tutup hanya kalau tekan dan lepas sama-sama di luar kotak, supaya geseran yang lepas di luar tidak menutup dialog.
  const outside = (e: MouseEvent) => {
    const r = ref.current!.getBoundingClientRect();
    return e.target === ref.current && (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom);
  };
  // Dibuka sebelum focusOnce berjalan, supaya fokus bawaan showModal tidak menimpanya.
  useLayoutEffect(() => {
    const d = ref.current!;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} class={wide ? "wide" : undefined} aria-label={label} onClose={onClose}
      onPointerDown={(e) => (downOutside.current = outside(e))} onClick={(e) => downOutside.current && outside(e) && onClose()}>
      {open && children}
    </dialog>
  );
}

const focused = new WeakSet<HTMLElement>();
/** Atribut autofocus tidak berlaku untuk elemen yang muncul belakangan, jadi fokus dipindah sendiri, sekali saja. */
export function focusOnce(el: HTMLElement | null) {
  if (el && !focused.has(el)) { focused.add(el); setTimeout(() => el.focus()); }
}

export const fmtTime = (t: number) =>
  new Date(t).toLocaleString("id-ID", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

export async function copyText(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}
