(function(){const module={exports:{}};
// Adapted from the existing Chrome Paint shortcut engine; UO map-only action registry.
'use strict';

const DEFAULT_SHORTCUTS = Object.freeze({
  pencil:'B', fill:'G', eraser:'E', wand:'W', pixel:'P', freehand:'Q', rectangle:'M', ellipse:'O', gradient:'R', path:'T', ramp:'L', road:'K', flatten:'F', blur:'J', mountain:'N', eyedropper:'I',
  'select-all':'Ctrl+A', deselect:'Ctrl+D', 'invert-selection':'Shift+I',
  undo:'Ctrl+Z', redo:'Ctrl+Shift+Z', 'save-project':'Ctrl+S'
});

const MODIFIER_ORDER = ['Ctrl', 'Alt', 'Shift', 'Meta'];
const MODIFIER_ALIASES = Object.freeze({
  ctrl: 'Ctrl', control: 'Ctrl', alt: 'Alt', option: 'Alt', shift: 'Shift',
  meta: 'Meta', cmd: 'Meta', command: 'Meta', win: 'Meta', windows: 'Meta'
});
const KEY_ALIASES = Object.freeze({
  esc: 'Escape', escape: 'Escape', space: 'Space', spacebar: 'Space',
  plus: 'Plus', enter: 'Enter', return: 'Enter', tab: 'Tab',
  backspace: 'Backspace', delete: 'Delete', del: 'Delete', insert: 'Insert',
  home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown',
  up: 'ArrowUp', arrowup: 'ArrowUp', down: 'ArrowDown', arrowdown: 'ArrowDown',
  left: 'ArrowLeft', arrowleft: 'ArrowLeft', right: 'ArrowRight', arrowright: 'ArrowRight'
});

function canonicalKey(key) {
  if (typeof key !== 'string') return null;
  if (key === ' ') return 'Space';
  if (key === '+') return 'Plus';
  const trimmed = key.trim();
  const lower = trimmed.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(KEY_ALIASES, lower)) return KEY_ALIASES[lower];
  if (/^[a-z0-9]$/i.test(trimmed)) return trimmed.toUpperCase();
  if (/^f(?:[1-9]|1[0-9]|2[0-4])$/i.test(trimmed)) return trimmed.toUpperCase();
  if (/^[`~!@#$%^&*()_\-=\[\]{}\\|;:'",.<>/?]$/.test(trimmed)) return trimmed;
  return null;
}

/** Canonical single chord; no sequences. Use "Plus" for a literal + key. */
function normalizeShortcut(text) {
  if (typeof text !== 'string') return null;
  if (text === ' ') return 'Space';
  if (text === '+') return 'Plus';
  const trimmed = text.trim();
  if (!trimmed) return null;
  const parts = trimmed.split('+').map(part => part.trim());
  if (parts.some(part => part === '')) return null;
  const modifiers = new Set();
  let key = null;
  for (const part of parts) {
    const name = part.toLowerCase();
    const modifier = Object.prototype.hasOwnProperty.call(MODIFIER_ALIASES, name) ? MODIFIER_ALIASES[name] : null;
    if (modifier) {
      if (modifiers.has(modifier)) return null;
      modifiers.add(modifier);
    } else {
      if (key !== null) return null;
      key = canonicalKey(part);
      if (key === null) return null;
    }
  }
  if (!key) return null;
  return [...MODIFIER_ORDER.filter(modifier => modifiers.has(modifier)), key].join('+');
}

// Deliberately conservative and incomplete. Operating systems may consume
// additional chords before JavaScript sees them; this list cannot detect that.
// Ctrl+D/A/Z and similar app-owned editing chords remain usable only when the
// editor owns focus and the caller prevents the matched event's default action.
const RESERVED_SHORTCUTS = Object.freeze([
  'Escape', 'Tab', 'Shift+Tab', 'Enter', 'Space',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Home', 'End', 'PageUp', 'PageDown',
  'F1', 'F3', 'Shift+F3', 'F5', 'Ctrl+F5', 'F6', 'F11', 'F12', 'Shift+F10',
  'Ctrl+L', 'Ctrl+R', 'Ctrl+T', 'Ctrl+W', 'Ctrl+N', 'Ctrl+P',
  'Ctrl+Shift+R', 'Ctrl+Shift+T', 'Ctrl+Shift+W', 'Ctrl+Shift+N',
  'Ctrl+Shift+I', 'Ctrl+Shift+J', 'Ctrl+Shift+C',
  'Ctrl+Tab', 'Ctrl+Shift+Tab', 'Ctrl+PageUp', 'Ctrl+PageDown', 'Ctrl+F4',
  'Alt+Tab', 'Alt+Shift+Tab', 'Alt+F4', 'Alt+Escape', 'Alt+ArrowLeft', 'Alt+ArrowRight',
  'Ctrl+Alt+Delete', 'Ctrl+Shift+Escape',
  'Meta+L', 'Meta+R', 'Meta+T', 'Meta+W', 'Meta+N', 'Meta+Q',
  'Meta+H', 'Meta+M', 'Meta+D', 'Meta+E', 'Meta+Tab', 'Meta+Space'
]);
const RESERVED_SET = new Set(RESERVED_SHORTCUTS);

function isReservedShortcut(chord) {
  const normalized = normalizeShortcut(chord);
  // Escape is always the recorder's cancel key, regardless of held modifiers.
  return normalized !== null && (normalized.split('+').at(-1) === 'Escape' || RESERVED_SET.has(normalized));
}

/** Obtain a key chord without deciding whether it may be assigned. */
function shortcutFromEvent(event) {
  if (!event || typeof event !== 'object' || event.repeat || event.isComposing || event.keyCode === 229 ||
      (typeof event.getModifierState === 'function' && event.getModifierState('AltGraph'))) return null;
  const key = canonicalKey(event.key);
  if (!key) return null;
  const modifiers = [];
  if (event.ctrlKey) modifiers.push('Ctrl');
  if (event.altKey) modifiers.push('Alt');
  if (event.shiftKey) modifiers.push('Shift');
  if (event.metaKey) modifiers.push('Meta');
  return [...modifiers, key].join('+');
}

function ancestors(target) {
  const result = [];
  let node = target && target.nodeType === 3 ? target.parentElement : target;
  const seen = new Set();
  while (node && !seen.has(node)) {
    seen.add(node);
    result.push(node);
    node = node.parentElement || node.parentNode ||
      (typeof node.getRootNode === 'function' ? node.getRootNode()?.host : null);
  }
  return result;
}

function attr(node, name) {
  return typeof node.getAttribute === 'function' ? node.getAttribute(name) : null;
}

/** Includes nested descendants and inherited contenteditable text areas. */
function isEditableTarget(target) {
  return ancestors(target).some(node => {
    const tag = String(node.tagName || node.nodeName || '').toLowerCase();
    const editable = attr(node, 'contenteditable');
    const role = attr(node, 'role');
    return ['input', 'textarea', 'select', 'option'].includes(tag) ||
      node.isContentEditable === true || editable === '' || editable === 'true' || editable === 'plaintext-only' ||
      ['textbox', 'searchbox', 'combobox', 'spinbutton'].includes(role);
  });
}

function isInteractiveTarget(target) {
  return ancestors(target).some(node => {
    const tag = String(node.tagName || node.nodeName || '').toLowerCase();
    return ['button', 'a', 'summary'].includes(tag) ||
      ['button', 'link', 'menuitem'].includes(attr(node, 'role'));
  });
}

function validActionId(actionId) {
  return typeof actionId === 'string' && /^[a-z][a-z0-9-]*$/i.test(actionId) &&
    !['__proto__', 'constructor', 'prototype'].includes(actionId.toLowerCase());
}

function failure(reason, message, details = {}) { return { ok: false, reason, message, ...details }; }

/** Validate imported settings without partial application or silent collisions. */
function validateBindings(bindings) {
  if (!bindings || typeof bindings !== 'object' || Array.isArray(bindings) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(bindings))) {
    return failure('invalid-map', 'Shortcut settings must be an action-to-shortcut object.');
  }
  const normalized = {};
  const owners = new Map();
  for (const [actionId, value] of Object.entries(bindings)) {
    if (!validActionId(actionId)) return failure('invalid-action', 'Action identifiers must be simple names.', { actionId });
    if (value === '') { normalized[actionId] = ''; continue; }
    const chord = normalizeShortcut(value);
    if (chord === null) return failure('invalid-shortcut', 'Use one key with optional Ctrl, Alt, Shift or Meta modifiers.', { actionId });
    if (isReservedShortcut(chord)) return failure('reserved', `${chord} is reserved for navigation, the browser or the system.`, { actionId, chord });
    if (owners.has(chord)) return failure('conflict', `${chord} is already assigned to ${owners.get(chord)}.`, { actionId, conflictAction: owners.get(chord), chord });
    owners.set(chord, actionId);
    normalized[actionId] = chord;
  }
  return { ok: true, bindings: normalized };
}

/** Immutable assign/unbind. A conflict never removes the other binding. */
function assignShortcut(bindings, actionId, chord) {
  const existing = validateBindings(bindings);
  if (!existing.ok) return existing;
  if (!validActionId(actionId)) return failure('invalid-action', 'Choose a valid action before assigning a shortcut.', { actionId });
  if (chord === '') return { ok: true, bindings: { ...existing.bindings, [actionId]: '' } };
  const normalized = normalizeShortcut(chord);
  if (normalized === null) return failure('invalid-shortcut', 'Press one key with optional Ctrl, Alt, Shift or Meta modifiers.', { actionId });
  if (isReservedShortcut(normalized)) return failure('reserved', `${normalized} is reserved for navigation, the browser or the system.`, { actionId, chord: normalized });
  const owner = Object.keys(existing.bindings).find(id => id !== actionId && existing.bindings[id] === normalized);
  if (owner) return failure('conflict', `${normalized} is already assigned to ${owner}.`, { actionId, conflictAction: owner, chord: normalized });
  return { ok: true, bindings: { ...existing.bindings, [actionId]: normalized } };
}

/** Caller scopes this to the focused editor and prevents default on a match. */
function matchShortcut(event, bindings, { allowInteractiveTarget = false } = {}) {
  if (!event || event.defaultPrevented || event.repeat || isEditableTarget(event.target) ||
      (!allowInteractiveTarget && isInteractiveTarget(event.target))) return null;
  // composedPath covers editable controls inside open Shadow DOM.
  if (typeof event.composedPath === 'function' && event.composedPath().some(node =>
    isEditableTarget(node) || (!allowInteractiveTarget && isInteractiveTarget(node)))) return null;
  const chord = shortcutFromEvent(event);
  if (!chord || isReservedShortcut(chord)) return null;
  const checked = validateBindings(bindings);
  if (!checked.ok) return null;
  return Object.keys(checked.bindings).find(actionId => checked.bindings[actionId] === chord) || null;
}

module.exports = { DEFAULT_SHORTCUTS, RESERVED_SHORTCUTS, normalizeShortcut, shortcutFromEvent, isEditableTarget, isReservedShortcut, validateBindings, assignShortcut, matchShortcut };

window.MapPaintShortcuts=module.exports;})();
