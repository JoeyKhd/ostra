// Milestone 9's shared pieces: the pictures inside the attachments (demo images, each in its own
// colours so it never reads as ostra's chrome) and the attachment parts, as HTML strings.
// Loaded after `../../m8/html/app-fixture.js` (tallyApp). All data is demo data.
(() => {
  const ic = (name, style = "") => `<i data-lucide="${name}"${style ? ` style="${style}"` : ""}></i>`;

  // ── Pictures ──
  // Tally showing a given sum: the bug report's screenshot and the expected one.
  const tallyWith = (expr, value, opts = {}) => tallyApp(opts).replace("1,027.6 × 1.25 =", expr).replace(">1,284.50<", `>${value}<`);
  // A reviewer's red ring around the display (Linear's screenshot annotation), in the app's own pixels.
  const ring = (x, y, w, h, color = "#e03131") => `<div style="position:absolute;left:${x}px;top:${y}px;width:${w}px;height:${h}px;border:4px solid ${color};border-radius:50%"></div>`;
  const tag = (x, y, text, color = "#e03131") => `<div style="position:absolute;left:${x}px;top:${y}px;padding:6px 12px;border-radius:8px;background:${color};color:#fff;font:600 22px 'Plex Sans'">${text}</div>`;
  const pictures = {
    // 1280×800: percent mode shows 105.62 where finance expects 105.63.
    wrong: () => `<div style="position:relative;width:1280px;height:800px">${tallyWith("12.5% of 845 =", "105.62")}${ring(500, 92, 210, 90)}${tag(470, 190, "should be 105.63")}</div>`,
    // 1280×800: the same sum on the fixed build.
    right: () => `<div style="position:relative;width:1280px;height:800px">${tallyWith("12.5% of 845 =", "105.63")}${ring(500, 92, 210, 90, "#2f9e44")}</div>`,
    // 390×844: the phone build, same bug.
    phone: () => `<div style="position:relative;width:390px;height:844px">${tallyWith("12.5% of 845 =", "105.62", { phone: true })}${ring(196, 86, 184, 74)}</div>`,
    // 1440×900: Dana's design mock of the history panel, a frame from a design tool with two notes.
    mock: () => `
      <div style="position:relative;width:1440px;height:900px;background:#f1f1f3;font-family:'Plex Sans'">
        <div style="position:absolute;left:40px;top:28px;font:500 18px 'Plex Sans';color:#8a8a94">History panel / desktop</div>
        <div style="position:absolute;left:40px;top:70px;width:1360px;height:790px;background:#fff;border-radius:6px;box-shadow:0 1px 3px rgba(0,0,0,.08);overflow:hidden">
          <div style="position:absolute;inset:0;transform:scale(1.0625);transform-origin:0 0;width:1280px;height:744px">${tallyApp()}</div>
        </div>
        <div style="position:absolute;left:1186px;top:236px;width:180px;padding:10px 12px;border-radius:10px 10px 10px 2px;background:#7b61ff;color:#fff;font:500 17px/1.35 'Plex Sans'">"Use" stays on the right</div>
        <div style="position:absolute;left:880px;top:176px;width:150px;padding:10px 12px;border-radius:10px 10px 2px 10px;background:#7b61ff;color:#fff;font:500 17px/1.35 'Plex Sans'">newest first, 50 max</div>
      </div>`,
    // 1280×800: the app as the agent's browser captured it (milestone 8's screenshot).
    app: () => `<div style="position:relative;width:1280px;height:800px">${tallyApp()}</div>`,
    // 1280×800: what Sam pasted, the panel as it renders now, cropped by the OS's snipping tool.
    pasted: () => `<div style="position:relative;width:1280px;height:800px">${tallyApp()}${ring(700, 150, 560, 110, "#f08c00")}</div>`,
  };
  const sizes = { app: [1280, 800], wrong: [1280, 800], right: [1280, 800], phone: [390, 844], mock: [1440, 900], pasted: [1280, 800] };

  // A thumbnail in the thread: `h` tall at the picture's own aspect (task-attachments.md, the strip).
  const thumb = (pic, h, { cap = "", sel = false, asFile = false, label = "" } = {}) => {
    const [vw, vh] = sizes[pic];
    const w = Math.round((vw / vh) * h);
    return `<div class="shot${sel ? " sel" : ""}" title="${label}"><div class="th" style="width:${w}px;height:${h}px"><div class="sc" style="width:${vw}px;height:${vh}px;transform:scale(${h / vh})">${pictures[pic]()}</div>${asFile ? `<span class="asfile">${ic("file")}as a file</span>` : ""}</div>${cap ? `<span class="cap" style="max-width:${Math.max(w, 60)}px">${cap}</span>` : ""}</div>`;
  };

  // An image in the tray: a 52px square, cropped from the top centre.
  const trayImg = (pic, { up = null, focus = false, size = 52 } = {}) => {
    const [vw, vh] = sizes[pic];
    const s = size / Math.min(vw, vh);
    return `<div class="att img${up === null ? "" : " up"}${focus ? " focus" : ""}" style="width:${size}px;height:${size}px"><div class="in"><div class="sc" style="width:${vw}px;height:${vh}px;transform:translate(-50%,-50%) scale(${s})">${pictures[pic]()}</div></div>${up === null ? "" : `<span class="bar"><i style="width:${up}%"></i></span>`}<span class="x" title="Remove">${ic("x")}</span></div>`;
  };

  const typeIcon = (name) => {
    const ext = name.split(".").pop().toLowerCase();
    if (["docx", "doc", "pdf", "md", "txt", "rtf", "odt"].includes(ext)) return "file-text";
    if (["csv", "xlsx", "xls", "ods", "tsv"].includes(ext)) return "file-spreadsheet";
    if (["log", "json", "har", "yaml", "yml", "ts", "js", "sql"].includes(ext)) return "file-code";
    if (["zip", "gz", "tgz", "7z"].includes(ext)) return "file-archive";
    if (["mp4", "mov", "webm"].includes(ext)) return "file-video";
    if (["png", "jpg", "jpeg", "gif", "webp"].includes(ext)) return "image";
    return "file";
  };

  // A file in the tray: its type's icon, its name, then its type and size (or its upload, or its failure).
  const trayFile = (name, meta, { up = null, bad = false, w = null, focus = false } = {}) =>
    `<div class="att file${up === null ? "" : " up"}${bad ? " bad" : ""}${focus ? " focus" : ""}"${w ? ` style="width:${w}px"` : ""}><span class="ti">${ic(bad ? "circle-alert" : typeIcon(name))}</span><span class="tx"><span class="nm">${name}</span><span class="mt">${meta}</span></span>${up === null ? "" : `<span class="bar"><i style="width:${up}%"></i></span>`}<span class="x" title="Remove">${ic("x")}</span></div>`;

  // A file in the thread: a download link with its type, size and, for a document, `text extracted`.
  const fchip = (name, meta, { xt = false, dl = false, hover = false, link = false, gone = false, icon = null } = {}) =>
    `<a class="fchip${hover ? " hover" : ""}${link ? " link" : ""}${gone ? " gone" : ""}"><span class="ti">${ic(icon ?? typeIcon(name))}</span><span class="tx"><span class="nm">${name}</span><span class="mt">${meta}${xt ? ` · <span class="xt">${ic("scan-text")}text extracted</span>` : ""}</span></span>${dl ? `<span class="dl">${ic(link ? "arrow-up-right" : "download")}</span>` : ""}</a>`;

  // The needs-you block at the end of the thread (needs-you-cards.tsx, `ReplyCard`).
  const replyCard = (line) => `<div class="ny"><div class="t">${ic("hand")}Needs you</div><p>${ic("corner-left-up")}<span>${line}</span></p></div>`;

  window.m9 = { ic, pictures, sizes, thumb, trayImg, trayFile, fchip, typeIcon, replyCard, tallyWith };
})();
