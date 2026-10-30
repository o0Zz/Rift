import { onMount } from "solid-js";

/** A small modal asking for one value: Enter confirms, Escape or a click outside cancels. */
export function PromptDialog(props: {
  title: string;
  hint?: string;
  placeholder?: string;
  confirm: string;
  onSubmit(value: string): void;
  onCancel(): void;
}) {
  let input!: HTMLInputElement;
  onMount(() => input.focus());
  const submit = () => input.value.trim() && props.onSubmit(input.value.trim());

  return (
    <div class="settings-backdrop" onMouseDown={(e) => e.target === e.currentTarget && props.onCancel()}>
      <div class="dialog">
        <div class="dialog-title">{props.title}</div>
        <input
          ref={input}
          placeholder={props.placeholder}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") submit();
            if (e.key === "Escape") props.onCancel();
          }}
        />
        {props.hint && <div class="dialog-hint">{props.hint}</div>}
        <div class="dialog-actions">
          <button onClick={() => props.onCancel()}>Cancel</button>
          <button class="primary" onClick={submit}>
            {props.confirm}
          </button>
        </div>
      </div>
    </div>
  );
}
