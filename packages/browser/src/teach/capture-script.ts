import { TEACH_SENSITIVE_AUTOCOMPLETE, TEACH_SENSITIVE_WORDS } from "@psyche/protocol";

/**
 * The page script behind Record (teach by showing, docs/design/teach-by-showing-2026.md §3).
 *
 * It runs in a named isolated world of the top frame, so the page's own scripts can neither see
 * it nor call the binding it reports through (`Runtime.addBinding` is scoped to that world by
 * name). It listens in the capture phase and reports only what the owner did with real input:
 * `isTrusted` events, so a script on the page cannot make the recorder write steps.
 *
 * What it sends is semantic: the accessibility role and name of the target, a short CSS selector
 * as a fallback, and for typed text the value, except where the field is sensitive: for a
 * password, card, one-time-code, identity or secret field it never reads `value` at all. The
 * recorder checks the same rules again on its side (`classifyTeachField`), so a missed field is
 * caught twice. The script never reads cookies, storage or anything outside the event's target.
 */
export const TEACH_BINDING = "psycheTeachEvent";
export const TEACH_WORLD = "psyche-teach";

/**
 * `binding` is the name the script reports through. The recorder picks an unguessable one per
 * recording (and an unguessable world name), so code the agent runs in a world of its own cannot
 * land on them; while recording the agent's CDP commands are refused anyway.
 */
