"use client";

import {
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { uiZoom } from "./uiZoom";

// Position must be measured before paint to avoid a flash: on the server, fall back to useEffect.
const useIsoLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

type Coords = { top: number; left: number };

export type PopoverProps<T extends HTMLElement = HTMLElement> = {
  /** The element the popover is anchored to. */
  anchorRef: RefObject<T | null>;
  /** Optional virtual anchor, for a caret or another point inside the anchor element. */
  getAnchorRect?: () => DOMRect | null;
  open: boolean;
  onClose: () => void;
  /** Preferred side; the popover flips/shifts to stay in the viewport. */
  placement?: "top" | "bottom";
  /** Horizontal edge of the anchor to align to. */
  align?: "start" | "end";
  children: ReactNode;
};

const MARGIN = 8;
const GAP = 6;

/**
 * A floating layer, portaled to the body and positioned with viewport-aware coordinates so it
 * never overflows: it flips between top/bottom depending on room, and clamps horizontally.
 * Closes on outside click or Escape.
 */
export function Popover<T extends HTMLElement = HTMLElement>({
  anchorRef,
  getAnchorRect,
  open,
  onClose,
  placement = "top",
  align = "start",
  children,
}: PopoverProps<T>) {
  const contentRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<Coords | null>(null);

  const compute = useCallback(() => {
    const anchorRect = getAnchorRect?.() ?? anchorRef.current?.getBoundingClientRect();
    const content = contentRef.current?.getBoundingClientRect();
    if (!anchorRect) return;
    // Convert measured (visual) rects and the viewport to unzoomed layout space so the fixed top/left
    // we set render correctly under the text-size zoom (see uiZoom). A no-op at the default zoom of 1.
    const z = uiZoom();
    const anchor = { top: anchorRect.top / z, bottom: anchorRect.bottom / z, left: anchorRect.left / z, right: anchorRect.right / z };
    const cw = (content?.width ?? 320) / z;
    const ch = (content?.height ?? 280) / z;
    const vw = window.innerWidth / z;
    const vh = window.innerHeight / z;

    const roomAbove = anchor.top;
    const roomBelow = vh - anchor.bottom;
    const wantAbove = placement === "top";
    const fitsAbove = roomAbove >= ch + GAP + MARGIN;
    const fitsBelow = roomBelow >= ch + GAP + MARGIN;
    const above = wantAbove ? fitsAbove || !fitsBelow : !(fitsBelow || !fitsAbove);

    let top = above ? anchor.top - ch - GAP : anchor.bottom + GAP;
    top = Math.max(MARGIN, Math.min(top, vh - ch - MARGIN));

    let left = align === "end" ? anchor.right - cw : anchor.left;
    left = Math.max(MARGIN, Math.min(left, vw - cw - MARGIN));

    // Keep the same reference when unchanged: the layout effect runs every render, and a fresh object
    // each time would re-render endlessly.
    setPos((prev) => (prev && prev.top === top && prev.left === left ? prev : { top, left }));
  }, [anchorRef, getAnchorRect, placement, align]);

  // Measure before paint on every render while open, so a list that grows or shrinks stays anchored
  // to the input with no stale-position flash frame.
  useIsoLayoutEffect(() => {
    if (open) compute();
    else setPos(null);
  });

  // Keep it anchored on viewport changes and on async content resizes (e.g. an image loading).
  useEffect(() => {
    if (!open) return;
    window.addEventListener("resize", compute);
    window.addEventListener("scroll", compute, true);
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => compute()) : null;
    if (ro && contentRef.current) ro.observe(contentRef.current);
    return () => {
      window.removeEventListener("resize", compute);
      window.removeEventListener("scroll", compute, true);
      ro?.disconnect();
    };
  }, [open, compute]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (contentRef.current?.contains(t) || anchorRef.current?.contains(t)) return;
      // A popover opened from this one (a picker inside a bubble) is portaled apart from it: a click
      // in there is not a click outside.
      if (t instanceof Element && t.closest(".wc-pop")) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose, anchorRef]);

  if (!open || typeof document === "undefined") return null;

  const origin = `${placement === "top" ? "bottom" : "top"} ${align === "end" ? "right" : "left"}`;

  return createPortal(
    <div
      ref={contentRef}
      className={pos ? "wc-pop" : undefined}
      style={{
        position: "fixed",
        top: pos?.top ?? 0,
        left: pos?.left ?? 0,
        // Above a dialog's scrim (90): a popover is always opened from the topmost layer, which may be a
        // dialog.
        zIndex: 95,
        visibility: pos ? "visible" : "hidden",
        // @ts-expect-error CSS custom property
        "--wc-pop-origin": origin,
      }}
    >
      {children}
    </div>,
    document.body,
  );
}
