// YEET sign-in pages: wide display headings, stars, the referral slots, and the exit before the next page.
// Plain script, no libraries; the pages work without it.
(function () {
  "use strict";
  var doc = document, root = doc.documentElement;
  var RM = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  var NS = "http://www.w3.org/2000/svg";
  var D = window.YeetTypeData || null;
  var OUT_MS = RM ? 0 : 420;
  function rnd(a, b) { return a + Math.random() * (b - a); }
  function each(sel, fn) { Array.prototype.forEach.call(doc.querySelectorAll(sel), fn); }

  // ---------- display type: Archivo outlines, one svg per word; "YEET" in yellow ----------
  function shift(d, dx) {
    return d.replace(/(-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)/g, function (m, x, y) { return (Math.round((+x + dx) * 10) / 10) + " " + y; });
  }
  function setLine(text) {
    var x = 0, d = "", prev = "";
    for (var i = 0; i < text.length; i++) {
      var ch = text.charAt(i), g = D.wide[ch];
      if (!g) { x += D.space; prev = ""; continue; }
      if (prev && D.kern && D.kern[prev + ch]) x += D.kern[prev + ch];
      d += shift(g[1], x);
      x += g[0] - 34;
      prev = ch;
    }
    return { d: d, w: x + 34 };
  }
  // ---------- the bolt after every YEET (the brand's rule); hidden from screen readers ----------
  var BOLT = "M14.2 1.5 4.5 13.6h6.1L9 22.5l10.5-12.7h-6.4z";
  function bolt() {
    var s = doc.createElementNS(NS, "svg");
    s.setAttribute("class", "wm");
    s.setAttribute("viewBox", "0 0 24 24");
    s.setAttribute("aria-hidden", "true");
    s.setAttribute("focusable", "false");
    var p = doc.createElementNS(NS, "path");
    p.setAttribute("d", BOLT);
    p.setAttribute("fill", "currentColor");
    p.setAttribute("stroke", "currentColor");
    p.setAttribute("stroke-width", "1.2");
    p.setAttribute("stroke-linejoin", "round");
    s.appendChild(p);
    return s;
  }
  var SKIP = "svg,script,style,input,textarea,select,option,.visually-hidden,.wm,#privy-login,#yeet-fund";
  /** Puts the bolt after YEET in the page's own text. The sign-in and fund widgets draw their own. */
  function signWords(node) {
    Array.prototype.slice.call(node.childNodes).forEach(function (child) {
      if (child.nodeType === 1) { if (!child.matches(SKIP)) signWords(child); return; }
      if (child.nodeType !== 3 || !/\bYEET\b/.test(child.nodeValue)) return;
      // One span for the whole text, so a flex parent (a checkbox label, a button) keeps it as one run.
      var out = doc.createElement("span");
      child.nodeValue.split(/\b(YEET)\b/).forEach(function (t, k) {
        if (!t) return;
        if (k % 2) { var w = doc.createElement("span"); w.className = "sw"; w.appendChild(doc.createTextNode(t)); w.appendChild(bolt()); out.appendChild(w); }
        else out.appendChild(doc.createTextNode(t));
      });
      child.parentNode.replaceChild(out, child);
    });
  }

  function setType(el) {
    var text = el.textContent.replace(/\s+/g, " ").trim();
    if (!D || !text) return;
    for (var i = 0; i < text.length; i++) { var c = text.charAt(i); if (c !== " " && !D.wide[c]) return; }
    var out = doc.createDocumentFragment();
    text.split(" ").forEach(function (w) {
      var L = setLine(w);
      var span = doc.createElement("span");
      span.className = w.replace(/[^A-Za-z]/g, "") === "YEET" ? "yw em" : "yw";
      var s = doc.createElementNS(NS, "svg");
      s.setAttribute("viewBox", "0 0 " + Math.round(L.w) + " " + D.em);
      s.setAttribute("aria-hidden", "true");
      s.setAttribute("focusable", "false");
      s.style.width = (L.w / D.em).toFixed(3) + "em";
      var p = doc.createElementNS(NS, "path");
      p.setAttribute("d", L.d);
      s.appendChild(p);
      span.appendChild(s);
      if (w.replace(/[^A-Za-z]/g, "") === "YEET") span.appendChild(bolt());
      out.appendChild(span);
      out.appendChild(doc.createTextNode(" "));
    });
    var label = doc.createElement("span");
    label.className = "visually-hidden";
    label.textContent = text;
    el.textContent = "";
    el.appendChild(label);
    el.appendChild(out);
    el.classList.add("set");
  }

  // ---------- stars: small four-point stars, white and sometimes yellow ----------
  function seedStars(holder, n) {
    for (var i = 0; i < n; i++) {
      var t = doc.createElement("i");
      t.className = "tw";
      t.style.setProperty("--x", rnd(2, 96).toFixed(1) + "%");
      t.style.setProperty("--y", rnd(3, 94).toFixed(1) + "%");
      t.style.setProperty("--s", rnd(6, 14).toFixed(1) + "px");
      t.style.setProperty("--t", rnd(3.5, 7).toFixed(2) + "s");
      t.style.setProperty("--dl", rnd(-7, 0).toFixed(2) + "s");
      t.style.setProperty("--c", Math.random() < 0.35 ? "#FFE03A" : "#FFFFFF");
      holder.appendChild(t);
    }
  }

  // ---------- referral code: six slots over one real field ----------
  function liveSlots(box) {
    var input = box.querySelector("input"), slots = box.querySelectorAll(".slot");
    if (!input || !slots.length) return;
    var max = slots.length, last = "";
    function paint() {
      var v = input.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, max);
      if (input.value !== v) input.value = v;
      for (var i = 0; i < max; i++) {
        var s = slots[i], ch = v.charAt(i);
        s.textContent = ch;
        s.classList.toggle("filled", !!ch);
        s.classList.toggle("at", i === Math.min(v.length, max - 1));
        if (ch && i >= last.length && !RM) { s.classList.remove("pop"); void s.offsetWidth; s.classList.add("pop"); }
      }
      last = v;
    }
    input.addEventListener("input", paint);
    input.addEventListener("focus", function () { var n = input.value.length; try { input.setSelectionRange(n, n); } catch (e) {} });
    last = input.value;
    paint();
    box.classList.add("live");
  }

  // ---------- exit: the card leaves, then the browser moves on ----------
  function leave(then) {
    if (!OUT_MS) return then();
    root.classList.add("leaving");
    setTimeout(then, OUT_MS);
  }
  doc.addEventListener("submit", function (e) {
    var form = e.target;
    if (e.defaultPrevented || !(form instanceof HTMLFormElement) || form.__leaving || !OUT_MS) return;
    e.preventDefault();
    form.__leaving = true;
    var by = e.submitter;
    leave(function () {
      if (by && by.name) {
        var keep = doc.createElement("input");
        keep.type = "hidden";
        keep.name = by.name;
        keep.value = by.value;
        form.appendChild(keep);
      }
      HTMLFormElement.prototype.submit.call(form);
    });
  });
  doc.addEventListener("click", function (e) {
    var a = e.target.closest && e.target.closest("a[href]");
    if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || a.target) return;
    if (a.origin !== location.origin || !OUT_MS) return;
    e.preventDefault();
    leave(function () { location.assign(a.href); });
  });
  window.addEventListener("pageshow", function (e) {
    if (!e.persisted) return;
    root.classList.remove("leaving");
    each("form", function (f) { f.__leaving = false; });
  });
  window.YeetPage = { leave: leave };

  each("h1.display", setType);
  each("main", signWords);
  each(".stars", function (h) { if (!h.firstChild) seedStars(h, RM ? 0 : +(h.getAttribute("data-stars") || 16)); });
  each(".slots", liveSlots);
})();
