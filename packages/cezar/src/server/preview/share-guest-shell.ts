import {
  GUEST_COMMENT_BODY_MAX,
  GUEST_COMPONENT_MAX,
  GUEST_EXCERPT_MAX,
  GUEST_LABEL_MAX,
  GUEST_SELECTOR_MAX,
} from '@open-mercato/cezar-contract';

/**
 * The share link's guest page (spec 2026-11-28-asset-share-link § Mechanism 4, C3): a cezar-written
 * shell that frames the shared asset and hosts the comment bar and popup. It is the guest's
 * counterpart of the cockpit's `AssetCommentsLayer` and speaks the framed picker's protocol to the
 * frame. The asset stays in its own opaque origin, so nothing here is reachable from its script.
 */

/** The shell's CSP: its own nonce'd script and style, the frame, and the comment endpoints. */
export function guestShellCsp(nonce: string): string {
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    `style-src 'nonce-${nonce}'`,
    "frame-src 'self'",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * The whole document served at `/` to an allowed guest. `frameSrc` is this guest's asset address
 * (C14); `name` is a stranger's text and rides as JSON data, never as markup or source.
 */
export function guestShell(config: { name: string; frameSrc: string; nonce: string; title: string }): string {
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
  const nonce = escapeHtml(config.nonce);
  const title = escapeHtml(config.title);
  // No `sandbox` attribute: the asset's own response header sandboxes it, opened here or directly.
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta name="referrer" content="no-referrer">
<title>${title}</title>
<style nonce="${nonce}">${STYLE}</style>
</head>
<body>
<iframe id="asset" src="${escapeHtml(config.frameSrc)}" title="${title}" referrerpolicy="no-referrer"></iframe>
<div class="ui">
<div class="bar" role="toolbar" aria-label="Comments">
<button type="button" class="toggle" data-slot="toggle" aria-pressed="false">Comment</button>
<span class="count" data-slot="count" title="Your comments">0</span>
<span class="name" data-slot="name"></span>
</div>
<div class="popup" data-slot="popup" role="dialog" aria-label="Comment on this element" hidden>
<div class="element" data-slot="element"></div>
<textarea data-slot="body" maxlength="${GUEST_COMMENT_BODY_MAX}" placeholder="Leave a comment…" aria-label="Comment"></textarea>
<div class="message" data-slot="message" role="alert" hidden></div>
<div class="actions">
<button type="button" class="delete" data-slot="delete">Delete</button>
<button type="button" data-slot="cancel">Cancel</button>
<button type="button" class="save" data-slot="save">Save</button>
</div>
</div>
</div>
<script type="application/json" id="cezar-share-config">${json}</script>
<script nonce="${nonce}">${SHELL_SOURCE}</script>
</body>
</html>
`;
}

const STYLE = String.raw`
html, body { margin: 0; height: 100%; background: #ffffff; }
#asset { position: fixed; inset: 0; width: 100%; height: 100%; border: 0; }
.ui {
  --bg: #ffffff; --fg: #16181d; --muted: #5b6270; --line: #cfd4dc; --field: #ffffff; --danger: #b42318;
  font: 500 13px/1.35 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; color: var(--fg);
}
@media (prefers-color-scheme: dark) {
  .ui { --bg: #181b21; --fg: #eceef2; --muted: #a3abb8; --line: #333945; --field: #0f1115; --danger: #ff8a80; }
}
[hidden] { display: none !important; }
.ui, .ui * { box-sizing: border-box; }
.bar, .popup { position: fixed; z-index: 2147483647; background: var(--bg); color: var(--fg); border: 1px solid var(--line); box-shadow: 0 6px 24px rgba(0, 0, 0, .2); }
.bar { right: 16px; bottom: 16px; display: flex; align-items: center; gap: 8px; max-width: calc(100vw - 32px); padding: 5px 12px 5px 5px; border-radius: 999px; }
.count { min-width: 22px; padding: 2px 6px; border-radius: 999px; background: #a3e635; color: #1a2e05; font-weight: 700; text-align: center; font-variant-numeric: tabular-nums; }
.name { color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 14em; }
.ui button { font: inherit; color: inherit; cursor: pointer; padding: 5px 12px; border-radius: 999px; border: 1px solid var(--line); background: transparent; }
.ui button:disabled { opacity: .6; cursor: default; }
.ui button:focus-visible, .ui textarea:focus-visible { outline: 2px solid #4f8cff; outline-offset: 2px; }
.ui .toggle[aria-pressed="true"], .ui .save { background: #2563eb; border-color: #2563eb; color: #ffffff; }
.popup { width: min(320px, calc(100vw - 16px)); padding: 12px; border-radius: 12px; display: flex; flex-direction: column; gap: 8px; }
.element { font: 600 12px/1.3 ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ui textarea { width: 100%; min-height: 76px; resize: vertical; padding: 8px; font: inherit; color: var(--fg); background: var(--field); border: 1px solid var(--line); border-radius: 8px; }
.message { color: var(--danger); font-size: 12px; }
.actions { display: flex; gap: 8px; justify-content: flex-end; }
.delete { margin-right: auto; }
`;

// Every guest-visible string (the name, a body, a selector, a server error) goes in as text or a
// field value. What the frame reports is the asset's to forge, so it is read as data and nothing more.
// Positions are set through the CSSOM: the CSP has no 'unsafe-inline' for a style attribute.
const SHELL_SOURCE = String.raw`(function () {
  'use strict';
  var cfg = JSON.parse(document.getElementById('cezar-share-config').textContent);
  var BASE = '/__cezar_share__/';
  var ENDED = 'This link has ended — your comment was not saved.';
  var FAILED = 'Your comment could not be saved. Try again.';
  var RETRY_MAX = 6;

  var frame = document.getElementById('asset');
  // The picker in the frame said "ready"; nothing is posted to a page that has no picker yet.
  var ready = false;
  var comments = [];
  var loaded = false;
  var loads = 0;
  var writes = 0;
  var active = false;
  // { key, pick?, id?, selector } — the comment in the popup; "id" once it is saved.
  var editing = null;
  var busy = false;
  // A comment saved in this document keeps the picker key its element was framed under.
  var aliases = {};
  var rects = {};
  var lastMarks = '';
  var retries = 0;

  function slot(name) {
    return document.querySelector('[data-slot="' + name + '"]');
  }

  var ui = {
    toggle: slot('toggle'),
    count: slot('count'),
    name: slot('name'),
    popup: slot('popup'),
    element: slot('element'),
    text: slot('body'),
    message: slot('message'),
    remove: slot('delete'),
    cancel: slot('cancel'),
    save: slot('save')
  };

  // '*': the frame's origin is opaque and cannot be named. Only selectors and numbers go this way.
  function tell(message) {
    var target = frame.contentWindow;
    if (!ready || !target) return;
    message.source = 'cezar-design-host';
    try { target.postMessage(message, '*'); } catch (e) { /* the frame is gone */ }
  }

  function clip(text, max) {
    text = typeof text === 'string' ? text : '';
    return text.length > max ? text.slice(0, max - 1) + '…' : text;
  }

  function tail(selector) {
    var parts = String(selector || '').split(' > ');
    return parts[parts.length - 1];
  }

  function markOf(comment) {
    return aliases[comment.id] || comment.id;
  }

  // ---- marks -------------------------------------------------------------------------------

  // Only while Comment is on (C16): exploring shows the mockup, not frames. Numbered in list
  // order; the comment being written is framed unnumbered, and found again if the frame reloads.
  function wanted() {
    var list = [];
    if (!active) return list;
    for (var i = 0; i < comments.length; i++) {
      list.push({ key: markOf(comments[i]), n: i + 1, selector: comments[i].selector });
    }
    if (editing && !editing.id) list.push({ key: editing.key, selector: editing.selector });
    return list;
  }

  function sendMarks(force) {
    if (!ready || !loaded) return;
    var list = wanted();
    var serialized = JSON.stringify(list);
    if (!force && serialized === lastMarks) return;
    lastMarks = serialized;
    tell({ type: 'set-marks', marks: list });
  }

  // A saved comment's element may render after the page loads, or belong to another state of the
  // mockup: one the picker has not framed is dropped and asked for again, so it is found by its
  // selector anew. A few tries, then nothing until a frame moves or Comment is switched on again.
  function retryMissing() {
    if (!active || !ready || !loaded || retries >= RETRY_MAX) return;
    var list = wanted();
    var found = [];
    var missing = false;
    for (var i = 0; i < list.length; i++) {
      if (list[i].selector && !rects[list[i].key]) missing = true;
      else found.push(list[i]);
    }
    if (!missing) return;
    retries++;
    tell({ type: 'set-marks', marks: found });
    sendMarks(true);
  }

  // ---- the bar and the popup ---------------------------------------------------------------

  function renderCount() {
    ui.count.textContent = String(comments.length);
  }

  function setActive(next) {
    // Text typed and not saved would lose its element's frame: it is saved or cancelled first.
    if (!next && editing) {
      if (dirty()) { ui.text.focus(); return; }
      close();
    }
    active = next;
    retries = 0;
    ui.toggle.setAttribute('aria-pressed', active ? 'true' : 'false');
    tell({ type: 'set-active', active: active });
    sendMarks(true);
  }

  function say(text) {
    ui.message.textContent = text || '';
    ui.message.hidden = !text;
  }

  function num(value) {
    return typeof value === 'number' && isFinite(value) ? value : 0;
  }

  // Under the element, above it when there is no room below, always inside the viewport. The
  // frame fills the window from its corner, so the frame's coordinates are this page's.
  function place() {
    if (!editing) return;
    var rect = rects[editing.key] || (editing.pick && editing.pick.rect);
    var width = ui.popup.offsetWidth || 320;
    var height = ui.popup.offsetHeight || 160;
    var vw = window.innerWidth;
    var vh = window.innerHeight;
    var left, top;
    if (rect && typeof rect === 'object') {
      top = num(rect.y) + num(rect.height) + 8;
      if (top + height > vh - 8) top = num(rect.y) - height - 8;
      left = num(rect.x);
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

  // Not while a save or delete is in flight: a failed answer must find the text still in the popup.
  function close() {
    if (!editing || busy) return;
    var hadFocus = ui.popup.contains(document.activeElement);
    editing = null;
    busy = false;
    ui.popup.hidden = true;
    sendMarks();
    if (hadFocus) ui.toggle.focus();
  }

  // Text the guest has typed and not saved: a stray click must not throw it away.
  function dirty() {
    if (!editing) return false;
    if (busy) return true;
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
    ui.cancel.disabled = next;
  }

  function onPopupKey(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      save();
    }
  }

  // Esc with the keyboard on the bar: closes the open comment, else leaves comment mode. Esc
  // pressed inside the mockup arrives as the picker's "cancel" instead.
  function onPageKey(event) {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    if (editing) close();
    else if (active) setActive(false);
  }

  // ---- the share listener ------------------------------------------------------------------

  // Answers { status, body }; status 0 when the request never got one.
  function request(method, name, payload) {
    var init = { method: method, credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' } };
    if (payload !== undefined) {
      init.headers['content-type'] = 'application/json';
      init.body = JSON.stringify(payload);
    }
    return window.fetch(BASE + name, init).then(function (res) {
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
    return !!value && typeof value.id === 'string' && typeof value.selector === 'string' && typeof value.body === 'string';
  }

  // A list read before a save answered would drop that save: it is read again instead.
  function load() {
    var turn = ++loads;
    var before = writes;
    request('GET', 'comments').then(function (answer) {
      if (turn !== loads) return;
      if (before !== writes) { load(); return; }
      var list = answer.status === 200 && answer.body && answer.body.comments;
      // A failed read keeps what is on screen; the first one has nothing to keep.
      if (Array.isArray(list)) {
        comments = [];
        for (var i = 0; i < list.length; i++) if (isComment(list[i])) comments.push(list[i]);
      }
      loaded = true;
      renderCount();
      sendMarks(true);
    });
  }

  function componentOf(pick) {
    var names = Array.isArray(pick.components) ? pick.components.slice().reverse() : [];
    for (var i = 0; i < names.length; i++) if (typeof names[i] !== 'string') return undefined;
    if (!names.length) return undefined;
    return clip(names.join(' › ') + (typeof pick.source === 'string' && pick.source ? ' (' + pick.source + ')' : ''), cfg.componentMax);
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
      // No asset and no address: the server names the asset from the share itself.
      var input = {
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
      if (ok) { writes++; renderCount(); }
      setBusy(false);
      if (editing !== target) { sendMarks(); return; }
      if (ok) { close(); return; }
      say(failure(answer));
    });
  }

  function remove() {
    var target = editing;
    if (!target || !target.id || busy) return;
    setBusy(true);
    say('');
    request('DELETE', 'comments/' + encodeURIComponent(target.id), {}).then(function (answer) {
      setBusy(false);
      if (answer.status === 204) {
        writes++;
        comments = comments.filter(function (comment) { return comment.id !== target.id; });
        delete aliases[target.id];
        renderCount();
        if (editing === target) close();
        else sendMarks();
        return;
      }
      // A 404 can be a failed disk write too, so the text stays where the guest can copy it.
      if (editing !== target) return;
      say(failure(answer));
    });
  }

  // ---- the picker's messages ---------------------------------------------------------------

  function receive(message) {
    if (!message || typeof message !== 'object' || message.source !== 'cezar-design') return;
    if (message.type === 'ready') {
      // A new document in the frame: its picker knows no key and no state of the last one.
      var again = ready;
      ready = true;
      aliases = {};
      rects = {};
      lastMarks = '';
      retries = 0;
      if (active) tell({ type: 'set-active', active: true });
      sendMarks(true);
      // The owner may have removed a comment since; the first list is already on its way.
      if (again) load();
    } else if (message.type === 'rects') {
      rects = {};
      retries = 0;
      var list = Array.isArray(message.rects) ? message.rects : [];
      for (var i = 0; i < list.length; i++) if (list[i] && typeof list[i].key === 'string') rects[list[i].key] = list[i];
      place();
    } else if (message.type === 'picked') {
      var pick = message.element;
      var usable = !!pick && typeof pick === 'object' && typeof pick.mark === 'string' && typeof pick.selector === 'string' && pick.selector !== '';
      if (!active || !loaded || !usable || dirty()) {
        sendMarks(true);
        if (dirty()) ui.text.focus();
        return;
      }
      open({ key: pick.mark, pick: pick, selector: pick.selector }, '');
    } else if (message.type === 'mark-clicked' && typeof message.key === 'string') {
      if (!active) return;
      if (dirty()) { ui.text.focus(); return; }
      for (var j = 0; j < comments.length; j++) {
        if (markOf(comments[j]) === message.key) {
          open({ key: message.key, id: comments[j].id, selector: comments[j].selector }, comments[j].body);
          return;
        }
      }
    } else if (message.type === 'cancel') {
      // Esc in the mockup: closes the open comment unless it holds unsaved text, else leaves comment mode.
      if (editing) { if (!dirty()) close(); }
      else setActive(false);
    } else if (message.type === 'toggle') {
      // The picker's own key, pressed in the mockup: it only ever leaves comment mode.
      if (active) setActive(false);
    }
  }

  // THIS frame only. Its origin is opaque, so the window is the check: the top page, another
  // frame and a popup are all somebody else.
  window.addEventListener('message', function (event) {
    if (!event.source || event.source !== frame.contentWindow) return;
    receive(event.data);
  });

  ui.name.textContent = cfg.name;
  ui.toggle.addEventListener('click', function () { setActive(!active); });
  ui.remove.addEventListener('click', remove);
  ui.cancel.addEventListener('click', close);
  ui.save.addEventListener('click', save);
  ui.popup.addEventListener('keydown', onPopupKey);
  document.addEventListener('keydown', onPageKey);
  window.addEventListener('resize', place);
  setInterval(retryMissing, 500);
  load();
})();
`;
