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
import { explorerTx } from "@/lib/chain";

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
              className={`nb-sm pointer-events-auto p-3 ${toneOf(t.kind)}`}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-display text-xs uppercase leading-tight">
                    {t.kind === "pending" && <Spinner />}
                    {t.title}
                  </p>
                  {t.detail && (
                    <p className="mt-1 break-words font-mono text-[10px] leading-snug opacity-80">
                      {t.detail}
                    </p>
                  )}
                  {t.hash && (
                    <a
                      href={explorerTx(t.hash)}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-1 inline-block font-mono text-[10px] underline"
                    >
                      view on explorer ↗
                    </a>
                  )}
                </div>
                <button
                  onClick={() => dismiss(t.id)}
                  aria-label="Dismiss"
                  className="font-display text-sm leading-none opacity-60 hover:opacity-100"
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

function toneOf(k: Kind) {
  return {
    pending: "bg-info text-white",
    confirmed: "bg-profit",
    failed: "bg-loss text-white",
    info: "bg-white",
  }[k];
}

function Spinner() {
  return (
    <span
      aria-hidden
      className="mr-1.5 inline-block h-2.5 w-2.5 animate-spin border-2 border-white border-t-transparent align-[-1px]"
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
