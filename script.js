/* ==========================================================================
   S HTML Minifier — engine + UI
   Everything runs client-side. No network calls, no storage of your code.
   ========================================================================== */

(() => {
  "use strict";

  /* ---------------- DOM refs ---------------- */
  const rawEl = document.getElementById("rawHtml");
  const outEl = document.getElementById("minifiedHtml");
  const inputMeta = document.getElementById("inputMeta");
  const outputMeta = document.getElementById("outputMeta");
  const btnMinify = document.getElementById("btnMinify");
  const btnCopy = document.getElementById("btnCopy");
  const btnClear = document.getElementById("btnClear");
  const btnDownload = document.getElementById("btnDownload");
  const btnSample = document.getElementById("btnSample");
  const btnUpload = document.getElementById("btnUpload");
  const fileInput = document.getElementById("fileInput");
  const dropZone = document.getElementById("dropZone");
  const toastStack = document.getElementById("toastStack");

  const statOriginal = document.getElementById("statOriginal");
  const statMinified = document.getElementById("statMinified");
  const statSaved = document.getElementById("statSaved");
  const statPct = document.getElementById("statPct");
  const statBar = document.getElementById("statBar");

  const optionEls = Array.from(document.querySelectorAll(".opt[data-opt]"));

  const OPT_STORE_KEY = "s-html-minifier:options";

  /* ---------------- Options state ---------------- */
  function readOptions() {
    const opts = {};
    optionEls.forEach(el => {
      opts[el.dataset.opt] = el.querySelector("input").checked;
    });
    return opts;
  }

  function saveOptions(opts) {
    try { localStorage.setItem(OPT_STORE_KEY, JSON.stringify(opts)); } catch (e) {}
  }

  function loadOptions() {
    try {
      const raw = localStorage.getItem(OPT_STORE_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw);
      optionEls.forEach(el => {
        const key = el.dataset.opt;
        if (key in saved) el.querySelector("input").checked = !!saved[key];
      });
    } catch (e) {}
  }

  /* ==========================================================================
     Minifier engine
     Strategy: pull out <script>, <style>, <pre>, <textarea> contents first so
     structural whitespace rules never touch them, transform the remaining
     markup, then reinsert (optionally minifying the CSS/JS payloads too).
     ========================================================================== */

  const BOOLEAN_ATTRS = new Set([
    "checked","disabled","selected","readonly","multiple","ismap","defer",
    "async","autofocus","autoplay","controls","hidden","loop","muted",
    "novalidate","open","required","reversed","scoped","itemscope","default"
  ]);

  const REDUNDANT_TYPES = [
    [/(<script\b[^>]*?)\s+type=["']?text\/javascript["']?/gi, "$1"],
    [/(<style\b[^>]*?)\s+type=["']?text\/css["']?/gi, "$1"],
    [/(<link\b[^>]*?)\s+type=["']?text\/css["']?/gi, "$1"]
  ];

  function protectBlocks(html) {
    const store = [];
    const pattern = /<(script|style|pre|textarea)\b([^>]*)>([\s\S]*?)<\/\1\s*>/gi;
    const protectedHtml = html.replace(pattern, (match, tag, attrs, inner) => {
      const idx = store.length;
      store.push({ tag: tag.toLowerCase(), attrs, inner });
      return `\u0001${idx}\u0002`;
    });
    return { protectedHtml, store };
  }

  function minifyCss(css) {
    return css
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\s*\n\s*/g, "")
      .replace(/\s+/g, " ")
      .replace(/\s*([{}:;,])\s*/g, "$1")
      .replace(/;}/g, "}")
      .trim();
  }

  // Conservative, best-effort JS tightening. Deliberately avoids touching
  // string/regex content by only stripping block comments and collapsing
  // blank lines — a full tokenizer is out of scope for a client-side tool.
  function minifyJsLight(js) {
    return js
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .map(line => line.trim())
      .filter(line => line.length > 0)
      .join("\n");
  }

  function applyAttributeRules(html, opts) {
    let out = html;

    if (opts.redundantAttrs) {
      REDUNDANT_TYPES.forEach(([re, repl]) => { out = out.replace(re, repl); });
    }

    if (opts.booleanAttrs) {
      BOOLEAN_ATTRS.forEach(name => {
        const re = new RegExp(`\\s${name}=["']${name}["']`, "gi");
        out = out.replace(re, ` ${name}`);
      });
    }

    if (opts.emptyAttrs) {
      out = out.replace(/\s(class|id|style|title|lang|alt)=["']\s*["']/gi, "");
    }

    if (opts.quotes) {
      // Only strip quotes around values with no whitespace / quote / angle-bracket / backtick / equals chars
      out = out.replace(/(\s[a-zA-Z_:][-a-zA-Z0-9_:.]*)=["']([^"'`=<>\s]+)["']/g, "$1=$2");
    }

    return out;
  }

  // Protected tags (script/style/pre/textarea) keep their opening tag inside
  // the placeholder, so attribute rules need to run on that opening tag too —
  // otherwise `<script type="text/javascript">` never gets cleaned up.
  function cleanOpeningTag(tag, attrs, opts) {
    const wrapped = applyAttributeRules(`<${tag}${attrs}>`, opts);
    const match = wrapped.match(/^<[a-zA-Z0-9]+([\s\S]*)>$/);
    return match ? match[1] : attrs;
  }

  function restoreBlocks(html, store, opts) {
    return html.replace(/\u0001(\d+)\u0002/g, (_, idxStr) => {
      const block = store[Number(idxStr)];
      let { tag, attrs, inner } = block;

      attrs = cleanOpeningTag(tag, attrs, opts);

      if (tag === "style" && opts.css) {
        inner = minifyCss(inner);
      } else if (tag === "script" && opts.js && inner.trim() && !/src\s*=/.test(attrs)) {
        inner = minifyJsLight(inner);
      } else if (tag === "pre" || tag === "textarea") {
        // never touched — preserved verbatim
      }

      return `<${tag}${attrs}>${inner}</${tag}>`;
    });
  }

  function minifyHtml(input, opts) {
    if (!input || !input.trim()) return "";

    let html = input;

    if (opts.comments) {
      // strip HTML comments but keep IE conditional comments (<!--[if ...]>)
      html = html.replace(/<!--(?!\[if)[\s\S]*?-->/g, "");
    }

    const { protectedHtml, store } = protectBlocks(html);
    let out = protectedHtml;

    out = applyAttributeRules(out, opts);

    if (opts.whitespace) {
      out = out
        .replace(/[\t ]*\n[\t ]*/g, "") // strip newlines + surrounding indent
        .replace(/>\s+</g, "><")        // collapse whitespace between tags
        .replace(/[ \t]{2,}/g, " ")     // collapse runs of spaces/tabs
        .trim();
    } else {
      out = out.trim();
    }

    if (opts.doctype) {
      out = out.replace(/<!doctype\s+[^>]*>/i, "<!doctype html>");
    }

    out = restoreBlocks(out, store, opts);

    return out;
  }

  /* ---------------- Stats / formatting ---------------- */
  function byteLength(str) {
    return new Blob([str]).size;
  }

  function formatBytes(n) {
    if (n < 1024) return `${n} B`;
    return `${(n / 1024).toFixed(2)} KB`;
  }

  function lineCount(str) {
    if (!str) return 0;
    return str.split("\n").length;
  }

  function updateMeta() {
    const rawBytes = byteLength(rawEl.value);
    inputMeta.textContent = `${formatBytes(rawBytes)} · ${lineCount(rawEl.value)} lines`;
    const outBytes = byteLength(outEl.value);
    outputMeta.textContent = `${formatBytes(outBytes)} · ${lineCount(outEl.value)} lines`;
  }

  function updateStats() {
    const orig = byteLength(rawEl.value);
    const min = byteLength(outEl.value);
    const saved = Math.max(orig - min, 0);
    const pct = orig > 0 ? (saved / orig) * 100 : 0;

    statOriginal.textContent = formatBytes(orig);
    statMinified.textContent = formatBytes(min);
    statSaved.textContent = formatBytes(saved);
    statPct.textContent = `${pct.toFixed(1)}%`;
    statBar.style.width = `${Math.min(pct, 100)}%`;
  }

  /* ---------------- Toasts ---------------- */
  function toast(message, type = "success") {
    const el = document.createElement("div");
    el.className = `toast toast-${type}`;
    el.innerHTML = `<span class="toast-dot"></span><span>${message}</span>`;
    toastStack.appendChild(el);
    setTimeout(() => {
      el.classList.add("is-leaving");
      setTimeout(() => el.remove(), 220);
    }, 2400);
  }

  /* ---------------- Core actions ---------------- */
  function runMinify({ silent = false } = {}) {
    const opts = readOptions();
    try {
      const result = minifyHtml(rawEl.value, opts);
      outEl.value = result;
      updateMeta();
      updateStats();
      if (!silent && rawEl.value.trim()) toast("Minified successfully");
    } catch (err) {
      if (!silent) toast("Couldn't minify that input — check the markup", "error");
      console.error(err);
    }
  }

  function debounce(fn, wait) {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), wait);
    };
  }
  const autoRun = debounce(() => {
    if (readOptions().auto) runMinify({ silent: true });
  }, 220);

  /* ---------------- Event wiring ---------------- */
  rawEl.addEventListener("input", () => {
    updateMeta();
    autoRun();
  });

  btnMinify.addEventListener("click", () => runMinify());

  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      runMinify();
    }
  });

  btnClear.addEventListener("click", () => {
    rawEl.value = "";
    outEl.value = "";
    updateMeta();
    updateStats();
    rawEl.focus();
  });

  btnCopy.addEventListener("click", async () => {
    if (!outEl.value) {
      toast("Nothing to copy yet — minify something first", "error");
      return;
    }
    try {
      await navigator.clipboard.writeText(outEl.value);
      toast("Copied to clipboard");
      btnCopy.classList.add("is-success");
      setTimeout(() => btnCopy.classList.remove("is-success"), 900);
    } catch (err) {
      toast("Clipboard blocked by browser", "error");
    }
  });

  btnDownload.addEventListener("click", () => {
    if (!outEl.value) {
      toast("Nothing to download yet — minify something first", "error");
      return;
    }
    const blob = new Blob([outEl.value], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "index.min.html";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast("Download started");
  });

  btnSample.addEventListener("click", () => {
    rawEl.value = SAMPLE_HTML;
    updateMeta();
    runMinify();
  });

  btnUpload.addEventListener("click", () => fileInput.click());

  fileInput.addEventListener("change", () => {
    const file = fileInput.files[0];
    if (file) loadFile(file);
    fileInput.value = "";
  });

  function loadFile(file) {
    const reader = new FileReader();
    reader.onload = () => {
      rawEl.value = reader.result;
      updateMeta();
      if (readOptions().auto) runMinify();
      toast(`Loaded ${file.name}`);
    };
    reader.onerror = () => toast("Couldn't read that file", "error");
    reader.readAsText(file);
  }

  ["dragenter", "dragover"].forEach(evt => {
    dropZone.addEventListener(evt, (e) => {
      e.preventDefault();
      dropZone.classList.add("is-dragover");
    });
  });
  ["dragleave", "drop"].forEach(evt => {
    dropZone.addEventListener(evt, (e) => {
      e.preventDefault();
      if (evt === "dragleave" && e.target !== dropZone) return;
      dropZone.classList.remove("is-dragover");
    });
  });
  dropZone.addEventListener("drop", (e) => {
    const file = e.dataTransfer.files[0];
    if (file) loadFile(file);
  });

  optionEls.forEach(el => {
    el.querySelector("input").addEventListener("change", () => {
      saveOptions(readOptions());
      if (readOptions().auto) runMinify({ silent: true });
    });
  });

  /* ---------------- Sample content ---------------- */
  const SAMPLE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <!-- meta tags -->
  <meta charset="UTF-8">
  <title>Sample Page</title>
  <style>
    /* base styles */
    body {
      margin: 0;
      color: #222;
    }
    .card {
      padding: 12px;
    }
  </style>
</head>
<body>

  <div class="card" id="">
    <h1>Hello, world!</h1>
    <input type="text" disabled="disabled" readonly="readonly">
    <script type="text/javascript">
      // greet the user
      function greet() {
        console.log("hi there");
      }
    </script>
  </div>

</body>
</html>`;

  /* ---------------- Init ---------------- */
  loadOptions();
  updateMeta();
  updateStats();
})();
