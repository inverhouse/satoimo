import { useEffect, useRef, type ReactNode } from "react";

export function Modal({ title, children, confirmLabel, destructive, onConfirm, onCancel }: { title: string; children: ReactNode; confirmLabel: string; destructive?: boolean; onConfirm: () => void; onCancel: () => void }) {
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const focusable = dialog.current?.querySelector<HTMLElement>("button");
    focusable?.focus();
    const key = (event: KeyboardEvent) => event.key === "Escape" && onCancel();
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onCancel]);
  return <div className="modal-backdrop" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
    <div className="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title" ref={dialog}>
      <h2 id="modal-title">{title}</h2>
      <div className="modal-copy">{children}</div>
      <div className="modal-actions"><button className="button subtle" onClick={onCancel}>キャンセル</button><button className={`button ${destructive ? "danger" : "primary"}`} onClick={onConfirm}>{confirmLabel}</button></div>
    </div>
  </div>;
}
