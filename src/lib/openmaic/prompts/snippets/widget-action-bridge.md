## Platform Widget Action Bridge (REQUIRED)

The classroom can focus, annotate, reveal, or set a comparison state inside this iframe. The HTML must register one `message` listener for the existing action types `SET_WIDGET_STATE`, `HIGHLIGHT_ELEMENT`, `ANNOTATE_ELEMENT`, and `REVEAL_ELEMENT`. Do not invent new message types and do not send messages back to the parent.

Use stable semantic IDs for every important control and result. Prefer `id="{variable}-slider"` for parameter inputs, `id="{action}-btn"` for actions, `id="node-{id}"` for diagram nodes, `id="output"` for code output, and `id="code-input"` for a code textarea/editor fallback.

```javascript
window.addEventListener('message', function(event) {
  const data = event.data || {};
  const target = typeof data.target === 'string' ? data.target : '';

  switch (data.type) {
    case 'SET_WIDGET_STATE': {
      const state = data.state && typeof data.state === 'object' ? data.state : {};
      if (typeof window.setWidgetState === 'function') window.setWidgetState(state);
      Object.entries(state).forEach(([key, value]) => {
        if (key === 'code') {
          if (typeof window.editor !== 'undefined' && typeof window.editor.setValue === 'function') {
            window.editor.setValue(String(value));
          } else {
            const codeInput = document.getElementById('code-input');
            if (codeInput) codeInput.value = String(value);
          }
          return;
        }
        const control = document.getElementById(key)
          || document.getElementById(key + '-slider')
          || document.querySelector('[data-var="' + CSS.escape(key) + '"]')
          || document.getElementById('node-' + key);
        if (!control) return;
        if ('value' in control) control.value = String(value);
        control.classList.toggle('active', Boolean(value));
        control.dispatchEvent(new Event('input', { bubbles: true }));
        control.dispatchEvent(new Event('change', { bubbles: true }));
      });
      if (state.run === true && typeof window.runCode === 'function') window.runCode();
      break;
    }
    case 'HIGHLIGHT_ELEMENT': {
      const element = target ? document.querySelector(target) : null;
      if (!element) break;
      element.style.outline = '3px solid rgba(139, 92, 246, 0.85)';
      element.style.outlineOffset = '4px';
      setTimeout(() => { element.style.outline = ''; element.style.outlineOffset = ''; }, 3000);
      break;
    }
    case 'ANNOTATE_ELEMENT': {
      const element = target ? document.querySelector(target) : null;
      if (!element || !data.content) break;
      const note = document.createElement('div');
      note.className = 'teacher-annotation';
      note.textContent = String(data.content);
      note.style.cssText = 'position:fixed;inset:auto 16px 16px 16px;z-index:1000;padding:10px 14px;border-radius:10px;background:rgba(79,70,229,.96);color:white;font:600 14px/1.5 system-ui;box-shadow:0 8px 30px rgba(0,0,0,.25)';
      document.body.appendChild(note);
      setTimeout(() => note.remove(), 4000);
      break;
    }
    case 'REVEAL_ELEMENT': {
      const element = target ? document.querySelector(target) : null;
      if (!element) break;
      element.hidden = false;
      element.style.display = '';
      element.style.opacity = '1';
      break;
    }
  }
});
```

The bridge may focus or demonstrate a state for teacher explanation, but it must not mark the learner activity complete or perform the meaningful learner operation on the learner's behalf.
