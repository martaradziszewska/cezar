import {
  GUEST_COMMENT_BODY_MAX,
  GUEST_COMPONENT_MAX,
  GUEST_EXCERPT_MAX,
  GUEST_LABEL_MAX,
  GUEST_SELECTOR_MAX,
} from '@open-mercato/cezar-contract';

import { guestPickerCore } from './picker-script.ts';

/**
 * The share link's guest script (spec 2026-11-26-preview-share-link § Mechanism 8, C3): an in-page
 * host for the Design Mode picker. A corner bar and a comment popup in one closed shadow root,
 * saving to the share listener's `/__cezar_share__/comments`. Plain ES5-flavoured source, for the
 * same reasons as the picker.
 */
export function guestScript(config: { upstreamOrigin: string; name: string }): string {
  // The name is a stranger's text: it rides as JSON data, never as source.
  const json = JSON.stringify({
    name: config.name,
    bodyMax: GUEST_COMMENT_BODY_MAX,
    excerptMax: GUEST_EXCERPT_MAX,
    labelMax: GUEST_LABEL_MAX,
    selectorMax: GUEST_SELECTOR_MAX,
    componentMax: GUEST_COMPONENT_MAX,
  })
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  // The host runs first: the picker finds `__cezarShareHost` when it starts.
  return HOST_SOURCE.replace('__CEZAR_SHARE_CONFIG__', () => json) + guestPickerCore(config.upstreamOrigin);
}

const STYLE = String.raw`
:host { all: initial; }
.ui {
  --bg: #ffffff; --fg: #16181d; --muted: #5b6270; --line: #cfd4dc; --field: #ffffff; --danger: #b42318;
  font: 500 13px/1.35 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; color: var(--fg);
}
@media (prefers-color-scheme: dark) {
  .ui { --bg: #181b21; --fg: #eceef2; --muted: #a3abb8; --line: #333945; --field: #0f1115; --danger: #ff8a80; }
}
[hidden] { display: none !important; }
* { box-sizing: border-box; }
.bar, .popup { position: fixed; z-index: 2147483647; background: var(--bg); color: var(--fg); border: 1px solid var(--line); box-shadow: 0 6px 24px rgba(0, 0, 0, .2); }
.bar { right: 16px; bottom: 16px; display: flex; align-items: center; gap: 8px; max-width: calc(100vw - 32px); padding: 5px 12px 5px 5px; border-radius: 999px; }
.count { min-width: 22px; padding: 2px 6px; border-radius: 999px; background: #a3e635; color: #1a2e05; font-weight: 700; text-align: center; font-variant-numeric: tabular-nums; }
.name { color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 14em; }
button { font: inherit; color: inherit; cursor: pointer; padding: 5px 12px; border-radius: 999px; border: 1px solid var(--line); background: transparent; }
button:disabled { opacity: .6; cursor: default; }
button:focus-visible, textarea:focus-visible { outline: 2px solid #4f8cff; outline-offset: 2px; }
.toggle[aria-pressed="true"], .save { background: #2563eb; border-color: #2563eb; color: #ffffff; }
.popup { width: min(320px, calc(100vw - 16px)); padding: 12px; border-radius: 12px; display: flex; flex-direction: column; gap: 8px; }
.element { font: 600 12px/1.3 ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
textarea { width: 100%; min-height: 76px; resize: vertical; padding: 8px; font: inherit; color: var(--fg); background: var(--field); border: 1px solid var(--line); border-radius: 8px; }
.message { color: var(--danger); font-size: 12px; }
.actions { display: flex; gap: 8px; justify-content: flex-end; }
.delete { margin-right: auto; }
`;

