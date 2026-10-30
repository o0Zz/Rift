import { createSignal, onMount } from "solid-js";

/** Search box over the terminal: Enter = next, Shift+Enter = previous, Esc = close. */
export function FindBar(props: { find(text: string, backwards: boolean): boolean; onClose(): void }) {
  let input!: HTMLInputElement;
  const [missing, setMissing] = createSignal(false);
  onMount(() => (input.focus(), input.select()));

  const run = (backwards = false) => {
    const text = input.value;
    setMissing(text !== "" && !props.find(text, backwards));
  };

  return (
    <div class="find-bar">
      <input
        ref={input}
        placeholder="Find"
        classList={{ missing: missing() }}
        onInput={() => run()}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") run(e.shiftKey);
          if (e.key === "Escape") props.onClose();
        }}
      />
      <button class="icon-btn" title="Previous (Shift+Enter)" onClick={() => run(true)}>
        ↑
      </button>
      <button class="icon-btn" title="Next (Enter)" onClick={() => run()}>
        ↓
      </button>
      <button class="icon-btn" title="Close (Esc)" onClick={() => props.onClose()}>
        ×
      </button>
    </div>
  );
}
