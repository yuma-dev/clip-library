import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import Modal from "./Modal";

interface ConfirmOptions {
  title?: string;
  message: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

type AlertOptions = Omit<ConfirmOptions, "cancelLabel" | "danger">;

interface ConfirmApi {
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  alert: (options: AlertOptions) => Promise<void>;
}

const ConfirmContext = createContext<ConfirmApi | null>(null);

/** Imperative confirm/alert (replaces the legacy `#custom-modal`). */
export function useConfirm(): ConfirmApi {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error("useConfirm must be used within <ConfirmProvider>");
  return ctx;
}

type ActiveState = (ConfirmOptions & { alertOnly?: boolean }) | null;

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<ActiveState>(null);
  const resolver = useRef<((result: boolean) => void) | null>(null);

  const close = useCallback((result: boolean) => {
    resolver.current?.(result);
    resolver.current = null;
    setState(null);
  }, []);

  const confirm = useCallback(
    (options: ConfirmOptions) =>
      new Promise<boolean>((resolve) => {
        resolver.current = resolve;
        setState(options);
      }),
    [],
  );

  const alert = useCallback(
    (options: AlertOptions) =>
      new Promise<void>((resolve) => {
        resolver.current = () => resolve();
        setState({ ...options, alertOnly: true, confirmLabel: options.confirmLabel ?? "OK" });
      }),
    [],
  );

  const api = useMemo(() => ({ confirm, alert }), [confirm, alert]);

  return (
    <ConfirmContext.Provider value={api}>
      {children}
      <Modal open={state !== null} onClose={() => close(false)} title={state?.title}>
        <p className="confirm-message">{state?.message}</p>
        <div className="modal-actions">
          {!state?.alertOnly ? (
            <button type="button" className="btn btn-ghost" onClick={() => close(false)}>
              {state?.cancelLabel ?? "Cancel"}
            </button>
          ) : null}
          <button
            type="button"
            className={`btn ${state?.danger ? "btn-danger" : "btn-primary"}`}
            onClick={() => close(true)}
          >
            {state?.confirmLabel ?? "Confirm"}
          </button>
        </div>
      </Modal>
    </ConfirmContext.Provider>
  );
}
