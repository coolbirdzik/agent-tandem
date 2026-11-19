export function setModalOpen(dialog: HTMLDialogElement, open: boolean) {
  if (dialog.open === open) return;
  if (open && typeof dialog.showModal === 'function') dialog.showModal();
  else if (!open && typeof dialog.close === 'function') dialog.close();
  else dialog.toggleAttribute('open', open);
}
