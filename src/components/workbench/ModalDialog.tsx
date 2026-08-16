import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject
} from "react";
import { createPortal } from "react-dom";

const FOCUSABLE_SELECTOR = [
  "button",
  "[href]",
  "input",
  "select",
  "textarea",
  "summary",
  "[tabindex]"
].join(", ");

type ModalStackEntry = {
  dialog: HTMLElement | null;
  surface: HTMLDivElement | null;
  returnFocus: HTMLElement | null;
  setActive: (active: boolean) => void;
};

type ModalSession = {
  appRoot: HTMLElement | null;
  rootWasInert: boolean;
  bodyHadModalClass: boolean;
  externalReturnFocus: HTMLElement | null;
};

const modalStack: ModalStackEntry[] = [];
let modalSession: ModalSession | null = null;

type ModalDialogProps = {
  open: boolean;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  headerAction?: ReactNode;
  className?: string;
  role?: "dialog" | "alertdialog";
  instanceKey?: string | number | null;
  initialFocusRef?: RefObject<HTMLElement | null>;
  cancelDisabled?: boolean;
  onCancel: () => void;
};

function hasDisabledFieldsetAncestor(element: HTMLElement): boolean {
  const fieldset = element.closest("fieldset[disabled]");
  if (!fieldset) return false;
  const firstLegend = Array.from(fieldset.children).find((child) => child.tagName === "LEGEND");
  return !firstLegend?.contains(element);
}

function isClosedDetailsContent(element: HTMLElement): boolean {
  const closedDetails = element.closest("details:not([open])");
  if (!closedDetails) return false;
  const summary = Array.from(closedDetails.children).find((child) => child.tagName === "SUMMARY");
  return element !== summary;
}

function isKeyboardReachable(element: HTMLElement | null, container?: HTMLElement | null): element is HTMLElement {
  if (!element || !element.isConnected || (container && !container.contains(element))) return false;
  if (
    (element.tabIndex < 0 && element.tagName !== "SUMMARY")
    || element.hidden
    || element.matches(":disabled")
    || hasDisabledFieldsetAncestor(element)
  ) return false;
  if (isClosedDetailsContent(element)) return false;

  for (let current: HTMLElement | null = element; current; current = current.parentElement) {
    if (current.hidden || current.inert || current.getAttribute("aria-hidden") === "true") return false;
  }
  return true;
}

function setInert(element: HTMLElement, inert: boolean) {
  element.inert = inert;
  element.toggleAttribute("inert", inert);
}

function focusableElements(container: HTMLElement | null): HTMLElement[] {
  return Array.from(container?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR) ?? [])
    .filter((element) => isKeyboardReachable(element, container));
}

function focusWithinDialog(dialog: HTMLElement | null, preferred?: HTMLElement | null) {
  if (!dialog) return;
  const requestedFocus = preferred ?? null;
  if (isKeyboardReachable(requestedFocus, dialog)) {
    requestedFocus.focus();
    return;
  }
  (focusableElements(dialog)[0] ?? dialog).focus();
}

function synchronizeModalStack() {
  const top = modalStack[modalStack.length - 1] ?? null;
  modalStack.forEach((entry) => {
    const active = entry === top;
    entry.setActive(active);
    if (entry.surface) {
      entry.surface.setAttribute("aria-hidden", active ? "false" : "true");
      setInert(entry.surface, !active);
    }
    if (entry.dialog) {
      entry.dialog.setAttribute("aria-hidden", active ? "false" : "true");
      setInert(entry.dialog, !active);
      if (active) entry.dialog.setAttribute("aria-modal", "true");
      else entry.dialog.removeAttribute("aria-modal");
    }
  });
}

function restoreModalSession(session: ModalSession) {
  if (session.appRoot) setInert(session.appRoot, session.rootWasInert);
  document.body.classList.toggle("modal-open", session.bodyHadModalClass);
  if (isKeyboardReachable(session.externalReturnFocus)) session.externalReturnFocus.focus();
}

function ensureModalSession(): ModalSession {
  const appRoot = document.getElementById("root");
  if (modalSession) return modalSession;

  modalSession = {
    appRoot,
    rootWasInert: appRoot?.inert ?? false,
    bodyHadModalClass: document.body.classList.contains("modal-open"),
    externalReturnFocus: document.activeElement instanceof HTMLElement ? document.activeElement : null
  };
  return modalSession;
}

