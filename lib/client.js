// dsh-mermaid-renderer — client half.
//
// Registers with the DSH web module loader and hooks the additive
// `conversation.chat.turnTail` chain: for every completed turn whose closing
// assistant message contains ```mermaid (or ```mmd) fenced blocks, it renders
// each block as a Mermaid diagram inline under the message.
//
// Both the inline chat card and the fullscreen viewer are pan/zoom viewports
// over the raw SVG (CSS transforms only — the viewport is always vector,
// never rasterized). Inline: drag to pan, ctrl/cmd+scroll or buttons to zoom,
// double-click to zoom in/refit; plain scroll over a fitted diagram scrolls
// the page. Fullscreen: scroll to zoom, drag to pan, double-click to reset.
//
// Timers use the Cordis `timer` service (browser timer globals are trapped in
// dynamic client halves; static bundles follow the same rule).
window.__ModuleLoader__.load({
  id: "dsh-mermaid-renderer",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    var React = require("react");

    // Package-owned stylesheet. Injected once into <head> (a static bundle has
    // no `styles` builtin — the dynamic client half's convenience — so we
    // manage the tag ourselves, same as the shipped DSH UI bundles).
    function injectStyles(css) {
      if (typeof document === "undefined") return;
      var tagId = "dsh-mermaid-renderer/styles";
      if (document.querySelector('style[data-plugin-css="' + tagId + '"]')) return;
      var tag = document.createElement("style");
      tag.dataset.plugin = "dsh-mermaid-renderer";
      tag.dataset.pluginCss = tagId;
      tag.textContent = css;
      document.head.appendChild(tag);
    }

    var CSS = [
      ".dsh-mmd-root { display: flex; flex-direction: column; gap: 10px; margin: 10px 0 4px; }",
      ".dsh-mmd-card { border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-bg-layer-1); padding: 10px 12px; }",
      ".dsh-mmd-head { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }",
      ".dsh-mmd-label { font-size: 11px; letter-spacing: 0.05em; text-transform: uppercase; color: var(--dsw-alias-label-secondary); }",
      ".dsh-mmd-copy { font-size: 11px; letter-spacing: 0.05em; text-transform: uppercase; color: var(--dsw-alias-brand-primary); background: none; border: none; padding: 0; cursor: pointer; }",
      ".dsh-mmd-note { font-size: 12px; color: var(--dsw-alias-label-secondary); }",
      ".dsh-mmd-error { font-size: 12px; color: var(--dsw-alias-state-error-primary); margin-bottom: 6px; white-space: pre-wrap; }",
      ".dsh-mmd-src { margin: 0; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; white-space: pre-wrap; color: var(--dsw-alias-label-primary); }",
      ".dsh-mmd-fs { position: fixed; inset: 0; z-index: 2147483000; width: 100%; height: 100%; display: flex; flex-direction: column; background: var(--dsw-alias-bg-overlay); }",
      ".dsh-mmd-fs-bar { display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-bottom: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); }",
      ".dsh-mmd-fs-hint { flex: 1; font-size: 12px; color: var(--dsw-alias-label-secondary); text-align: right; }",
      ".dsh-mmd-btn { font-size: 12px; color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; padding: 4px 10px; cursor: pointer; }",
      ".dsh-mmd-btn:hover { color: var(--dsw-alias-label-primary); }",
      ".dsh-mmd-pz { position: relative; overflow: hidden; touch-action: none; user-select: none; }",
      ".dsh-mmd-pz-card { max-height: 520px; min-height: 140px; }",
      ".dsh-mmd-pz-fs { flex: 1; }",
      ".dsh-mmd-pz.is-pannable { cursor: grab; }",
      ".dsh-mmd-pz.is-pannable:active { cursor: grabbing; }",
      ".dsh-mmd-pz-content { transform-origin: 0 0; will-change: transform; }",
      ".dsh-mmd-pz-content svg { max-width: none; display: block; }",
      ".dsh-mmd-pz-controls { position: absolute; right: 10px; bottom: 10px; display: flex; gap: 6px; opacity: 0.85; }",
      ".dsh-mmd-pz-hint { position: absolute; left: 10px; bottom: 12px; font-size: 11px; color: var(--dsw-alias-label-secondary); opacity: 0; transition: opacity 0.15s ease; pointer-events: none; }",
      ".dsh-mmd-pz:hover .dsh-mmd-pz-hint { opacity: 1; }",
    ].join("\n");

    exports.inject = ["slots", "timer"];
    exports.apply = (ctx) => {
      var timer = ctx.timer;
      injectStyles(CSS);

      // ---- theme revision store: re-render diagrams when the UI theme flips ----
      var themeRevision = 0;
      var themeListeners = new Set();
      ctx.on("theme/change", () => {
        themeRevision += 1;
        for (const listener of Array.from(themeListeners)) {
          try { listener(); } catch (_) { /* ignore */ }
        }
      });

      // ---- lazy mermaid loader (CDN, cached) ----
      var CDN_SOURCES = [
        "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js",
        "https://unpkg.com/mermaid@11/dist/mermaid.min.js",
      ];
      var mermaidPromise = null;
      function loadMermaid() {
        if (typeof window === "undefined" || typeof document === "undefined") {
          return Promise.reject(new Error("mermaid requires a browser environment"));
        }
        if (window.mermaid) return Promise.resolve(window.mermaid);
        if (mermaidPromise) return mermaidPromise;
        mermaidPromise = new Promise((resolve, reject) => {
          var trySource = (index) => {
            if (index >= CDN_SOURCES.length) {
              mermaidPromise = null;
              reject(new Error("Could not load the mermaid library from any CDN (network or CSP blocked)."));
              return;
            }
            var script = document.createElement("script");
            script.src = CDN_SOURCES[index];
            script.async = true;
            script.onload = () => {
              if (window.mermaid) { resolve(window.mermaid); return; }
              script.remove();
              trySource(index + 1);
            };
            script.onerror = () => {
              script.remove();
              trySource(index + 1);
            };
            document.head.appendChild(script);
          };
          trySource(0);
        });
        return mermaidPromise;
      }

      // Serialize mermaid.render calls: concurrent renders can corrupt its shared state.
      var renderQueue = Promise.resolve();
      function enqueueRender(task) {
        var run = renderQueue.then(task, task);
        renderQueue = run.then(() => {}, () => {});
        return run;
      }
      var idCounter = 0;
      function nextId() {
        idCounter += 1;
        return "dsh-mmd-" + idCounter + "-" + Date.now();
      }

      // Pick a mermaid theme from the actual page background so it follows the DSH theme.
      function detectMermaidTheme() {
        try {
          var match = getComputedStyle(document.body).backgroundColor.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
          if (match) {
            var luminance = (0.299 * Number(match[1]) + 0.587 * Number(match[2]) + 0.114 * Number(match[3])) / 255;
            return luminance < 0.4 ? "dark" : "default";
          }
        } catch (_) { /* keep default */ }
        return "default";
      }

      var FENCE_RE = /```(?:mermaid|mmd)[ \t]*\r?\n([\s\S]*?)(?:```|$)/g;
      function extractMermaid(text) {
        var diagrams = [];
        FENCE_RE.lastIndex = 0;
        var match;
        while ((match = FENCE_RE.exec(text)) !== null) {
          var source = match[1].trim();
          if (source.length > 0) diagrams.push(source);
        }
        return diagrams;
      }

      // ---- pure routing selector for the turn-tail chain ----
      function select(owner) {
        try {
          var tail = owner && owner.turn && owner.turn.data ? owner.turn.data.get("turn-tail") : undefined;
          var closing = tail && tail.closing ? tail.closing : undefined;
          var blocks = closing && Array.isArray(closing.blocks) ? closing.blocks : undefined;
          if (!blocks) return null;
          var text = blocks
            .filter((block) => block && block.kind === "text" && typeof block.text === "string")
            .map((block) => block.text)
            .join("\n");
          var sources = extractMermaid(text);
          if (sources.length === 0) return null;
          return { diagrams: sources.map((source, index) => ({ id: String(index), source })) };
        } catch (_) {
          return null;
        }
      }

      // ---- helpers ----
      function copySource(source) {
        if (typeof navigator !== "undefined" && navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(source).catch(() => {});
        }
      }
      var clamp = (value, min, max) => Math.min(max, Math.max(min, value));

      // Natural (untransformed) size of a mermaid SVG, from its viewBox so CSS
      // transforms never affect fitting — the diagram stays pure vector.
      function svgNaturalSize(svg) {
        try {
          var vb = svg.viewBox && svg.viewBox.baseVal;
          if (vb && vb.width > 0 && vb.height > 0) return { width: vb.width, height: vb.height };
        } catch (_) { /* fall through */ }
        var width = parseFloat(svg.getAttribute("width")) || svg.clientWidth || 100;
        var height = parseFloat(svg.getAttribute("height")) || svg.clientHeight || 100;
        return { width: width, height: height };
      }

      // ---- pan & zoom viewport over the raw SVG (CSS transform only) ----
      // mode 'card': drag pans; plain wheel over a fitted diagram scrolls the
      // page, ctrl/cmd+wheel (or buttons / double-click) zooms, and plain wheel
      // zooms once zoomed in. mode 'fullscreen': plain wheel always zooms.
      function PanZoom(props) {
        var svgHtml = props.svgHtml;
        var mode = props.mode;
        var containerRef = React.useRef(null);
        var contentRef = React.useRef(null);
        var stateRef = React.useRef({ x: 0, y: 0, k: 1, fitK: 1, pannable: false, natural: { width: 100, height: 100 } });
        var dragRef = React.useRef(null);
        var viewState = React.useState({ x: 0, y: 0, k: 1 });
        var view = viewState[0];
        var setView = viewState[1];
        var pannableState = React.useState(false);
        var pannable = pannableState[0];
        var setPannable = pannableState[1];

        var updateViewRef = React.useRef(null);
        updateViewRef.current = (next) => {
          stateRef.current = Object.assign({}, stateRef.current, next);
          setView({ x: stateRef.current.x, y: stateRef.current.y, k: stateRef.current.k });
        };

        // Whether content currently overflows the viewport (drives the grab cursor).
        var syncPannableRef = React.useRef(() => {});
        syncPannableRef.current = () => {
          var container = containerRef.current;
          if (!container) return;
          var state = stateRef.current;
          var pannableNow = state.natural.width * state.k > container.clientWidth + 4 || state.natural.height * state.k > container.clientHeight + 4;
          stateRef.current.pannable = pannableNow;
          setPannable(pannableNow);
        };

        // Fit the diagram into the viewport, centered, at most 100%.
        var fitRef = React.useRef(() => {});
        fitRef.current = () => {
          var container = containerRef.current;
          var content = contentRef.current;
          if (!container || !content) return;
          var svg = content.querySelector("svg");
          if (!svg) return;
          var cw = container.clientWidth;
          var ch = container.clientHeight;
          if (!cw || !ch) return;
          var natural = svgNaturalSize(svg);
          var k = clamp(Math.min((cw - 48) / Math.max(1, natural.width), (ch - 48) / Math.max(1, natural.height)), 0.05, 1);
          updateViewRef.current({ x: (cw - natural.width * k) / 2, y: (ch - natural.height * k) / 2, k: k, fitK: k, natural: natural });
          syncPannableRef.current();
        };

        React.useEffect(() => {
          fitRef.current();
          var container = containerRef.current;
          if (!container) return undefined;
          // Native non-passive wheel listener so preventDefault works (React's
          // synthetic wheel is passive and cannot stop page scrolling).
          var onWheel = (event) => {
            var prev = stateRef.current;
            if (mode === "card") {
              var modifier = event.ctrlKey || event.metaKey;
              if (!modifier && prev.k <= prev.fitK + 0.001) return; // let the page scroll
            }
            event.preventDefault();
            var rect = container.getBoundingClientRect();
            var mx = event.clientX - rect.left;
            var my = event.clientY - rect.top;
            var factor = Math.exp(-event.deltaY * 0.0016);
            var k = clamp(prev.k * factor, 0.05, 8);
            updateViewRef.current({ x: mx - (mx - prev.x) * (k / prev.k), y: my - (my - prev.y) * (k / prev.k), k: k });
            syncPannableRef.current();
          };
          container.addEventListener("wheel", onWheel, { passive: false });
          var observer = null;
          if (typeof ResizeObserver !== "undefined") {
            observer = new ResizeObserver(() => fitRef.current());
            observer.observe(container);
          }
          return () => {
            container.removeEventListener("wheel", onWheel);
            if (observer) observer.disconnect();
          };
        }, [svgHtml, mode]);

        var onPointerDown = (event) => {
          var container = containerRef.current;
          if (!container) return;
          container.setPointerCapture(event.pointerId);
          dragRef.current = {
            id: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            baseX: stateRef.current.x,
            baseY: stateRef.current.y,
          };
        };
        var onPointerMove = (event) => {
          var drag = dragRef.current;
          if (!drag || drag.id !== event.pointerId) return;
          updateViewRef.current({
            x: drag.baseX + (event.clientX - drag.startX),
            y: drag.baseY + (event.clientY - drag.startY),
            k: stateRef.current.k,
          });
        };
        var endDrag = (event) => {
          if (dragRef.current && dragRef.current.id === event.pointerId) dragRef.current = null;
        };
        var zoomBy = (factor) => {
          var container = containerRef.current;
          if (!container) return;
          var rect = container.getBoundingClientRect();
          var mx = rect.width / 2;
          var my = rect.height / 2;
          var prev = stateRef.current;
          var k = clamp(prev.k * factor, 0.05, 8);
          updateViewRef.current({ x: mx - (mx - prev.x) * (k / prev.k), y: my - (my - prev.y) * (k / prev.k), k: k });
          syncPannableRef.current();
        };
        var onDoubleClick = (event) => {
          if (mode === "fullscreen") { fitRef.current(); return; }
          // card: toggle between fit and zoomed-in at the cursor
          var container = containerRef.current;
          if (!container) return;
          var rect = container.getBoundingClientRect();
          var prev = stateRef.current;
          if (prev.k > prev.fitK + 0.05) { fitRef.current(); return; }
          var mx = event.clientX - rect.left;
          var my = event.clientY - rect.top;
          var k = clamp(prev.fitK * 2.5, 0.05, 8);
          updateViewRef.current({ x: mx - (mx - prev.x) * (k / prev.k), y: my - (my - prev.y) * (k / prev.k), k: k });
          syncPannableRef.current();
        };

        var rootClass = "dsh-mmd-pz " + (mode === "card" ? "dsh-mmd-pz-card" : "dsh-mmd-pz-fs") + (pannable ? " is-pannable" : "");
        return React.createElement(
          "div",
          {
            ref: containerRef,
            className: rootClass,
            onPointerDown: onPointerDown,
            onPointerMove: onPointerMove,
            onPointerUp: endDrag,
            onPointerCancel: endDrag,
            onDoubleClick: onDoubleClick,
          },
          React.createElement(
            "div",
            {
              ref: contentRef,
              className: "dsh-mmd-pz-content",
              style: { transform: "translate(" + view.x + "px, " + view.y + "px) scale(" + view.k + ")" },
              dangerouslySetInnerHTML: { __html: svgHtml },
            },
          ),
          React.createElement(
            "span",
            { className: "dsh-mmd-pz-hint" },
            mode === "card" ? "drag to pan \u00b7 ctrl+scroll to zoom \u00b7 double-click to zoom" : "scroll to zoom \u00b7 drag to pan \u00b7 double-click to reset",
          ),
          React.createElement(
            "div",
            { className: "dsh-mmd-pz-controls" },
            React.createElement("button", { type: "button", className: "dsh-mmd-btn", title: "Zoom out", onDoubleClick: (event) => event.stopPropagation(), onClick: () => zoomBy(1 / 1.4) }, "-"),
            React.createElement("button", { type: "button", className: "dsh-mmd-btn", title: "Zoom in", onDoubleClick: (event) => event.stopPropagation(), onClick: () => zoomBy(1.4) }, "+"),
            React.createElement("button", { type: "button", className: "dsh-mmd-btn", title: "Reset view", onDoubleClick: (event) => event.stopPropagation(), onClick: () => fitRef.current() }, "reset"),
          ),
        );
      }

      // ---- fullscreen overlay (native fullscreen when available) ----
      function FullscreenView(props) {
        var svgHtml = props.svgHtml;
        var onClose = props.onClose;
        var overlayRef = React.useRef(null);
        var nativeState = React.useState(false);
        var native = nativeState[0];
        var setNative = nativeState[1];
        var onCloseRef = React.useRef(onClose);
        onCloseRef.current = onClose;

        React.useEffect(() => {
          var el = overlayRef.current;
          var onChange = () => {
            var active = Boolean(el && document.fullscreenElement === el);
            setNative(active);
            if (!active && document.fullscreenElement === null && el) {
              // Native fullscreen was engaged and got exited (Esc) → close overlay.
              onCloseRef.current();
            }
          };
          var onKey = (event) => {
            if (event.key === "Escape") onCloseRef.current();
          };
          document.addEventListener("fullscreenchange", onChange);
          document.addEventListener("keydown", onKey);
          if (el && el.requestFullscreen && !document.fullscreenElement) {
            var request = el.requestFullscreen();
            if (request && typeof request.catch === "function") request.catch(() => {});
          }
          // Best-effort escape hatch: if we are trapped inside a transformed or
          // stacking-context ancestor and native fullscreen did not engage, move
          // the overlay to <body> so `position: fixed` covers the whole viewport.
          var disposeTimer = timer.timeout(() => {
            if (!el || document.fullscreenElement === el) return;
            if (el.parentElement && el.parentElement !== document.body && el.parentElement !== document.documentElement) {
              document.body.appendChild(el);
            }
          }, 120);
          return () => {
            disposeTimer();
            document.removeEventListener("fullscreenchange", onChange);
            document.removeEventListener("keydown", onKey);
            if (document.fullscreenElement && document.fullscreenElement === el) {
              var exit = document.exitFullscreen();
              if (exit && typeof exit.catch === "function") exit.catch(() => {});
            }
          };
        }, []);

        return React.createElement(
          "div",
          { ref: overlayRef, className: "dsh-mmd-fs" },
          React.createElement(
            "div",
            { className: "dsh-mmd-fs-bar" },
            React.createElement("span", { className: "dsh-mmd-label" }, "mermaid"),
            React.createElement(
              "button",
              { type: "button", className: "dsh-mmd-btn", onClick: onClose },
              native ? "exit fullscreen" : "close",
            ),
            React.createElement("span", { className: "dsh-mmd-fs-hint" }, "scroll to zoom \u00b7 drag to pan \u00b7 double-click to reset"),
          ),
          React.createElement(PanZoom, { svgHtml: svgHtml, mode: "fullscreen" }),
        );
      }

      // ---- diagram card ----
      function MermaidBlock(props) {
        var source = props.source;
        var themeTickState = React.useState(0);
        var themeTick = themeTickState[0];
        var setThemeTick = themeTickState[1];
        var stateState = React.useState({ status: "loading", svg: null, error: null });
        var state = stateState[0];
        var setState = stateState[1];
        var expandedState = React.useState(false);
        var expanded = expandedState[0];
        var setExpanded = expandedState[1];

        React.useEffect(() => {
          var listener = () => setThemeTick((tick) => tick + 1);
          themeListeners.add(listener);
          return () => themeListeners.delete(listener);
        }, []);

        React.useEffect(() => {
          var cancelled = false;
          setState({ status: "loading", svg: null, error: null });
          loadMermaid()
            .then((mermaid) => {
              if (cancelled) return;
              mermaid.initialize({ startOnLoad: false, theme: detectMermaidTheme() });
              var id = nextId();
              return enqueueRender(() => mermaid.render(id, source)).then((result) => {
                if (cancelled) return;
                setState({ status: "ready", svg: result && result.svg ? result.svg : null, error: null });
              });
            })
            .catch((error) => {
              if (cancelled) return;
              setState({ status: "error", svg: null, error: (error && error.message) || String(error) });
            });
          return () => { cancelled = true; };
        }, [source, themeTick]);

        var head = React.createElement(
          "div",
          { className: "dsh-mmd-head" },
          React.createElement("span", { className: "dsh-mmd-label" }, "mermaid"),
          state.status === "ready" && state.svg
            ? React.createElement(
                "button",
                { type: "button", className: "dsh-mmd-copy", title: "Open fullscreen with pan and zoom", onClick: () => setExpanded(true) },
                "fullscreen",
              )
            : null,
          React.createElement(
            "button",
            { type: "button", className: "dsh-mmd-copy", onClick: () => copySource(source) },
            "copy source",
          ),
        );

        if (state.status === "ready" && state.svg) {
          return React.createElement(
            React.Fragment,
            null,
            React.createElement(
              "div",
              { className: "dsh-mmd-card" },
              head,
              React.createElement(PanZoom, { svgHtml: state.svg, mode: "card" }),
            ),
            expanded
              ? React.createElement(FullscreenView, { svgHtml: state.svg, onClose: () => setExpanded(false) })
              : null,
          );
        }
        if (state.status === "error") {
          return React.createElement(
            "div",
            { className: "dsh-mmd-card" },
            head,
            React.createElement("div", { className: "dsh-mmd-error" }, state.error),
            React.createElement("pre", { className: "dsh-mmd-src" }, source),
          );
        }
        return React.createElement(
          "div",
          { className: "dsh-mmd-card" },
          head,
          React.createElement("span", { className: "dsh-mmd-note" }, "Rendering diagram\u2026"),
        );
      }

      function MermaidTurnTail(props) {
        var matched = props && props.matched;
        if (!matched || !Array.isArray(matched.diagrams) || matched.diagrams.length === 0) return null;
        return React.createElement(
          "div",
          { className: "dsh-mmd-root" },
          matched.diagrams.map((diagram) =>
            React.createElement(MermaidBlock, { key: diagram.id, source: diagram.source }),
          ),
        );
      }

      // ---- register into the completed-turn tail chain ----
      ctx.slots.inject("conversation.chat.turnTail", () =>
        ctx.slots.register(
          { name: "conversation.chat.turnTail", select: select },
          MermaidTurnTail,
        ),
      );
    };

    return module.exports;
  },
});
