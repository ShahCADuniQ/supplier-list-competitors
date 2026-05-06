"use client";

// BarcodeGenerator — generate Code128 barcodes and QR codes for any
// inventory piece, project, PO, or asset. Designed mobile-first so it
// can be used right on the shop floor / receiving dock from a phone.
//
// Workflow:
//   1. Pick format (Code128, EAN-13, QR)
//   2. Either type a single value, paste a list (one per line), or
//      auto-generate sequential SKUs (PREFIX-0001, PREFIX-0002, ...)
//   3. Preview live, copy/download a single PNG, or print a sheet of
//      labels suitable for Avery / generic label paper.

import { useEffect, useRef, useState } from "react";
import JsBarcode from "jsbarcode";
import QRCode from "qrcode";

type Format = "CODE128" | "EAN13" | "QR";

const FORMATS: { key: Format; label: string; hint: string }[] = [
  { key: "CODE128", label: "Code 128", hint: "Most common — alphanumeric, any length. Default for SKUs." },
  { key: "EAN13", label: "EAN-13", hint: "13-digit retail barcodes. Validates check digit." },
  { key: "QR", label: "QR Code", hint: "Holds a URL, JSON, or long text. Scannable from any phone." },
];

const SHEET_LAYOUTS = [
  { key: "3x10", label: '3×10 (Avery 5160)', cols: 3, rows: 10 },
  { key: "2x7", label: "2×7 shipping", cols: 2, rows: 7 },
  { key: "4x12", label: "4×12 dense", cols: 4, rows: 12 },
] as const;
type SheetLayoutKey = (typeof SHEET_LAYOUTS)[number]["key"];

type Mode = "single" | "list" | "sequence";

