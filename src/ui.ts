// Panel DOM and its styles (scoped under .tp-root).

export const HTML = `
  <canvas class="tp-gpu"></canvas>
  <canvas class="tp-text"></canvas>
  <div class="tp-clock"><div class="tp-date">&nbsp;</div><div class="tp-time">--:--:--</div></div>
  <div class="tp-tools">
    <button data-act="in" title="Zoom in (wheel while the panel is active)">+</button>
    <button data-act="out" title="Zoom out">&minus;</button>
    <button data-act="fit" title="Fit (F, or double-click)"><svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="3" width="10" height="10" rx="2"/><circle cx="8" cy="8" r="1.5" fill="currentColor"/></svg></button>
    <button data-act="sound" title="Sound on/off (M)"><svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M2.5 6h2.5l3.5-3v10l-3.5-3H2.5z" fill="currentColor" stroke="none"/><path class="tp-on" d="M10.5 5.5a3.5 3.5 0 0 1 0 5M12.3 3.6a6 6 0 0 1 0 8.8"/><path class="tp-off" d="M10.5 6l4 4M14.5 6l-4 4"/></svg></button>
    <button data-act="full" title="Full screen (Shift+F)"><svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4"/></svg></button>
  </div>
  <div class="tp-error"></div>
  <div class="tp-loading"><div class="tp-spinner"></div><div class="tp-loading-msg">connecting…</div></div>
  <div class="tp-lost" hidden><h3 class="tp-lost-title">The GPU device was lost</h3><p class="tp-lost-msg"></p><button class="tp-restart">Retry WebGPU</button></div>
  <div class="tp-foot"><span class="tp-fps"></span><span><kbd>H</kbd> help</span></div>
  <div class="tp-tip" hidden></div>
  <div class="tp-toast"></div>
  <div class="tp-help" hidden>
    <h3>trace-pong</h3>
    <p>Every ball is one call between two services, replayed from Tempo traces. The request flies
      to the callee and the response goes back once the span and its own calls are done. Errors
      explode. Rings show health (green ok / red errors), as in Grafana's service graph. Rates and
      latencies come from Tempo's service-graph metrics.</p>
    <table>
      <tr><td><kbd>drag</kbd> <kbd>wheel</kbd></td><td>pan / zoom (double-click to re-fit). Wheel zooms once you clicked the panel, in full screen, or with <kbd>ctrl</kbd></td></tr>
      <tr><td><kbd>Shift</kbd>+<kbd>F</kbd></td><td>full screen</td></tr>
      <tr><td><kbd>M</kbd></td><td>sound on/off</td></tr>
      <tr><td><kbd>click</kbd></td><td>pin focus on a service</td></tr>
      <tr><td><kbd>space</kbd></td><td>pause</td></tr>
      <tr><td><kbd>+</kbd> <kbd>-</kbd></td><td>ball speed</td></tr>
      <tr><td><kbd>[</kbd> <kbd>]</kbd></td><td>latency stretch (how long balls are held)</td></tr>
      <tr><td><kbd>B</kbd> <kbd>L</kbd> <kbd>F</kbd></td><td>bloom / labels / fit</td></tr>
    </table>
    <h4>View</h4>
    <div class="tp-toggles">
      <button data-view="endpoints"><i></i><span>Endpoints as nodes, grouped by service; databases by server › database › table</span><kbd>E</kbd></button>
      <button data-view="userNames"><i></i><span>Show user names instead of user ids</span><kbd>U</kbd></button>
      <button data-view="radial"><i></i><span>Radial layout (off: left to right)</span><kbd>R</kbd></button>
    </div>
    <p class="hint">Keys work while the panel has focus (click it). Data source, filters and defaults are in the panel options.</p>
  </div>
  <div class="tp-nogpu" hidden><h3>trace-pong needs WebGPU</h3><p class="tp-nogpu-msg"></p>
    <p>Use a recent Chrome or Edge (on Linux, check <code>chrome://gpu</code>), Safari 26, or Firefox with WebGPU enabled.</p></div>
`;

