// Small UI kit for the admin: buttons, dialogs, toasts and form fields.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from 'react';

/* ---------- Buttons ---------- */

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  busy?: boolean;
  size?: 'sm' | 'md';
};

export function Button({ variant = 'secondary', busy = false, size = 'md', className = '', children, disabled, ...rest }: ButtonProps) {
  return (
    <button
      type="button"
      className={`adm-btn adm-btn--${variant} adm-btn--${size} ${className}`}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      {...rest}
    >
      {busy && <span className="adm-spinner" aria-hidden="true" />}
      {children}
    </button>
  );
}

export const Spinner = ({ label }: { label: string }) => (
  <div className="adm-loading" role="status">
    <span className="adm-spinner adm-spinner--lg" aria-hidden="true" />
    {label}
  </div>
);

/* ---------- Dialogs ---------- */

type DialogProps = {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  actions?: ReactNode;
  wide?: boolean;
};

/** Native <dialog>: focus trapping, Esc to close and the backdrop come from the browser. */
export function Dialog({ open, title, onClose, children, actions, wide }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className={`adm-dialog ${wide ? 'adm-dialog--wide' : ''}`}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      {open && (
        <>
          <h2 id={titleId} className="adm-dialog__title">
            {title}
          </h2>
          <div className="adm-dialog__body">{children}</div>
          {actions && <div className="adm-dialog__actions">{actions}</div>}
        </>
      )}
    </dialog>
  );
}

type ConfirmOptions = { title: string; message: ReactNode; confirmLabel: string; cancelLabel?: string; danger?: boolean };
type ConfirmState = ConfirmOptions & { resolve: (ok: boolean) => void };

const ConfirmContext = createContext<(o: ConfirmOptions) => Promise<boolean>>(async () => false);

/** `const ok = await confirm({...})` from anywhere in the admin. */
export const useConfirm = () => useContext(ConfirmContext);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<ConfirmState | null>(null);
  const confirm = useCallback((o: ConfirmOptions) => new Promise<boolean>((resolve) => setState({ ...o, resolve })), []);
  const close = (ok: boolean) => {
    state?.resolve(ok);
    setState(null);
  };
  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <Dialog
        open={Boolean(state)}
        title={state?.title ?? ''}
        onClose={() => close(false)}
        actions={
          <>
            <Button onClick={() => close(false)} autoFocus>
              {state?.cancelLabel ?? 'Cancel'}
            </Button>
            <Button variant={state?.danger ? 'danger' : 'primary'} onClick={() => close(true)}>
              {state?.confirmLabel}
            </Button>
          </>
        }
      >
        {typeof state?.message === 'string' ? <p>{state.message}</p> : state?.message}
      </Dialog>
    </ConfirmContext.Provider>
  );
}

/* ---------- Toasts ---------- */

type Toast = { id: number; kind: 'success' | 'error' | 'info'; text: string };
const ToastContext = createContext<(kind: Toast['kind'], text: string) => void>(() => {});
export const useToast = () => useContext(ToastContext);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  const dismiss = (id: number) => setToasts((t) => t.filter((x) => x.id !== id));
  const show = useCallback((kind: Toast['kind'], text: string) => {
    const id = nextId.current++;
    setToasts((t) => [...t.slice(-3), { id, kind, text }]);
    setTimeout(() => dismiss(id), kind === 'error' ? 9000 : 5000);
  }, []);
  return (
    <ToastContext.Provider value={show}>
      {children}
      <div className="adm-toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`adm-toast adm-toast--${t.kind}`} role={t.kind === 'error' ? 'alert' : 'status'}>
            <span>{t.text}</span>
            <button type="button" aria-label="Dismiss" onClick={() => dismiss(t.id)}>
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

/* ---------- Fields ---------- */

type FieldShell = { label: string; hint?: ReactNode; error?: string; required?: boolean; wide?: boolean };

function Shell({ label, hint, error, required, wide, id, children }: FieldShell & { id: string; children: ReactNode }) {
  return (
    <div className={`adm-field ${wide ? 'adm-field--wide' : ''} ${error ? 'has-error' : ''}`}>
      <label htmlFor={id} className="adm-field__label">
        {label}
        {required && <span className="adm-required" aria-hidden="true"> *</span>}
      </label>
      {children}
      {error ? (
        <p className="adm-field__error" id={`${id}-err`}>
          {error}
        </p>
      ) : (
        hint && <p className="adm-field__hint">{hint}</p>
      )}
    </div>
  );
}

type TextProps = FieldShell & {
  value: string;
  onChange: (v: string) => void;
  multiline?: boolean;
  rows?: number;
  placeholder?: string;
  type?: string;
  after?: ReactNode;
};

export function TextField({ value, onChange, multiline, rows = 4, placeholder, type = 'text', after, ...shell }: TextProps) {
  const id = useId();
  const common = {
    id,
    value,
    placeholder,
    'aria-invalid': Boolean(shell.error) || undefined,
    'aria-describedby': shell.error ? `${id}-err` : undefined,
    'aria-required': shell.required || undefined,
  };
  return (
    <Shell {...shell} id={id}>
      <div className="adm-input-row">
        {multiline ? (
          <textarea {...common} rows={rows} onChange={(e) => onChange(e.target.value)} />
        ) : (
          <input {...common} type={type} onChange={(e) => onChange(e.target.value)} />
        )}
        {after}
      </div>
    </Shell>
  );
}

export function Toggle({
  label,
  checked,
  onChange,
  hint,
  disabled,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  hint?: string;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="adm-field adm-field--toggle">
      <label htmlFor={id} className="adm-toggle">
        <input id={id} type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
        <span className="adm-toggle__track" aria-hidden="true" />
        <span>{label}</span>
      </label>
      {hint && <p className="adm-field__hint">{hint}</p>}
    </div>
  );
}

export function SelectField({
  value,
  onChange,
  options,
  ...shell
}: FieldShell & { value: string; onChange: (v: string) => void; options: { value: string; label: string }[] }) {
  const id = useId();
  return (
    <Shell {...shell} id={id}>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)} aria-invalid={Boolean(shell.error) || undefined}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </Shell>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <div className="adm-empty">{children}</div>;
}

export function Banner({ kind, children }: { kind: 'info' | 'warning' | 'error' | 'success'; children: ReactNode }) {
  return (
    <div className={`adm-banner adm-banner--${kind}`} role={kind === 'error' ? 'alert' : undefined}>
      {children}
    </div>
  );
}

export function formatDate(iso: string | null | undefined, withTime = true): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}),
  });
}