// Every guest-visible string (the name, a body, a label, a server error) goes in as text or a field value.
const HOST_SOURCE = String.raw`(function () {
  'use strict';
  if (window.__cezarShareHost) return;
  var cfg = __CEZAR_SHARE_CONFIG__;
  var BASE = '/__cezar_share__/';
  var ENDED = 'This link has ended — your comment was not saved.';
  var FAILED = 'Your comment could not be saved. Try again.';
  var CSS = ` + JSON.stringify(STYLE) + String.raw`;

  var picker = null;
  var comments = [];
  var loaded = false;
  var started = false;
  var active = false;
  // { key, pick?, id?, selector } — the comment in the popup; "id" once it is saved.
  var editing = null;
  var busy = false;
  // A comment saved in this document keeps the picker key its element was framed under.
  var aliases = {};
  var rects = {};
  var path = location.pathname;
  var lastMarks = '';

  var element = document.createElement('cezar-share-guest');
  var root = element.attachShadow({ mode: 'closed' });
  var ui = {};

  window.__cezarShareHost = { element: element, receive: receive };

  function tell(message) {
    message.source = 'cezar-design-host';
    if (picker) picker.send(message);
  }

  function clip(text, max) {
    text = typeof text === 'string' ? text : '';
    return text.length > max ? text.slice(0, max - 1) + '…' : text;
  }

  function pathOf(url) {
    try { return new URL(url).pathname; } catch (e) { return null; }
  }

  function tail(selector) {
    var parts = String(selector || '').split(' > ');
    return parts[parts.length - 1];
  }

  function markOf(comment) {
    return aliases[comment.id] || comment.id;
  }

  // ---- marks -------------------------------------------------------------------------------

  // This page's comments, numbered in list order; the comment being written is framed unnumbered.
  function wanted() {
    var list = [];
    var n = 0;
    for (var i = 0; i < comments.length; i++) {
      if (pathOf(comments[i].url) !== location.pathname) continue;
      n++;
      list.push({ key: markOf(comments[i]), n: n, selector: comments[i].selector, path: location.pathname });
    }
    if (editing && !editing.id) list.push({ key: editing.key });
    return list;
  }

  function sendMarks(force) {
    if (!started || !loaded) return;
    var list = wanted();
    var serialized = JSON.stringify(list);
    if (!force && serialized === lastMarks) return;
    lastMarks = serialized;
    tell({ type: 'set-marks', marks: list });
  }

  // A saved comment's element may render after the page loads, or be rendered again: one the
  // picker has not framed is dropped and asked for again, so it is found by its selector anew.
  function retryMissing() {
    var list = wanted();
    var found = [];
    var missing = false;
    for (var i = 0; i < list.length; i++) {
      if (list[i].selector && !rects[list[i].key]) missing = true;
      else found.push(list[i]);
    }
    if (!missing) return;
    tell({ type: 'set-marks', marks: found });
    sendMarks(true);
  }

  // The app may change its path without a load. A poll of a string, not wrapped history methods:
  // those are the app's router's own, and it may wrap or compare them too.
  function check() {
    if (!element.isConnected) document.documentElement.appendChild(element);
    if (location.pathname !== path) {
      path = location.pathname;
      rects = {};
      sendMarks(true);
      return;
    }
    retryMissing();
  }

  // ---- the bar and the popup ---------------------------------------------------------------

  function make(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  }

  function button(className, text, onClick) {
    var node = make('button', className, text);
    node.type = 'button';
    node.addEventListener('click', onClick);
    return node;
  }

  function build() {
    try {
      var sheet = new CSSStyleSheet();
      sheet.replaceSync(CSS);
      root.adoptedStyleSheets = [sheet];
    } catch (e) {
      root.appendChild(make('style', '', CSS));
    }
    var wrap = make('div', 'ui');
    ui.bar = make('div', 'bar');
    ui.bar.setAttribute('role', 'toolbar');
    ui.bar.setAttribute('aria-label', 'Comments');
    ui.toggle = button('toggle', 'Comment', function () { setActive(!active); });
    ui.toggle.setAttribute('data-slot', 'toggle');
    ui.toggle.setAttribute('aria-pressed', 'false');
    ui.count = make('span', 'count', '0');
    ui.count.setAttribute('data-slot', 'count');
    ui.count.title = 'Your comments';
    ui.name = make('span', 'name');
    ui.name.setAttribute('data-slot', 'name');
    ui.name.textContent = cfg.name;
    ui.bar.appendChild(ui.toggle);
    ui.bar.appendChild(ui.count);
    ui.bar.appendChild(ui.name);

    ui.popup = make('div', 'popup');
    ui.popup.setAttribute('data-slot', 'popup');
    ui.popup.setAttribute('role', 'dialog');
    ui.popup.setAttribute('aria-label', 'Comment on this element');
    ui.popup.hidden = true;
    ui.element = make('div', 'element');
    ui.text = make('textarea');
    ui.text.maxLength = cfg.bodyMax;
    ui.text.placeholder = 'Leave a comment…';
    ui.text.setAttribute('aria-label', 'Comment');
    ui.message = make('div', 'message');
    ui.message.setAttribute('data-slot', 'message');
    ui.message.setAttribute('role', 'alert');
    ui.message.hidden = true;
    var actions = make('div', 'actions');
    ui.remove = button('delete', 'Delete', remove);
    ui.cancel = button('', 'Cancel', close);
    ui.save = button('save', 'Save', save);
    actions.appendChild(ui.remove);
    actions.appendChild(ui.cancel);
    actions.appendChild(ui.save);
    ui.popup.appendChild(ui.element);
    ui.popup.appendChild(ui.text);
    ui.popup.appendChild(ui.message);
    ui.popup.appendChild(actions);
    ui.popup.addEventListener('keydown', onPopupKey);

    wrap.appendChild(ui.bar);
    wrap.appendChild(ui.popup);
    root.appendChild(wrap);
    // A key typed into the bar or the popup is not the app's: it never bubbles out to its handlers.
    var keys = ['keydown', 'keyup', 'keypress'];
    for (var i = 0; i < keys.length; i++) root.addEventListener(keys[i], function (event) { event.stopPropagation(); });
    document.documentElement.appendChild(element);
  }

  function start() {
    if (started) return;
    started = true;
    build();
    renderCount();
    sendMarks(true);
    window.addEventListener('popstate', check);
    setInterval(check, 500);
  }

  function renderCount() {
    if (ui.count) ui.count.textContent = String(comments.length);
  }

  function setActive(next) {
    active = next;
    if (ui.toggle) ui.toggle.setAttribute('aria-pressed', active ? 'true' : 'false');
    tell({ type: 'set-active', active: active });
  }

  function say(text) {
    ui.message.textContent = text || '';
    ui.message.hidden = !text;
  }

  // Under the element, above it when there is no room below, always inside the viewport.
  function place() {
    if (!editing) return;
    var rect = rects[editing.key] || (editing.pick && editing.pick.rect);
    var width = ui.popup.offsetWidth || 320;
    var height = ui.popup.offsetHeight || 160;
    var vw = window.innerWidth;
    var vh = window.innerHeight;
    var left, top;
    if (rect) {
      top = rect.y + rect.height + 8;
      if (top + height > vh - 8) top = rect.y - height - 8;
      left = rect.x;
    } else {
      top = vh - height - 72;
      left = vw - width - 16;
    }
    ui.popup.style.left = Math.max(8, Math.min(left, vw - width - 8)) + 'px';
    ui.popup.style.top = Math.max(8, Math.min(top, vh - height - 8)) + 'px';
  }

  function open(next, text) {
    editing = next;
    busy = false;
    ui.element.textContent = tail(next.selector);
    ui.element.title = next.selector;
    ui.text.value = text;
    ui.remove.hidden = !next.id;
    setBusy(false);
    say('');
    ui.popup.hidden = false;
    place();
    sendMarks();
    ui.text.focus();
  }

  function close() {
    if (!editing) return;
    var hadFocus = root.activeElement !== null;
    editing = null;
    busy = false;
    ui.popup.hidden = true;
    sendMarks();
    if (hadFocus) ui.toggle.focus();
  }

  // Text the guest has typed and not saved: a stray click must not throw it away.
  function dirty() {
    if (!editing) return false;
    var text = ui.text.value.trim();
    if (!editing.id) return text !== '';
    var saved = find(editing.id);
    return !saved || text !== saved.body;
  }

  function find(id) {
    for (var i = 0; i < comments.length; i++) if (comments[i].id === id) return comments[i];
    return null;
  }

  function setBusy(next) {
    busy = next;
    ui.save.disabled = next;
    ui.remove.disabled = next;
  }

  function onPopupKey(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      save();
    }
  }

  // ---- the share listener ------------------------------------------------------------------

  // Answers { status, body }; status 0 when the request never got one.
  function request(method, name, payload) {
    var init = { method: method, credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' } };
    if (payload !== undefined) {
      init.headers['content-type'] = 'application/json';
      init.body = JSON.stringify(payload);
    }
    return fetch(BASE + name, init).then(function (res) {
      if (res.status === 204) return { status: 204, body: null };
      return res.json().then(function (body) { return { status: res.status, body: body }; }, function () { return { status: res.status, body: null }; });
    }, function () {
      return { status: 0, body: null };
    });
  }

  function failure(answer) {
    if (answer.status === 404) return ENDED;
    if (answer.body && typeof answer.body.error === 'string' && answer.body.error) return answer.body.error;
    return FAILED;
  }

  function isComment(value) {
    return !!value && typeof value.id === 'string' && typeof value.url === 'string' &&
      typeof value.selector === 'string' && typeof value.body === 'string';
  }

  function load() {
    request('GET', 'comments').then(function (answer) {
      var list = answer.status === 200 && answer.body && answer.body.comments;
      comments = [];
      if (Array.isArray(list)) for (var i = 0; i < list.length; i++) if (isComment(list[i])) comments.push(list[i]);
      loaded = true;
      renderCount();
      sendMarks(true);
    });
  }

  function componentOf(pick) {
    var names = Array.isArray(pick.components) ? pick.components.slice().reverse() : [];
    if (!names.length) return undefined;
    return clip(names.join(' › ') + (pick.source ? ' (' + pick.source + ')' : ''), cfg.componentMax);
  }

  function save() {
    var target = editing;
    if (!target || busy) return;
    var body = ui.text.value.trim();
    if (!body) { ui.text.focus(); return; }
    setBusy(true);
    say('');
    var sent;
    if (target.id) {
      sent = request('PUT', 'comments/' + encodeURIComponent(target.id), { body: body });
    } else {
      var pick = target.pick;
      var input = {
        url: pick.url,
        selector: clip(pick.selector, cfg.selectorMax),
        label: clip(pick.text, cfg.labelMax),
        excerpt: clip(pick.html, cfg.excerptMax),
        body: body
      };
      var component = componentOf(pick);
      if (component) input.component = component;
      sent = request('POST', 'comments', input);
    }
    sent.then(function (answer) {
      var comment = answer.body && answer.body.comment;
      var ok = (answer.status === 200 || answer.status === 201) && isComment(comment);
      // The server's answer is the saved comment, never what was typed here.
      if (ok && target.id) {
        for (var i = 0; i < comments.length; i++) if (comments[i].id === target.id) comments[i] = comment;
      } else if (ok) {
        aliases[comment.id] = target.key;
        comments.push(comment);
      }
      if (ok) renderCount();
      if (editing !== target) { sendMarks(); return; }
      if (ok) { close(); return; }
      setBusy(false);
      say(failure(answer));
    });
  }

  function remove() {
    var target = editing;
    if (!target || !target.id || busy) return;
    setBusy(true);
    say('');
    request('DELETE', 'comments/' + encodeURIComponent(target.id), {}).then(function (answer) {
      if (answer.status === 204) {
        comments = comments.filter(function (comment) { return comment.id !== target.id; });
        delete aliases[target.id];
        renderCount();
        if (editing === target) close();
        else sendMarks();
        return;
      }
      // A 404 can be a failed disk write too, so the text stays where the guest can copy it.
      if (editing !== target) return;
      setBusy(false);
      say(failure(answer));
    });
  }

  // ---- the picker's messages ---------------------------------------------------------------

  function receive(message) {
    if (!message || message.source !== 'cezar-design') return;
    if (message.type === 'ready') {
      picker = window.__cezarSharePicker;
      load();
    } else if (message.type === 'rects') {
      rects = {};
      var list = Array.isArray(message.rects) ? message.rects : [];
      for (var i = 0; i < list.length; i++) if (list[i] && typeof list[i].key === 'string') rects[list[i].key] = list[i];
      place();
    } else if (message.type === 'picked') {
      var pick = message.element;
      if (!active || !started || !pick || typeof pick.mark !== 'string' || dirty()) {
        sendMarks(true);
        if (dirty()) ui.text.focus();
        return;
      }
      open({ key: pick.mark, pick: pick, selector: pick.selector }, '');
    } else if (message.type === 'mark-clicked' && typeof message.key === 'string') {
      if (dirty()) { ui.text.focus(); return; }
      for (var j = 0; j < comments.length; j++) {
        if (markOf(comments[j]) === message.key) {
          open({ key: message.key, id: comments[j].id, selector: comments[j].selector }, comments[j].body);
          return;
        }
      }
    } else if (message.type === 'cancel') {
      // Esc in the app: closes the open comment, else leaves comment mode.
      if (editing) close();
      else setActive(false);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
`;