export default function BarcodeGenerator({ canEdit: _canEdit }: { canEdit: boolean }) {
  const [format, setFormat] = useState<Format>("CODE128");
  const [mode, setMode] = useState<Mode>("single");

  // Mode: single
  const [singleValue, setSingleValue] = useState("LB-2026-0001");

  // Mode: list (pasted lines)
  const [listText, setListText] = useState("LB-2026-0001\nLB-2026-0002\nLB-2026-0003");

  // Mode: sequence
  const [seqPrefix, setSeqPrefix] = useState("LB-");
  const [seqStart, setSeqStart] = useState(1);
  const [seqCount, setSeqCount] = useState(30);
  const [seqPad, setSeqPad] = useState(4);

  // Label fields
  const [showLabel, setShowLabel] = useState(true);
  const [labelLine, setLabelLine] = useState("");

  // Sheet layout
  const [sheet, setSheet] = useState<SheetLayoutKey>("3x10");

  const values = computeValues({ mode, singleValue, listText, seqPrefix, seqStart, seqCount, seqPad });
  const previewValues = values.slice(0, 24);

  const previewRef = useRef<HTMLDivElement | null>(null);

  // Render preview barcodes whenever inputs change.
  useEffect(() => {
    const root = previewRef.current;
    if (!root) return;
    const cells = root.querySelectorAll<HTMLElement>("[data-barcode-cell]");
    cells.forEach((cell, i) => {
      const v = previewValues[i];
      if (!v) return;
      renderInto(cell, v, format, labelLine || (showLabel ? v : ""));
    });
  }, [previewValues, format, showLabel, labelLine]);

  const downloadSingle = async () => {
    if (!previewValues[0]) return;
    const png = await renderPng(previewValues[0], format, labelLine || (showLabel ? previewValues[0] : ""));
    const a = document.createElement("a");
    a.href = png;
    a.download = `${previewValues[0]}.png`;
    a.click();
  };

  const printSheet = async () => {
    if (values.length === 0) return;
    const layout = SHEET_LAYOUTS.find((l) => l.key === sheet)!;
    const html = await buildPrintHtml(values, format, showLabel, labelLine, layout);
    const w = window.open("", "_blank", "width=900,height=1100");
    if (!w) return;
    w.document.write(html);
    w.document.close();
    setTimeout(() => w.print(), 400);
  };

  const copyValues = () => {
    void navigator.clipboard.writeText(values.join("\n"));
  };

  return (
    <div className="bc-app">
      <header className="bc-hero">
        <p className="bc-eyebrow">Barcodes</p>
        <h2 className="bc-h1">Generate. Print. Scan.</h2>
        <p className="bc-sub">
          Code 128, EAN-13, and QR — for any piece, project, asset, or shelf.
        </p>
      </header>

      <div className="bc-grid">
        <aside className="bc-sidebar">
          <section className="bc-section">
            <h3>Format</h3>
            <div className="bc-fmt">
              {FORMATS.map((f) => (
                <button
                  key={f.key}
                  type="button"
                  className={`bc-fmt-btn${format === f.key ? " is-on" : ""}`}
                  onClick={() => setFormat(f.key)}
                >
                  <strong>{f.label}</strong>
                  <span>{f.hint}</span>
                </button>
              ))}
            </div>
          </section>

          <section className="bc-section">
            <h3>Source</h3>
            <div className="bc-mode">
              <label className={mode === "single" ? "is-on" : ""}>
                <input type="radio" checked={mode === "single"} onChange={() => setMode("single")} />
                Single value
              </label>
              <label className={mode === "list" ? "is-on" : ""}>
                <input type="radio" checked={mode === "list"} onChange={() => setMode("list")} />
                Paste list
              </label>
              <label className={mode === "sequence" ? "is-on" : ""}>
                <input type="radio" checked={mode === "sequence"} onChange={() => setMode("sequence")} />
                Auto sequence
              </label>
            </div>

            {mode === "single" && (
              <div className="bc-field">
                <label>Value</label>
                <input
                  type="text"
                  value={singleValue}
                  onChange={(e) => setSingleValue(e.target.value)}
                  placeholder={format === "EAN13" ? "12 or 13 digits" : "SKU, URL, or text"}
                />
              </div>
            )}

            {mode === "list" && (
              <div className="bc-field">
                <label>One value per line</label>
                <textarea
                  rows={8}
                  value={listText}
                  onChange={(e) => setListText(e.target.value)}
                  placeholder="LB-2026-0001\nLB-2026-0002\n..."
                />
                <p className="bc-hint">{values.length} values</p>
              </div>
            )}

            {mode === "sequence" && (
              <div className="bc-seq">
                <div className="bc-field">
                  <label>Prefix</label>
                  <input value={seqPrefix} onChange={(e) => setSeqPrefix(e.target.value)} />
                </div>
                <div className="bc-row2">
                  <div className="bc-field">
                    <label>Start</label>
                    <input
                      type="number"
                      value={seqStart}
                      onChange={(e) => setSeqStart(Math.max(0, Number(e.target.value)))}
                    />
                  </div>
                  <div className="bc-field">
                    <label>Count</label>
                    <input
                      type="number"
                      value={seqCount}
                      onChange={(e) => setSeqCount(Math.max(1, Math.min(500, Number(e.target.value))))}
                    />
                  </div>
                </div>
                <div className="bc-field">
                  <label>Zero-pad width</label>
                  <input
                    type="number"
                    value={seqPad}
                    onChange={(e) => setSeqPad(Math.max(0, Math.min(8, Number(e.target.value))))}
                  />
                  <p className="bc-hint">
                    Example: <code>{seqPrefix}{String(seqStart).padStart(seqPad, "0")}</code>
                  </p>
                </div>
              </div>
            )}
          </section>

          <section className="bc-section">
            <h3>Label</h3>
            <label className="bc-toggle">
              <input type="checkbox" checked={showLabel} onChange={(e) => setShowLabel(e.target.checked)} />
              Show value beneath barcode
            </label>
            <div className="bc-field">
              <label>Custom caption (optional)</label>
              <input
                value={labelLine}
                onChange={(e) => setLabelLine(e.target.value)}
                placeholder="e.g., Lightbase / SKU"
              />
            </div>
          </section>

          <section className="bc-section">
            <h3>Print sheet</h3>
            <div className="bc-field">
              <label>Layout</label>
              <select value={sheet} onChange={(e) => setSheet(e.target.value as SheetLayoutKey)}>
                {SHEET_LAYOUTS.map((l) => (
                  <option key={l.key} value={l.key}>{l.label}</option>
                ))}
              </select>
            </div>
            <div className="bc-actions">
              <button className="bc-btn bc-btn-primary" type="button" onClick={printSheet} disabled={values.length === 0}>
                🖨️ Print sheet ({values.length})
              </button>
              <button className="bc-btn" type="button" onClick={downloadSingle} disabled={values.length === 0}>
                ⬇ Download first PNG
              </button>
              <button className="bc-btn" type="button" onClick={copyValues} disabled={values.length === 0}>
                📋 Copy values
              </button>
            </div>
          </section>
        </aside>

        <main className="bc-preview" ref={previewRef}>
          <div className="bc-preview-head">
            <h2>Preview</h2>
            <span className="bc-count">
              {values.length} total • showing {previewValues.length}
            </span>
          </div>
          {previewValues.length === 0 && (
            <p className="bc-empty">Enter a value to see a barcode preview.</p>
          )}
          <div className="bc-cells">
            {previewValues.map((v, i) => (
              <div key={`${v}-${i}`} className="bc-cell" data-barcode-cell />
            ))}
          </div>
          {values.length > previewValues.length && (
            <p className="bc-more">+ {values.length - previewValues.length} more in print sheet</p>
          )}
        </main>
      </div>

      <style>{`
        .bc-app{max-width:1200px;margin:0 auto;padding:48px 32px 96px}

        .bc-hero{text-align:center;margin-bottom:40px}
        .bc-eyebrow{
          font-family:var(--lb-font-display);
          font-size:12.5px;font-weight:600;color:var(--lb-accent);
          letter-spacing:.02em;margin:0 0 10px;
        }
        .bc-h1{
          font-family:var(--lb-font-display);
          font-size:clamp(32px,4.4vw,52px);line-height:1.06;font-weight:600;
          letter-spacing:-.028em;margin:0;color:var(--lb-text);
        }
        .bc-sub{
          font-size:clamp(15px,1.4vw,18px);line-height:1.5;color:var(--lb-text-2);
          margin:14px auto 0;max-width:540px;letter-spacing:-.005em;
        }

        .bc-grid{display:grid;grid-template-columns:380px 1fr;gap:24px}
        .bc-sidebar{display:flex;flex-direction:column;gap:16px}

        .bc-section{
          background:var(--lb-bg-elev);border:1px solid var(--lb-border);
          border-radius:var(--lb-radius);padding:24px;box-shadow:var(--lb-shadow-sm);
        }
        .bc-section h3{
          font-family:var(--lb-font-display);
          font-size:14px;font-weight:600;letter-spacing:-.005em;
          color:var(--lb-text);margin:0 0 16px;
        }

        .bc-fmt{display:flex;flex-direction:column;gap:6px}
        .bc-fmt-btn{
          text-align:left;background:transparent;
          border:1px solid var(--lb-border);
          border-radius:var(--lb-radius-sm);padding:12px 14px;cursor:pointer;
          display:flex;flex-direction:column;gap:3px;
          transition:background .2s ease,border-color .2s ease,transform .1s ease;
          font-family:var(--lb-font-text);
        }
        .bc-fmt-btn:hover{border-color:var(--lb-border-strong);background:color-mix(in srgb,var(--lb-text) 3%,transparent)}
        .bc-fmt-btn:active{transform:scale(.99)}
        .bc-fmt-btn strong{font-size:14px;color:var(--lb-text);font-weight:600;letter-spacing:-.005em}
        .bc-fmt-btn span{font-size:12px;color:var(--lb-text-2);line-height:1.4}
        .bc-fmt-btn.is-on{background:var(--lb-text);border-color:var(--lb-text)}
        .bc-fmt-btn.is-on strong{color:var(--lb-bg-elev)}
        .bc-fmt-btn.is-on span{color:color-mix(in srgb,var(--lb-bg-elev) 70%,transparent)}

        .bc-mode{display:flex;flex-direction:column;gap:6px;margin-bottom:16px}
        .bc-mode label{
          display:flex;align-items:center;gap:10px;
          padding:10px 14px;border:1px solid var(--lb-border);
          border-radius:var(--lb-radius-sm);
          font-size:13px;color:var(--lb-text);cursor:pointer;
          transition:background .2s ease,border-color .2s ease;
          font-family:var(--lb-font-text);letter-spacing:-.005em;
        }
        .bc-mode label:hover{background:color-mix(in srgb,var(--lb-text) 3%,transparent);border-color:var(--lb-border-strong)}
        .bc-mode label.is-on{background:var(--lb-text);color:var(--lb-bg-elev);border-color:var(--lb-text)}
        .bc-mode input{margin:0;accent-color:var(--lb-accent)}

        .bc-field{display:flex;flex-direction:column;gap:6px;margin-bottom:12px}
        .bc-field label{
          font-family:var(--lb-font-text);
          font-size:12px;font-weight:500;color:var(--lb-text-2);
          letter-spacing:-.005em;text-transform:none;
        }
        .bc-field input,.bc-field textarea,.bc-field select{
          padding:10px 12px;
          border:1px solid var(--lb-border-strong);
          border-radius:var(--lb-radius-sm);
          font-size:14px;font-family:var(--lb-font-text);
          background:var(--lb-bg-elev);color:var(--lb-text);
          letter-spacing:-.005em;
          transition:border-color .2s ease,box-shadow .2s ease;
        }
        .bc-field input:focus,.bc-field textarea:focus,.bc-field select:focus{
          outline:none;border-color:var(--lb-accent);
          box-shadow:0 0 0 4px color-mix(in srgb,var(--lb-accent) 18%,transparent);
        }
        .bc-field textarea{font-family:var(--lb-font-mono);font-size:13px;resize:vertical}
        .bc-hint{font-size:12px;color:var(--lb-text-3);margin:2px 0 0;letter-spacing:-.005em}
        .bc-hint code{
          background:color-mix(in srgb,var(--lb-text) 6%,transparent);
          padding:2px 6px;border-radius:4px;font-size:12px;font-family:var(--lb-font-mono);
        }
        .bc-row2{display:grid;grid-template-columns:1fr 1fr;gap:10px}

        .bc-toggle{
          display:flex;align-items:center;gap:10px;
          font-size:13px;color:var(--lb-text);margin-bottom:12px;cursor:pointer;
          letter-spacing:-.005em;
        }
        .bc-toggle input{accent-color:var(--lb-accent)}

        .bc-actions{display:flex;flex-direction:column;gap:8px;margin-top:8px}
        .bc-btn{
          padding:11px 16px;border-radius:var(--lb-radius-pill);
          border:1px solid var(--lb-border-strong);
          background:transparent;color:var(--lb-text);
          font-size:14px;font-weight:500;letter-spacing:-.005em;
          cursor:pointer;font-family:var(--lb-font-text);
          transition:background .2s ease,border-color .2s ease,transform .1s ease;
        }
        .bc-btn:hover:not(:disabled){background:color-mix(in srgb,var(--lb-text) 6%,transparent)}
        .bc-btn:active:not(:disabled){transform:scale(.98)}
        .bc-btn:disabled{opacity:.4;cursor:not-allowed}
        .bc-btn-primary{background:var(--lb-accent);color:#fff;border-color:var(--lb-accent)}
        .bc-btn-primary:hover:not(:disabled){background:var(--lb-accent-hover);border-color:var(--lb-accent-hover)}

        .bc-preview{
          background:var(--lb-bg-elev);
          border:1px solid var(--lb-border);
          border-radius:var(--lb-radius);
          padding:32px;min-height:480px;
          box-shadow:var(--lb-shadow-sm);
        }
        .bc-preview-head{
          display:flex;justify-content:space-between;align-items:baseline;
          margin-bottom:24px;
        }
        .bc-preview-head h2{
          font-family:var(--lb-font-display);
          font-size:22px;font-weight:600;letter-spacing:-.018em;
          color:var(--lb-text);margin:0;
        }
        .bc-count{font-size:13px;color:var(--lb-text-2);letter-spacing:-.005em}
        .bc-empty{
          color:var(--lb-text-3);font-size:15px;
          text-align:center;padding:80px 20px;letter-spacing:-.005em;
        }
        .bc-cells{
          display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));
          gap:12px;
        }
        .bc-cell{
          background:#fff;
          border:1px solid var(--lb-border);
          border-radius:var(--lb-radius-sm);
          padding:18px;display:flex;flex-direction:column;
          align-items:center;justify-content:center;
          min-height:120px;overflow:hidden;
          transition:transform .2s ease,box-shadow .2s ease;
        }
        .bc-cell:hover{transform:translateY(-2px);box-shadow:var(--lb-shadow)}
        .bc-cell svg,.bc-cell canvas,.bc-cell img{max-width:100%;height:auto;display:block}
        .bc-more{font-size:13px;color:var(--lb-text-2);margin:16px 0 0;text-align:center}

        @media (max-width:900px){
          .bc-app{padding:32px 16px 64px}
          .bc-grid{grid-template-columns:1fr}
          .bc-cells{grid-template-columns:repeat(auto-fill,minmax(160px,1fr))}
        }
      `}</style>
    </div>
  );
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function computeValues(args: {
  mode: Mode;
  singleValue: string;
  listText: string;
  seqPrefix: string;
  seqStart: number;
  seqCount: number;
  seqPad: number;
}): string[] {
  if (args.mode === "single") {
    return args.singleValue.trim() ? [args.singleValue.trim()] : [];
  }
  if (args.mode === "list") {
    return args.listText
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
  }
  const out: string[] = [];
  for (let i = 0; i < args.seqCount; i++) {
    const n = String(args.seqStart + i).padStart(args.seqPad, "0");
    out.push(`${args.seqPrefix}${n}`);
  }
  return out;
}

function renderInto(host: HTMLElement, value: string, format: Format, caption: string) {
  host.innerHTML = "";
  if (format === "QR") {
    const canvas = document.createElement("canvas");
    host.appendChild(canvas);
    void QRCode.toCanvas(canvas, value, { width: 160, margin: 1 });
    if (caption) appendCaption(host, caption);
    return;
  }
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  host.appendChild(svg);
  try {
    JsBarcode(svg, value, {
      format: format === "EAN13" ? "EAN13" : "CODE128",
      displayValue: !!caption,
      text: caption || value,
      fontSize: 12,
      height: 60,
      margin: 4,
    });
  } catch {
    host.innerHTML = `<span style="color:#b91c1c;font-size:12px">Invalid for ${format}: ${escapeHtml(value)}</span>`;
  }
}

function appendCaption(host: HTMLElement, caption: string) {
  const span = document.createElement("div");
  span.textContent = caption;
  span.style.cssText = "font-size:11px;color:#0f172a;margin-top:4px;text-align:center;font-family:ui-monospace,monospace";
  host.appendChild(span);
}

async function renderPng(value: string, format: Format, caption: string): Promise<string> {
  if (format === "QR") {
    return await QRCode.toDataURL(value, { width: 400, margin: 1 });
  }
  const canvas = document.createElement("canvas");
  JsBarcode(canvas, value, {
    format: format === "EAN13" ? "EAN13" : "CODE128",
    displayValue: !!caption,
    text: caption || value,
    fontSize: 14,
    height: 80,
    margin: 6,
  });
  return canvas.toDataURL("image/png");
}

async function buildPrintHtml(
  values: string[],
  format: Format,
  showLabel: boolean,
  labelLine: string,
  layout: { cols: number; rows: number; label: string },
): Promise<string> {
  const imgs = await Promise.all(
    values.map(async (v) => {
      try {
        return { v, src: await renderPng(v, format, labelLine || (showLabel ? v : "")) };
      } catch {
        return { v, src: "" };
      }
    }),
  );
  const cells = imgs
    .map(
      (it) =>
        `<div class="cell">${it.src ? `<img src="${it.src}" alt="${escapeHtml(it.v)}" />` : `<span style="color:#b91c1c;font-size:10px">Invalid: ${escapeHtml(it.v)}</span>`}</div>`,
    )
    .join("");
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Barcode sheet (${values.length})</title>
<style>
  *{box-sizing:border-box}
  body{margin:0;padding:0;font-family:system-ui,-apple-system,sans-serif}
  .sheet{display:grid;grid-template-columns:repeat(${layout.cols},1fr);gap:0;padding:12mm}
  .cell{aspect-ratio:${(2 / Math.max(1, Math.round(layout.rows / 5))).toFixed(2)} / 1;display:flex;align-items:center;justify-content:center;padding:6px;border:1px dashed #ddd}
  .cell img{max-width:100%;max-height:100%}
  @media print{
    .cell{border:none}
    @page{margin:0}
  }
</style></head>
<body>
  <div class="sheet">${cells}</div>
</body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}