export const CSS = `
.tp-root { position: absolute; inset: 0; overflow: hidden; background: #05060b; color: #dfe6f2; outline: none;
  font: 13px/1.4 Inter, system-ui, -apple-system, "Segoe UI", sans-serif;
  --tp-mono: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace; --tp-dim: #8b97ad; --tp-bad: #ff4d5e; }
.tp-root canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
.tp-root .tp-text { cursor: grab; }
.tp-root .tp-clock { position: absolute; top: 10px; left: 14px; pointer-events: none; }
.tp-root .tp-date { color: var(--tp-dim); font-size: 11px; letter-spacing: 0.3px; }
.tp-root .tp-time { font: 600 18px/1.1 var(--tp-mono); color: #f4f7fc; text-shadow: 0 0 14px rgba(120, 180, 255, 0.35); }
.tp-root.tp-noclock .tp-clock { display: none; }
.tp-root .tp-tools { position: absolute; top: 10px; right: 12px; display: flex; gap: 4px; z-index: 4; opacity: 0.55; transition: opacity 0.2s; }
.tp-root:hover .tp-tools, .tp-root:focus .tp-tools, .tp-root:fullscreen .tp-tools { opacity: 1; }
.tp-root .tp-tools button { width: 28px; height: 28px; display: grid; place-items: center; padding: 0; cursor: pointer;
  border-radius: 7px; border: 1px solid rgba(255,255,255,0.12); background: rgba(16, 18, 28, 0.75); color: #dfe6f2;
  font: 600 16px/1 var(--tp-mono); }
.tp-root .tp-tools button:hover { background: rgba(40, 46, 66, 0.9); border-color: rgba(0, 229, 255, 0.5); color: #fff; }
.tp-root .tp-tools button .tp-on { display: none; }
.tp-root .tp-tools button.tp-active { color: #00e5ff; border-color: rgba(0, 229, 255, 0.5); }
.tp-root .tp-tools button.tp-active .tp-on { display: inline; }
.tp-root .tp-tools button.tp-active .tp-off { display: none; }
.tp-root:focus { box-shadow: inset 0 0 0 1px rgba(0, 229, 255, 0.25); }
.tp-root:fullscreen { box-shadow: none; }
.tp-root .tp-error { position: absolute; top: 46px; right: 14px; max-width: 60%; text-align: right; color: var(--tp-bad);
  font: 11px var(--tp-mono); pointer-events: none; text-shadow: 0 0 6px #000; }
.tp-root .tp-foot { position: absolute; left: 14px; bottom: 8px; display: flex; gap: 14px; color: var(--tp-dim);
  font: 11px var(--tp-mono); pointer-events: none; }
.tp-root kbd { display: inline-block; padding: 0 5px; border-radius: 4px; border: 1px solid rgba(255,255,255,0.18);
  background: rgba(255,255,255,0.06); font: 600 10px var(--tp-mono); color: #dfe6f2; }
.tp-root .tp-tip { position: absolute; z-index: 5; width: 280px; padding: 12px 14px; border-radius: 12px; pointer-events: none;
  background: rgba(14, 16, 26, 0.92); border: 1px solid rgba(255,255,255,0.12); box-shadow: 0 12px 36px rgba(0,0,0,0.5); }
.tp-root .tp-tip h3 { margin: 0 0 8px; font-size: 14px; display: flex; align-items: center; gap: 8px; color: #fff; }
.tp-root .tp-tip h3 small { color: var(--tp-dim); font-weight: 500; margin-left: auto; font-size: 11px; }
.tp-root .tp-tip .dot { width: 10px; height: 10px; border-radius: 50%; box-shadow: 0 0 10px currentColor; }
.tp-root .tp-tip .kv { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; margin-bottom: 8px; }
.tp-root .tp-tip .kv b { display: block; font: 700 13px var(--tp-mono); }
.tp-root .tp-tip .kv span { color: var(--tp-dim); font-size: 10px; }
.tp-root .tp-tip table { width: 100%; border-collapse: collapse; font: 11px var(--tp-mono); margin-top: 6px; }
.tp-root .tp-tip th { text-align: left; color: var(--tp-dim); font: 600 10px Inter, sans-serif; text-transform: uppercase; letter-spacing: 0.5px; }
.tp-root .tp-tip td { padding: 1px 0; color: #dfe6f2; }
.tp-root .tp-tip td:not(:first-child) { text-align: right; color: var(--tp-dim); }
.tp-root .bad { color: var(--tp-bad) !important; }
.tp-root .hint { color: var(--tp-dim); font-size: 11px; margin: 8px 0 0; opacity: 0.8; }
.tp-root .tp-help { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); width: min(520px, 92%);
  max-height: 92%; overflow: auto; padding: 16px 20px; z-index: 10; border-radius: 14px;
  background: rgba(14, 16, 26, 0.94); border: 1px solid rgba(255,255,255,0.12); }
.tp-root .tp-help h3 { margin: 0 0 6px; color: #fff; }
.tp-root .tp-help p { color: #b9c3d6; }
.tp-root .tp-help td { padding: 3px 12px 3px 0; }
.tp-root code { font-family: var(--tp-mono); color: #00e5ff; }
.tp-root .tp-toast { position: absolute; left: 50%; bottom: 24px; transform: translateX(-50%) translateY(16px); opacity: 0;
  transition: all 0.25s; padding: 6px 14px; border-radius: 999px; background: rgba(16, 18, 28, 0.8);
  border: 1px solid rgba(255,255,255,0.08); font: 12px var(--tp-mono); pointer-events: none; }
.tp-root .tp-toast.show { opacity: 1; transform: translateX(-50%); }
.tp-root .tp-nogpu { position: absolute; inset: 0; display: grid; place-content: center; text-align: center; padding: 20px;
  background: #05060b; z-index: 20; }
.tp-root .tp-help h4 { margin: 14px 0 6px; font-size: 11px; text-transform: uppercase; letter-spacing: 1px; color: var(--tp-dim); }
.tp-root .tp-toggles { display: flex; flex-direction: column; gap: 4px; }
.tp-root .tp-toggles button { display: flex; align-items: center; gap: 10px; padding: 6px 8px; border-radius: 8px; cursor: pointer;
  background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.06); color: #dfe6f2; font: 12px Inter, system-ui, sans-serif; text-align: left; }
.tp-root .tp-toggles button:hover { background: rgba(255,255,255,0.07); }
.tp-root .tp-toggles button span { flex: 1; }
.tp-root .tp-toggles i { position: relative; flex: none; width: 26px; height: 14px; border-radius: 7px; background: rgba(255,255,255,0.15); transition: background 0.2s; }
.tp-root .tp-toggles i::after { content: ""; position: absolute; top: 2px; left: 2px; width: 10px; height: 10px; border-radius: 50%; background: #dfe6f2; transition: left 0.2s; }
.tp-root .tp-toggles button.on i { background: #00b8d4; }
.tp-root .tp-toggles button.on i::after { left: 14px; }
.tp-root .tp-who { margin: -2px 0 8px; display: flex; flex-direction: column; gap: 1px; font-size: 11px; color: var(--tp-dim); }
.tp-root .tp-tip .who, .tp-root .tp-tip .path { margin: -2px 0 8px; display: flex; flex-direction: column; gap: 1px; font-size: 11px; color: var(--tp-dim); }
.tp-root .tp-tip .who b { color: #dfe6f2; font-size: 12px; }
.tp-root .tp-tip .who code { font: 10px var(--tp-mono); color: #00e5ff; word-break: break-all; }
.tp-root .tp-loading { position: absolute; inset: 0; display: grid; place-content: center; justify-items: center; gap: 14px;
  pointer-events: none; color: var(--tp-dim); font: 12px var(--tp-mono); transition: opacity 0.4s; }
.tp-root .tp-loading.done { opacity: 0; }
.tp-root .tp-spinner { width: 34px; height: 34px; border-radius: 50%; border: 2px solid rgba(0, 229, 255, 0.15);
  border-top-color: #00e5ff; box-shadow: 0 0 18px rgba(0, 229, 255, 0.25); animation: tp-spin 0.9s linear infinite; }
@keyframes tp-spin { to { transform: rotate(360deg); } }
.tp-root .tp-lost { position: absolute; top: 46px; left: 50%; transform: translateX(-50%); display: flex; align-items: center; gap: 12px;
  padding: 8px 14px; border-radius: 10px; background: rgba(40, 6, 12, 0.85); border: 1px solid rgba(255, 77, 94, 0.5); z-index: 20; font-size: 12px; }
.tp-root .tp-lost h3 { margin: 0; font-size: 12px; color: #ffd6db; }
.tp-root .tp-lost p { margin: 0; color: var(--tp-dim); font: 11px var(--tp-mono); max-width: 360px; }
.tp-root .tp-lost button { padding: 6px 14px; border-radius: 8px; cursor: pointer; border: 1px solid rgba(0, 229, 255, 0.5);
  background: rgba(0, 229, 255, 0.1); color: #dfe6f2; font: 600 12px Inter, system-ui, sans-serif; }
.tp-root [hidden] { display: none !important; }
`;
