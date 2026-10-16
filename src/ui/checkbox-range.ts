interface CheckboxRangeItem { key: string; disabled?: boolean }

/** Keep the last ordinary click as an anchor across list renders. */
export class CheckboxRangeSelection {
  private anchor?: string;
  reset() { this.anchor = undefined; }
  bind(input: HTMLInputElement, label: HTMLLabelElement, key: string, rows: readonly CheckboxRangeItem[], selected: Set<string>, changed: () => void) {
    let shift = false, labelShift = false;
    input.title = 'Shift-click to select or clear a range.';
    // Label activation may forward a second click to the input without modifiers.
    label.addEventListener('click', event => { if (event.target !== input) labelShift = event.shiftKey; }, true);
    input.onclick = event => { shift = event.shiftKey || labelShift; labelShift = false; };
    input.onchange = () => {
      if (input.disabled) return;
      const target = rows.findIndex(row => row.key === key && !row.disabled);
      if (target < 0) return;
      const anchor = shift ? rows.findIndex(row => row.key === this.anchor && !row.disabled) : -1;
      const range = anchor < 0 ? [rows[target]!] : rows.slice(Math.min(anchor, target), Math.max(anchor, target) + 1);
      for (const row of range) if (!row.disabled) {
        if (input.checked) selected.add(row.key); else selected.delete(row.key);
      }
      if (anchor < 0) this.anchor = key;
      shift = false; changed();
    };
  }
}