export function teachCaptureScript(binding: string = TEACH_BINDING): string {
  const rules = JSON.stringify(TEACH_SENSITIVE_WORDS);
  const autocomplete = JSON.stringify(TEACH_SENSITIVE_AUTOCOMPLETE);
  return `(() => {
  "use strict";
  if (window.top !== window || window.__psycheTeachOn) return;
  window.__psycheTeachOn = true;
  var BINDING = ${JSON.stringify(binding)};
  var RULES = ${rules}.map(function (r) { return { reason: r.reason, re: new RegExp(r.source, "i") }; });
  var AC = ${autocomplete};
  var last = new WeakMap();
  // Fields that were ever a password field (a page can flip a field to type=text after the owner
  // started typing, to get its value recorded) or are drawn as dots.
  var wasPassword = new WeakSet();
  var lastSent = "";
  var lastSentAt = 0;

  function txt(s, n) {
    s = String(s == null ? "" : s).replace(/[\\u0000-\\u001f\\u007f\\u2028\\u2029]+/g, " ").replace(/\\s+/g, " ").trim();
    return s.length > n ? s.slice(0, n - 1) + "\\u2026" : s;
  }
  function attr(el, n) { return el.getAttribute ? el.getAttribute(n) : null; }
  function send(o) {
    var s = JSON.stringify(o);
    var now = Date.now();
    if (s === lastSent && now - lastSentAt < 40) return;
    lastSent = s; lastSentAt = now;
    try { var f = window[BINDING]; if (typeof f === "function") f(s); } catch (e) {}
  }
  function textLike(el) {
    var tag = (el.tagName || "").toLowerCase();
    if (tag === "textarea") return true;
    if (tag !== "input") return false;
    var t = (el.type || "text").toLowerCase();
    return ["button", "submit", "reset", "image", "checkbox", "radio", "file", "range", "color", "hidden"].indexOf(t) < 0;
  }
  function labelOf(el) {
    var v = attr(el, "aria-label");
    if (v) return txt(v, 120);
    var by = attr(el, "aria-labelledby");
    if (by) {
      var parts = by.split(/\\s+/).map(function (id) { var n = document.getElementById(id); return n ? n.textContent : ""; });
      v = txt(parts.join(" "), 120);
      if (v) return v;
    }
    if (el.labels && el.labels.length) { v = txt(el.labels[0].textContent, 120); if (v) return v; }
    var wrap = el.closest ? el.closest("label") : null;
    if (wrap) { v = txt(wrap.textContent, 120); if (v) return v; }
    var tag = (el.tagName || "").toLowerCase();
    if (tag === "input" && ["button", "submit", "reset"].indexOf((el.type || "").toLowerCase()) >= 0) {
      v = txt(el.value, 120); if (v) return v;
    }
    if (tag === "img" || (tag === "input" && el.type === "image")) { v = txt(attr(el, "alt"), 120); if (v) return v; }
    if (tag !== "input" && tag !== "textarea" && tag !== "select") { v = txt(el.textContent, 120); if (v) return v; }
    v = txt(attr(el, "placeholder"), 120); if (v) return v;
    v = txt(attr(el, "title"), 120); if (v) return v;
    return txt(attr(el, "name"), 120);
  }
  function roleOf(el) {
    var r = attr(el, "role");
    if (r) return txt(r.split(/\\s+/)[0], 40);
    var tag = (el.tagName || "").toLowerCase();
    if (tag === "a") return attr(el, "href") != null ? "link" : "generic";
    if (tag === "button" || tag === "summary") return "button";
    if (tag === "select") return el.multiple ? "listbox" : "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "option") return "option";
    if (tag === "input") {
      var t = (el.type || "text").toLowerCase();
      if (t === "checkbox" || t === "radio") return t;
      if (["button", "submit", "reset", "image"].indexOf(t) >= 0) return "button";
      if (t === "range") return "slider";
      if (t === "search") return "searchbox";
      if (t === "number") return "spinbutton";
      return "textbox";
    }
    return "generic";
  }
  var INTERACTIVE = "a[href],button,input,select,textarea,summary,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[role=radio],[role=switch],[role=option],[onclick]";
  function target(el) {
    if (!el || el.nodeType !== 1) return null;
    var hit = el.closest ? el.closest(INTERACTIVE) : null;
    return hit || el;
  }
  function safeId(s) { return /^[A-Za-z][\\w-]{0,40}$/.test(s) && !/\\d{4,}/.test(s); }
  function q(s) { return String(s).replace(/["\\\\\\u0000-\\u001f]/g, ""); }
  function selector(el) {
    var tag = (el.tagName || "").toLowerCase();
    var id = el.id;
    if (id && safeId(id)) return "#" + id;
    var tid = attr(el, "data-testid") || attr(el, "data-test");
    if (tid) return "[data-testid=\\"" + q(tid) + "\\"]";
    var nm = attr(el, "name");
    if (nm && tag !== "a") return tag + "[name=\\"" + q(nm) + "\\"]";
    var al = attr(el, "aria-label");
    if (al) return tag + "[aria-label=\\"" + q(txt(al, 60)) + "\\"]";
    var path = [];
    var node = el;
    for (var i = 0; node && node.nodeType === 1 && node !== document.body && i < 4; i++) {
      var t = node.tagName.toLowerCase();
      var idx = 1;
      for (var sib = node.previousElementSibling; sib; sib = sib.previousElementSibling) if (sib.tagName === node.tagName) idx++;
      path.unshift(t + ":nth-of-type(" + idx + ")");
      node = node.parentElement;
    }
    return path.join(" > ");
  }
  function masked(el) {
    try {
      var cs = typeof window.getComputedStyle === "function" ? window.getComputedStyle(el) : null;
      var v = cs ? (cs.getPropertyValue("-webkit-text-security") || cs.webkitTextSecurity || "") : "";
      return !!v && v !== "none";
    } catch (e) { return false; }
  }
  function note(el) {
    if (!el || el.nodeType !== 1) return;
    if (String(el.type || "").toLowerCase() === "password" || masked(el)) wasPassword.add(el);
  }
  function facts(el) {
    note(el);
    return {
      tag: (el.tagName || "").toLowerCase(),
      type: (el.type || "").toLowerCase(),
      autocomplete: txt(attr(el, "autocomplete"), 80),
      name: txt(attr(el, "name"), 80),
      id: txt(el.id, 80),
      label: labelOf(el),
      placeholder: txt(attr(el, "placeholder"), 80),
      inputmode: txt(attr(el, "inputmode"), 20),
      wasPassword: wasPassword.has(el),
    };
  }
  function sensitive(f) {
    if (f.type === "password" || f.wasPassword) return "password";
    var toks = (f.autocomplete || "").toLowerCase().split(/\\s+/);
    for (var i = 0; i < toks.length; i++) {
      if (toks[i].indexOf("cc-") === 0) return "payment";
      for (var j = 0; j < AC.length; j++) if (toks[i] === AC[j].token) return AC[j].reason;
    }
    var text = [f.name, f.id, f.label, f.placeholder].join(" ");
    for (var k = 0; k < RULES.length; k++) if (RULES[k].re.test(text)) return RULES[k].reason;
    return null;
  }
  function describe(el, kind) {
    var f = facts(el);
    return { k: kind, role: roleOf(el), name: f.label, selector: selector(el), f: f };
  }
  function sendValue(el) {
    var tag = (el.tagName || "").toLowerCase();
    if (tag === "select") {
      var d = describe(el, "select");
      var why = sensitive(d.f);
      d.sensitive = !!why; d.reason = why || undefined;
      if (!why) {
        var picked = [];
        for (var i = 0; i < el.options.length; i++) if (el.options[i].selected) picked.push(txt(el.options[i].label || el.options[i].text, 120));
        d.value = picked.join(", ");
      }
      send(d);
      return;
    }
    if (!textLike(el)) return;
    var dd = describe(el, "type");
    var reason = sensitive(dd.f);
    dd.sensitive = !!reason; dd.reason = reason || undefined;
    // A sensitive field's value is never read: not into this object, not into a variable.
    if (!reason) { var v = String(el.value == null ? "" : el.value); last.set(el, v); dd.value = v.slice(0, 500); }
    else last.set(el, "\\u0000");
    send(dd);
  }
  function onClick(e) {
    if (!e.isTrusted) return;
    var el = target(e.target);
    if (!el) return;
    var tag = (el.tagName || "").toLowerCase();
    if (textLike(el) || tag === "select" || tag === "option" || (tag === "input" && (el.type || "").toLowerCase() === "file")) return;
    if (el.isContentEditable) return;
    send(describe(el, "click"));
  }
  function onChange(e) {
    if (!e.isTrusted) return;
    var el = e.target;
    if (!el || el.nodeType !== 1) return;
    sendValue(el);
  }
  function onKey(e) {
    if (e.isTrusted && e.target && e.target.nodeType === 1) note(e.target);
    if (!e.isTrusted || e.key !== "Enter" || e.isComposing) return;
    var el = e.target;
    if (!el || el.nodeType !== 1) return;
    var tag = (el.tagName || "").toLowerCase();
    if (tag !== "input" || !textLike(el)) return;
    // Enter commits the field first: keep the order the owner did it in.
    var f = facts(el);
    var reason = sensitive(f);
    if (!reason && last.get(el) !== String(el.value == null ? "" : el.value)) sendValue(el);
    else if (reason && !last.has(el)) sendValue(el);
    var d = describe(el, "press");
    d.key = "Enter";
    send(d);
  }
  function onFocus(e) { if (e.isTrusted) note(e.target); }
  // On window, in the capture phase, from the document-start script: before any page script.
  window.addEventListener("focusin", onFocus, true);
  window.addEventListener("click", onClick, true);
  window.addEventListener("change", onChange, true);
  window.addEventListener("keydown", onKey, true);
  window.__psycheTeachStop = function () {
    window.removeEventListener("focusin", onFocus, true);
    window.removeEventListener("click", onClick, true);
    window.removeEventListener("change", onChange, true);
    window.removeEventListener("keydown", onKey, true);
    window.__psycheTeachOn = false;
  };
})()`;
}
