"use client";

import { AnimatePresence, motion } from "framer-motion";
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { EXPLORER_NAME, explorerTx } from "@/lib/explorer";

type Kind = "pending" | "confirmed" | "failed" | "info";

type Toast = {
  id: number;
  kind: Kind;
  title: string;
  detail?: string;
  hash?: string;
};

type Ctx = {
  /// Shows a toast and returns its id, so a pending toast can be promoted to
  /// confirmed or failed in place rather than stacking three boxes up.
  push: (t: Omit<Toast, "id">) => number;
  update: (id: number, t: Partial<Omit<Toast, "id">>) => void;
  dismiss: (id: number) => void;
};

const ToastCtx = createContext<Ctx | null>(null);

/// Toasts live above the app so any screen can report a transaction without
/// threading callbacks through every component.
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(1);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    setToasts((t) => t.filter((x) => x.id !== id));
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  /// Pending toasts stay until something replaces them; the rest time out.
  const autoDismiss = useCallback(
    (id: number, kind: Kind) => {
      const existing = timers.current.get(id);
      if (existing) clearTimeout(existing);
      timers.current.delete(id);
      if (kind === "pending") return;
      timers.current.set(
        id,
        setTimeout(() => dismiss(id), kind === "failed" ? 9_000 : 5_000),
      );
    },
    [dismiss],
  );

  const push = useCallback(
    (t: Omit<Toast, "id">) => {
      const id = next.current++;
      setToasts((prev) => [...prev.slice(-2), { ...t, id }]);
      autoDismiss(id, t.kind);
      return id;
    },
    [autoDismiss],
  );

  const update = useCallback(
    (id: number, patch: Partial<Omit<Toast, "id">>) => {
      setToasts((prev) => prev.map((x) => (x.id === id ? { ...x, ...patch } : x)));
      if (patch.kind) autoDismiss(id, patch.kind);
    },
    [autoDismiss],
  );

  const ctx = useMemo(() => ({ push, update, dismiss }), [push, update, dismiss]);

  return (
    <ToastCtx.Provider value={ctx}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 bottom-24 z-[70] mx-auto flex max-w-md flex-col gap-2 px-4">
        <AnimatePresence initial={false}>
          {toasts.map((t) => (
            <motion.div
              key={t.id}
              layout
              initial={{ opacity: 0, y: 16, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 8, scale: 0.97 }}
              transition={{ type: "spring", stiffness: 420, damping: 32 }}
              className={`pointer-events-auto rounded-card border p-3 ${toneOf(t.kind)}`}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="flex items-center text-xs leading-tight font-semibold">
                    {t.kind === "pending" && <Spinner />}
                    {t.title}
                  </p>
                  {t.detail && (
                    <p className="mt-1 text-[11px] leading-snug break-words text-secondary">
                      {t.detail}
                    </p>
                  )}
                  {t.hash && (
                    <a
                      href={explorerTx(t.hash)}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-1 inline-block text-[11px] text-accent underline underline-offset-2"
                    >
                      {`view on ${EXPLORER_NAME} ↗`}
                    </a>
                  )}
                </div>
                <button
                  onClick={() => dismiss(t.id)}
                  aria-label="Dismiss"
                  className="text-sm leading-none text-secondary hover:text-text"
                >
                  ✕
                </button>
              </div>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </ToastCtx.Provider>
  );
}

/// Tinted fills rather than saturated ones: a toast sits over content, and a
/// solid green slab reads as a price move rather than a notification.
function toneOf(k: Kind) {
  return {
    pending: "bg-surface border-accent/40 text-text",
    confirmed: "bg-profit-dim border-profit/40 text-profit",
    failed: "bg-loss-dim border-loss/40 text-loss",
    info: "bg-surface border-border text-text",
  }[k];
}

function Spinner() {
  return (
    <span
      aria-hidden
      className="mr-2 inline-block h-3 w-3 shrink-0 animate-spin rounded-pill border-2 border-accent border-t-transparent"
    />
  );
}

export function useToast(): Ctx {
  const c = useContext(ToastCtx);
  // A no-op fallback keeps a component usable outside the provider (and in
  // tests) instead of crashing the whole screen over a notification.
  return (
    c ?? {
      push: () => 0,
      update: () => {},
      dismiss: () => {},
    }
  );
}
