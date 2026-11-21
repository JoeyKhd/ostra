// The app the agent is building, as the preview pane shows it: "Tally", acme/calculator-web's own UI.
// It has its own look on purpose (light, blue accent, square keys), so it never reads as ostra's chrome.
// tallyApp({ phone }) returns its HTML; the layout follows the pane's width like a real responsive page.
window.tallyApp = ({ phone = false } = {}) => {
  const css = `
  <style>
    .tally { --t-bg: #ffffff; --t-ink: #1d2433; --t-mute: #667085; --t-line: #e6e8ee; --t-soft: #f5f6f9; --t-acc: #3b5bdb; --t-acc-soft: #edf1ff;
      width: 100%; height: 100%; background: var(--t-bg); color: var(--t-ink); font: 400 14px/1.45 'Plex Sans', sans-serif; display: flex; flex-direction: column; overflow: hidden; }
    .tally .t-head { height: 52px; flex: none; display: flex; align-items: center; gap: 22px; padding: 0 22px; border-bottom: 1px solid var(--t-line); }
    .tally .t-logo { display: flex; align-items: center; gap: 8px; font: 700 16px 'Manrope', sans-serif; letter-spacing: -0.01em; }
    .tally .t-logo i { width: 22px; height: 22px; border-radius: 6px; background: var(--t-acc); display: grid; place-items: center; color: #fff; font: 700 13px 'Manrope'; font-style: normal; }
    .tally .t-nav { display: flex; gap: 18px; color: var(--t-mute); font-weight: 500; }
    .tally .t-nav .on { color: var(--t-ink); }
    .tally .t-me { margin-left: auto; width: 28px; height: 28px; border-radius: 50%; background: #dfe5ff; color: var(--t-acc); display: grid; place-items: center; font: 600 11px 'Plex Sans'; }
    .tally .t-body { flex: 1; min-height: 0; display: flex; align-items: flex-start; gap: 20px; padding: 22px; background: var(--t-soft); }
    .tally .t-calc { flex: 1.1; min-width: 0; background: var(--t-bg); border: 1px solid var(--t-line); border-radius: 12px; padding: 18px; display: flex; flex-direction: column; }
    .tally .t-expr { text-align: right; color: var(--t-mute); font: 400 15px 'Plex Mono', monospace; }
    .tally .t-disp { text-align: right; font: 600 40px/1.15 'Manrope', sans-serif; letter-spacing: -0.02em; margin: 4px 0 14px; }
    .tally .t-keys { display: grid; grid-template-columns: repeat(4, 1fr); grid-auto-rows: 50px; gap: 8px; }
    .tally .t-keys span { display: grid; place-items: center; border-radius: 8px; background: var(--t-soft); font: 500 17px 'Plex Sans'; }
    .tally .t-keys .op { background: var(--t-acc-soft); color: var(--t-acc); }
    .tally .t-keys .eq { background: var(--t-acc); color: #fff; }
    .tally .t-hist { flex: 0.9; align-self: stretch; min-width: 0; background: var(--t-bg); border: 1px solid var(--t-line); border-radius: 12px; display: flex; flex-direction: column; overflow: hidden; }
    .tally .t-hist .hh { display: flex; align-items: baseline; gap: 8px; padding: 14px 16px 10px; border-bottom: 1px solid var(--t-line); }
    .tally .t-hist .hh b { font: 700 15px 'Manrope'; }
    .tally .t-hist .hh span { color: var(--t-mute); font-size: 12.5px; }
    .tally .t-hist .hh a { margin-left: auto; color: var(--t-acc); font-size: 13px; }
    .tally .t-item { display: flex; align-items: center; gap: 10px; padding: 9px 16px; border-bottom: 1px solid var(--t-line); }
    .tally .t-item .e { color: var(--t-mute); font: 400 12.5px 'Plex Mono'; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .tally .t-item .v { font: 600 15px 'Plex Sans'; }
    .tally .t-item .c { display: flex; flex-direction: column; min-width: 0; }
    .tally .t-item .u { margin-left: auto; font-size: 12.5px; color: var(--t-acc); border: 1px solid #c9d3ff; border-radius: 6px; padding: 2px 9px; flex: none; }
    .tally .t-item.new { background: var(--t-acc-soft); }
    .tally.phone .t-head { padding: 0 16px; gap: 0; }
    .tally.phone .t-nav { display: none; }
    .tally.phone .t-body { flex-direction: column; align-items: stretch; padding: 12px; gap: 12px; }
    .tally.phone .t-calc { flex: none; padding: 14px; }
    .tally.phone .t-disp { font-size: 34px; margin-bottom: 10px; }
    .tally.phone .t-keys { gap: 6px; }
    .tally.phone .t-keys { grid-auto-rows: 44px; }
    .tally.phone .t-hist { flex: 1; }
  </style>`;
  const keys = ["C", "±", "%", "÷", "7", "8", "9", "×", "4", "5", "6", "−", "1", "2", "3", "+", "0", "00", ".", "="]
    .map((k) => `<span class="${"÷×−+".includes(k) ? "op" : k === "=" ? "eq" : ""}">${k}</span>`).join("");
  const hist = [
    ["1,027.6 × 1.25", "1,284.50", true],
    ["12% of 845", "101.40"],
    ["(18 + 24) ÷ 3", "14"],
    ["2,400 − 318.75", "2,081.25"],
    ["19.99 × 3", "59.97"],
    ["√ 1,764", "42"],
  ].slice(0, phone ? 3 : 6)
    .map(([e, v, n]) => `<div class="t-item${n ? " new" : ""}"><div class="c"><span class="e">${e}</span><span class="v">${v}</span></div><span class="u">Use</span></div>`).join("");
  return `${css}
  <div class="tally${phone ? " phone" : ""}">
    <div class="t-head"><span class="t-logo"><i>T</i>Tally</span><span class="t-nav"><span class="on">Calculator</span><span>History</span><span>Settings</span></span><span class="t-me">SR</span></div>
    <div class="t-body">
      <div class="t-calc"><div class="t-expr">1,027.6 × 1.25 =</div><div class="t-disp">1,284.50</div><div class="t-keys">${keys}</div></div>
      <div class="t-hist"><div class="hh"><b>History</b><span>last 50</span><a>Clear</a></div>${hist}</div>
    </div>
  </div>`;
};
