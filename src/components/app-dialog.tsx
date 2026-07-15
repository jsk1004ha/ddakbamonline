"use client";

import { type ReactNode, useEffect, useRef } from "react";

type AppDialogProps = {
  open: boolean;
  onClose: () => void;
  titleId: string;
  descriptionId?: string;
  className?: string;
  children: ReactNode;
};

export default function AppDialog({
  open,
  onClose,
  titleId,
  descriptionId,
  className = "",
  children,
}: AppDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const previousTriggerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;

    return () => {
      delete document.body.dataset.dialogOpen;

      if (dialog?.open) {
        dialog.close();
      }
    };
  }, []);

  useEffect(() => {
    const dialog = dialogRef.current;

    if (!dialog) {
      return;
    }

    if (open && !dialog.open) {
      previousTriggerRef.current =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      document.body.dataset.dialogOpen = "true";
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
      delete document.body.dataset.dialogOpen;
      previousTriggerRef.current?.focus();
    }
  }, [open]);

  return (
    <dialog
      ref={dialogRef}
      className={`app-dialog ${className}`.trim()}
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      {children}
    </dialog>
  );
}
