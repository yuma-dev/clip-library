import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

interface PopoverProps {
  open: boolean;
  onClose: () => void;
  anchorRef: RefObject<HTMLElement | null>;
  children: ReactNode;
  /** Horizontal edge to align with the anchor. */
  align?: "start" | "end";
  gap?: number;
}

/**
 * Anchored, viewport-aware popover (positioning generalized from Hynite's
 * GameContextMenu). Clamps to the viewport with an 8px margin and flips above
 * the anchor if it would overflow the bottom. Dismisses on Escape, outside
 * pointer-down, scroll, and resize. Render menu content (e.g. <MenuList/>) as
 * children.
 */
export default function Popover({ open, onClose, anchorRef, children, align = "start", gap = 6 }: PopoverProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: -9999, top: -9999 });

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const anchor = anchorRef.current;
      const el = ref.current;
      if (!anchor) return;
      const a = anchor.getBoundingClientRect();
      const margin = 8;
      const w = el?.offsetWidth ?? 220;
      const h = el?.offsetHeight ?? 0;
      let left = align === "end" ? a.right - w : a.left;
      let top = a.bottom + gap;
      left = Math.max(margin, Math.min(left, window.innerWidth - w - margin));
      if (top + h > window.innerHeight - margin) {
        top = Math.max(margin, a.top - gap - h);
      }
      setPos({ left, top });
    };
    place();
    const raf = requestAnimationFrame(place);
    return () => cancelAnimationFrame(raf);
  }, [open, anchorRef, align, gap]);

  useEffect(() => {
    if (!open) return;
    const close = () => onClose();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (ref.current?.contains(target)) return;
      if (anchorRef.current?.contains(target)) return;
      onClose();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [open, onClose, anchorRef]);

  return createPortal(
    <AnimatePresence>
      {open ? (
        <motion.div
          ref={ref}
          className="popover"
          style={{ left: pos.left, top: pos.top }}
          initial={{ opacity: 0, y: -4, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -4 }}
          transition={{ duration: 0.12 }}
        >
          {children}
        </motion.div>
      ) : null}
    </AnimatePresence>,
    document.body,
  );
}