function restoreAfterFinalModalClose() {
  const session = modalSession;
  if (!session || modalStack.length > 0) return;
  restoreModalSession(session);
  modalSession = null;
}

function registerModal(entry: ModalStackEntry, initialFocus?: HTMLElement | null) {
  const session = ensureModalSession();
  if (session.appRoot) setInert(session.appRoot, true);
  document.body.classList.add("modal-open");
  modalStack.push(entry);
  synchronizeModalStack();
  focusWithinDialog(entry.dialog, initialFocus);
}

function unregisterModal(entry: ModalStackEntry) {
  const index = modalStack.lastIndexOf(entry);
  if (index < 0) return;
  const wasTop = index === modalStack.length - 1;
  modalStack.splice(index, 1);
  synchronizeModalStack();

  const nextTop = modalStack[modalStack.length - 1] ?? null;
  if (wasTop && nextTop) {
    focusWithinDialog(nextTop.dialog, entry.returnFocus);
    return;
  }
  if (!nextTop) restoreAfterFinalModalClose();
}

export function ModalDialog({
  open,
  title,
  description,
  children,
  footer,
  headerAction,
  className = "",
  role = "dialog",
  instanceKey = null,
  initialFocusRef,
  cancelDisabled = false,
  onCancel
}: ModalDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef(onCancel);
  const cancellationDisabledRef = useRef(cancelDisabled);
  const initialFocusRefRef = useRef(initialFocusRef);
  const entryRef = useRef<ModalStackEntry | null>(null);
  const instanceKeyRef = useRef(instanceKey);
  const registeredInstanceKeyRef = useRef(instanceKey);
  const [active, setActive] = useState(false);
  cancelRef.current = onCancel;
  cancellationDisabledRef.current = cancelDisabled;
  initialFocusRefRef.current = initialFocusRef;
  instanceKeyRef.current = instanceKey;

  useLayoutEffect(() => {
    if (!open) {
      setActive(false);
      return;
    }

    const entry: ModalStackEntry = {
      dialog: dialogRef.current,
      surface: surfaceRef.current,
      returnFocus: document.activeElement instanceof HTMLElement ? document.activeElement : null,
      setActive
    };
    entryRef.current = entry;
    registeredInstanceKeyRef.current = instanceKeyRef.current;
    registerModal(entry, initialFocusRefRef.current?.current);

    function handleKeyDown(event: KeyboardEvent) {
      if (modalStack[modalStack.length - 1] !== entry) return;
      const dialog = entry.dialog;
      if (!dialog) return;

      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (!cancellationDisabledRef.current) cancelRef.current();
        return;
      }
      if (event.key !== "Tab") return;

      const controls = focusableElements(dialog);
      if (controls.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const currentIndex = controls.indexOf(document.activeElement as HTMLElement);
      const nextIndex = event.shiftKey
        ? (currentIndex <= 0 ? controls.length - 1 : currentIndex - 1)
        : (currentIndex < 0 || currentIndex === controls.length - 1 ? 0 : currentIndex + 1);
      event.preventDefault();
      controls[nextIndex].focus();
    }

    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("keydown", handleKeyDown, true);
      unregisterModal(entry);
      if (entryRef.current === entry) entryRef.current = null;
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open || registeredInstanceKeyRef.current === instanceKey) return;

    registeredInstanceKeyRef.current = instanceKey;
    const entry = entryRef.current;
    if (!entry || !modalStack.includes(entry)) return;

    entry.dialog = dialogRef.current;
    entry.surface = surfaceRef.current;
    synchronizeModalStack();
    if (modalStack[modalStack.length - 1] === entry) {
      focusWithinDialog(entry.dialog, initialFocusRefRef.current?.current);
    }
  }, [instanceKey, open]);

  if (!open) return null;

  return createPortal(
    <div
      ref={surfaceRef}
      className="modal-backdrop"
      role="presentation"
      aria-hidden={active ? undefined : "true"}
    >
      <section
        ref={dialogRef}
        className={`modal-dialog${className ? ` ${className}` : ""}`}
        role={role}
        aria-modal={active || undefined}
        aria-hidden={active ? undefined : "true"}
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
      >
        <header className="modal-header">
          <h3 id={titleId}>{title}</h3>
          {headerAction ? <div className="modal-header-action">{headerAction}</div> : null}
        </header>
        {description ? <div id={descriptionId} className="modal-description">{description}</div> : null}
        {children}
        {footer ? <footer className="dialog-actions">{footer}</footer> : null}
      </section>
    </div>,
    document.body
  );
}
