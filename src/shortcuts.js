// Keyboard shortcuts as Chrome reports them, turned into key caps in the platform's notation.

// Chrome's key names → [macOS label, other label, macOS name, other name] (names are for tooltips).
const KEYS = {
  Alt: ['⌥', 'Alt', 'Option', 'Alt'], Shift: ['⇧', 'Shift', 'Shift', 'Shift'],
  Command: ['⌘', 'Ctrl', 'Command', 'Ctrl'], Ctrl: ['⌘', 'Ctrl', 'Command', 'Ctrl'], MacCtrl: ['⌃', 'Ctrl', 'Control', 'Ctrl'],
  Left: ['←', '←', 'Left arrow', 'Left arrow'], Right: ['→', '→', 'Right arrow', 'Right arrow'],
  Up: ['↑', '↑', 'Up arrow', 'Up arrow'], Down: ['↓', '↓', 'Down arrow', 'Down arrow'],
  Comma: [',', ',', 'Comma', 'Comma'], Period: ['.', '.', 'Period', 'Period'], Space: ['Space', 'Space', 'Space', 'Space'],
};
// macOS shortcuts come back as symbols ("⌥⇧R"); map each symbol to its key name.
const MAC_SYMBOLS = { '⌥': 'Alt', '⇧': 'Shift', '⌘': 'Command', '⌃': 'MacCtrl', '←': 'Left', '→': 'Right', '↑': 'Up', '↓': 'Down' };
const MAC_MODIFIERS = '⌃⌥⇧⌘';

// "⌥⇧R" / "⌥⇧Space" (macOS) or "Alt+Shift+R" → [{ label, name }]
export function shortcutKeys(shortcut, mac) {
  if (!shortcut) return [];
  let parts;
  if (shortcut.includes('+') || KEYS[shortcut]) parts = shortcut.split('+');
  else {
    // Leading modifier symbols, then the key itself (which may be a word such as "Space").
    parts = [];
    let rest = shortcut;
    while (rest && MAC_MODIFIERS.includes(rest[0])) {
      parts.push(MAC_SYMBOLS[rest[0]]);
      rest = rest.slice(1);
    }
    if (rest) parts.push(MAC_SYMBOLS[rest] || rest);
  }
  return parts.map((part) => {
    const known = KEYS[part];
    if (known) return mac ? { label: known[0], name: known[2] } : { label: known[1], name: known[3] };
    return { label: part, name: part };
  });
}
