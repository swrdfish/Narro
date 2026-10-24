// A styled dropdown drawn over a native <select>, which stays hidden and remains the source of
// truth: its value, its options (which code may replace at any time) and its input/change events.
// Follows the ARIA combobox + listbox pattern.

let instances = 0;

export function enhanceSelect(select) {
  const win = select.ownerDocument.defaultView;
  const doc = select.ownerDocument;
  const id = `narro-select-${++instances}`;
  const nativeValue = Object.getOwnPropertyDescriptor(win.HTMLSelectElement.prototype, 'value');

  const wrapper = doc.createElement('div');
  wrapper.className = 'custom-select';
  const button = doc.createElement('button');
  button.type = 'button';
  button.className = 'cs-button';
  button.setAttribute('role', 'combobox');
  button.setAttribute('aria-haspopup', 'listbox');
  button.setAttribute('aria-expanded', 'false');
  button.setAttribute('aria-controls', `${id}-list`);
  const valueText = doc.createElement('span');
  valueText.className = 'cs-value';
  valueText.id = `${id}-value`;
  button.append(valueText);
  const list = doc.createElement('ul');
  list.className = 'cs-list';
  list.id = `${id}-list`;
  list.setAttribute('role', 'listbox');
  list.hidden = true;
  // The dropdown usually sits inside its field's <label>, which would forward clicks in the list to
  // the button and reopen it right after a choice.
  list.addEventListener('click', (event) => event.preventDefault());

  // Name the combobox after the field's visible label, followed by its current value.
  const label = select.closest('label')?.querySelector(':scope > span');
  if (label) {
    label.id ||= `${id}-label`;
    button.setAttribute('aria-labelledby', `${label.id} ${valueText.id}`);
    list.setAttribute('aria-labelledby', label.id);
  }

  select.before(wrapper);
  // The button comes first so that clicking the field's label opens this dropdown.
  wrapper.append(button, list, select);
  select.classList.add('cs-native');
  select.tabIndex = -1;
  select.setAttribute('aria-hidden', 'true');

  let options = []; // [{ option, el }]
  let active = -1;
  let open = false;

  function sync() {
    const selected = select.selectedOptions[0];
    valueText.textContent = selected?.text ?? '';
    button.title = selected?.text ?? '';
    button.disabled = select.disabled;
    for (const { option, el } of options) el.setAttribute('aria-selected', String(option.selected));
  }

  function render() {
    list.replaceChildren();
    options = [];
    const add = (option, parent) => {
      const el = doc.createElement('li');
      el.className = 'cs-option';
      el.id = `${id}-option-${options.length}`;
      el.setAttribute('role', 'option');
      el.textContent = option.text;
      el.title = option.text;
      // An option's data-detail shows as a second, quieter line (e.g. a model's download size).
      if (option.dataset.detail) {
        const detail = doc.createElement('span');
        detail.className = 'cs-detail';
        detail.textContent = option.dataset.detail;
        el.append(detail);
        el.title += `\n${option.dataset.detail}`;
      }
      if (option.disabled) el.setAttribute('aria-disabled', 'true');
      const index = options.length;
      el.addEventListener('pointerdown', (event) => event.preventDefault()); // keep focus on the button
      el.addEventListener('click', () => choose(index));
      el.addEventListener('mousemove', () => setActive(index, false));
      options.push({ option, el });
      parent.append(el);
    };
    for (const child of select.children) {
      if (child.tagName === 'OPTGROUP') {
        const group = doc.createElement('li');
        group.setAttribute('role', 'group');
        group.setAttribute('aria-label', child.label);
        const heading = doc.createElement('div');
        heading.className = 'cs-group';
        heading.textContent = child.label;
        heading.setAttribute('aria-hidden', 'true');
        const items = doc.createElement('ul');
        items.setAttribute('role', 'presentation');
        group.append(heading, items);
        list.append(group);
        for (const option of child.children) add(option, items);
      } else if (child.tagName === 'OPTION') {
        add(child, list);
      }
    }
    if (open) setActive(Math.max(0, select.selectedIndex), true);
    sync();
  }

  // Programmatic `select.value = …` (e.g. when settings load) updates the button too.
  Object.defineProperty(select, 'value', {
    configurable: true,
    get() { return nativeValue.get.call(this); },
    set(value) { nativeValue.set.call(this, value); sync(); },
  });
  // Options are replaced when model or voice lists load.
  new win.MutationObserver(render).observe(select, { childList: true, subtree: true, attributes: true, attributeFilter: ['label', 'disabled', 'data-detail'] });

  function setActive(index, scroll) {
    options[active]?.el.classList.remove('active');
    active = index;
    const current = options[active];
    if (!current) {
      button.removeAttribute('aria-activedescendant');
      return;
    }
    current.el.classList.add('active');
    button.setAttribute('aria-activedescendant', current.el.id);
    if (scroll) current.el.scrollIntoView?.({ block: 'nearest' });
  }

  function move(from, step) {
    for (let index = from + step; index >= 0 && index < options.length; index += step) {
      if (!options[index].option.disabled) return index;
    }
    return from;
  }

  // Fixed positioning keeps the list from growing the popup window; it opens upward when there
  // isn't room below.
  function place() {
    const rect = button.getBoundingClientRect();
    const below = win.innerHeight - rect.bottom - 8;
    const above = rect.top - 8;
    const wanted = Math.min(list.scrollHeight, 280);
    const up = below < wanted && above > below;
    list.style.left = `${rect.left}px`;
    list.style.width = `${rect.width}px`;
    list.style.maxHeight = `${Math.max(120, Math.min(280, up ? above : below))}px`;
    list.style.top = up ? '' : `${rect.bottom + 4}px`;
    list.style.bottom = up ? `${win.innerHeight - rect.top + 4}px` : '';
    list.classList.toggle('up', up);
  }

  function outside(event) {
    if (!wrapper.contains(event.target)) close(false);
  }

  function show() {
    if (open || button.disabled) return;
    open = true;
    list.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    place();
    setActive(Math.max(0, select.selectedIndex), true);
    doc.addEventListener('pointerdown', outside, true);
    win.addEventListener('resize', place);
  }

  function close(focus = true) {
    if (!open) return;
    open = false;
    list.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    setActive(-1, false);
    doc.removeEventListener('pointerdown', outside, true);
    win.removeEventListener('resize', place);
    if (focus) button.focus();
  }

  function choose(index) {
    const choice = options[index];
    if (!choice || choice.option.disabled) return;
    const changed = !choice.option.selected;
    nativeValue.set.call(select, choice.option.value);
    sync();
    close();
    if (changed) {
      select.dispatchEvent(new win.Event('input', { bubbles: true }));
      select.dispatchEvent(new win.Event('change', { bubbles: true }));
    }
  }

  // Type-ahead: letters typed in quick succession jump to the next matching option.
  let typed = '';
  let typedTimer = null;
  function typeAhead(char) {
    typed += char.toLowerCase();
    clearTimeout(typedTimer);
    typedTimer = setTimeout(() => (typed = ''), 600);
    // Repeating one letter cycles through the options starting with it, like a native select.
    const search = /^(.)\1+$/.test(typed) ? typed[0] : typed;
    const start = open ? active : select.selectedIndex;
    const order = [...options.keys()].map((i) => (start + (search.length === 1 ? 1 : 0) + i) % options.length);
    const match = order.find((i) => !options[i].option.disabled && options[i].option.text.toLowerCase().startsWith(search));
    if (match === undefined) return;
    if (open) setActive(match, true);
    else choose(match);
  }

  button.addEventListener('click', () => (open ? close() : show()));
  button.addEventListener('keydown', (event) => {
    const { key } = event;
    if (key === 'ArrowDown' || key === 'ArrowUp') {
      event.preventDefault();
      if (!open) return show();
      setActive(move(active, key === 'ArrowDown' ? 1 : -1), true);
    } else if (key === 'Home' || key === 'End') {
      if (!open) return;
      event.preventDefault();
      setActive(key === 'Home' ? move(-1, 1) : move(options.length, -1), true);
    } else if (key === 'Enter' || key === ' ') {
      event.preventDefault();
      if (open && active >= 0) choose(active);
      else show();
    } else if (key === 'Escape') {
      if (open) {
        event.preventDefault();
        event.stopPropagation();
        close();
      }
    } else if (key === 'Tab') {
      close(false);
    } else if (key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      typeAhead(key);
    }
  });

  render();
  return { render, sync };
}

export function enhanceSelects(root) {
  for (const select of root.querySelectorAll('select')) enhanceSelect(select);
}
