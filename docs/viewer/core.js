// PageStudio — shared document model + rendering (used by the editor and the print/export view)
'use strict';
(function () {
  const PS = (window.PS = window.PS || {});

  // ------------------------------------------------------------------ units & ids
  PS.PT_PER_IN = 72;
  PS.PX_PER_PT = 96 / 72;
  PS.uid = (p = 'o') => p + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-3);
  PS.clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  PS.round = (v, d = 2) => Math.round(v * 10 ** d) / 10 ** d;
  PS.inches = (pt) => PS.round(pt / 72, 2);
  PS.escapeHtml = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  PS.PAGE_PRESETS = [
    { id: 'letter', name: 'Letter', w: 612, h: 792 },
    { id: 'letter-l', name: 'Letter (landscape)', w: 792, h: 612 },
    { id: 'bulletin', name: 'Bulletin — Letter folded (landscape)', w: 792, h: 612 },
    { id: 'legal', name: 'Legal', w: 612, h: 1008 },
    { id: 'legal-l', name: 'Legal (landscape)', w: 1008, h: 612 },
    { id: 'tabloid', name: 'Tabloid (11 × 17)', w: 792, h: 1224 },
    { id: 'half', name: 'Half Letter (5.5 × 8.5)', w: 396, h: 612 },
    { id: 'a4', name: 'A4', w: 595.28, h: 841.89 },
    { id: 'a5', name: 'A5', w: 419.53, h: 595.28 },
    { id: 'postcard', name: 'Postcard (4 × 6)', w: 288, h: 432 },
    { id: 'card57', name: 'Card (5 × 7)', w: 360, h: 504 },
    { id: 'bizcard', name: 'Business card (3.5 × 2)', w: 252, h: 144 },
    { id: 'index', name: 'Index card (3 × 5)', w: 216, h: 360 },
    { id: 'poster', name: 'Poster (18 × 24)', w: 1296, h: 1728 },
  ];

  PS.FALLBACK_FONTS = [
    'Arial', 'Arial Black', 'Bahnschrift', 'Book Antiqua', 'Bookman Old Style', 'Calibri', 'Calibri Light', 'Cambria',
    'Candara', 'Century Gothic', 'Century Schoolbook', 'Comic Sans MS', 'Consolas', 'Constantia', 'Corbel',
    'Courier New', 'Edwardian Script ITC', 'Franklin Gothic Medium', 'Garamond', 'Georgia', 'Gill Sans MT',
    'Impact', 'Lucida Calligraphy', 'Lucida Handwriting', 'Lucida Sans', 'Monotype Corsiva', 'Old English Text MT',
    'Palatino Linotype', 'Segoe Print', 'Segoe Script', 'Segoe UI', 'Tahoma', 'Times New Roman', 'Trebuchet MS',
    'Verdana',
  ];

  // ------------------------------------------------------------------ document
  PS.newDoc = (w = 612, h = 792) => ({
    format: 'pagestudio',
    version: 1,
    page: { width: w, height: h, margins: { top: 36, right: 36, bottom: 36, left: 36 }, background: '#ffffff' },
    master: { objects: [] },
    scratch: { objects: [] },   // Publisher-style scratch area: off-page items shared by all pages, never printed
    pages: [PS.newPage()],
    assets: {},
  });
  PS.newPage = () => ({ id: PS.uid('p'), objects: [], useMaster: true, background: null });

  PS.defaultFont = { family: 'Calibri', size: 12, color: '#000000' };

  // ------------------------------------------------------------------ several pages on one sheet (labels, half sheets, cards)
  // page.sheet = { width, height, layouts: [[nx, ny, x0, y0, dx, dy], ...], shape, radius, hole, label }
  //   or (from Publisher files) { width, height, marginX, marginY, gapX, gapY }
  /** Where each copy of the page lands on the sheet, in printing order (left to right, then down). */
  PS.sheetCells = (page) => {
    const sh = page && page.sheet;
    if (!sh || !sh.width || !sh.height) return null;
    const cells = [];
    if (Array.isArray(sh.layouts) && sh.layouts.length) {
      for (const [nx, ny, x0, y0, dx, dy] of sh.layouts) {
        for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) cells.push({ x: x0 + i * dx, y: y0 + j * dy });
      }
      cells.sort((a, b) => (Math.abs(a.y - b.y) > 0.5 ? a.y - b.y : a.x - b.x));
    } else {
      const mx = sh.marginX || 0, my = sh.marginY || 0, gx = sh.gapX || 0, gy = sh.gapY || 0;
      const cols = Math.max(1, Math.floor((sh.width - 2 * mx + gx + 0.5) / (page.width + gx)));
      const rows = Math.max(1, Math.floor((sh.height - 2 * my + gy + 0.5) / (page.height + gy)));
      const usedW = cols * page.width + (cols - 1) * gx, usedH = rows * page.height + (rows - 1) * gy;
      const ox = mx || Math.max(0, (sh.width - usedW) / 2), oy = my || Math.max(0, (sh.height - usedH) / 2);
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) cells.push({ x: ox + c * (page.width + gx), y: oy + r * (page.height + gy) });
    }
    return { width: sh.width, height: sh.height, cells, cols: new Set(cells.map(c => Math.round(c.x))).size, rows: new Set(cells.map(c => Math.round(c.y))).size };
  };
  /** A sheet that fits as many copies of a small page as possible on Letter paper (for "multiple copies per sheet"). */
  PS.autoSheet = (page, paper = { width: 612, height: 792 }) => {
    const fit = (W, H) => Math.floor(W / page.width) * Math.floor(H / page.height);
    const land = fit(paper.height, paper.width) > fit(paper.width, paper.height);
    const W = land ? paper.height : paper.width, H = land ? paper.width : paper.height;
    const nx = Math.floor(W / page.width), ny = Math.floor(H / page.height);
    if (nx * ny < 2) return null;
    return { width: W, height: H, layouts: [[nx, ny, (W - nx * page.width) / 2, (H - ny * page.height) / 2, page.width, page.height]] };
  };

  PS.makeText = (props = {}) => Object.assign({
    id: PS.uid(), type: 'text', x: 72, y: 72, w: 216, h: 72, rotation: 0,
    html: '<p><br></p>',
    font: Object.assign({}, PS.defaultFont),
    fill: null, stroke: null, strokeWidth: 0, opacity: 1,
    padding: [2.88, 2.88, 2.88, 2.88], valign: 'top', columns: 1, columnGap: 14.4, lineHeight: 1.15,
    shrinkToFit: false,
  }, props);

  PS.makeShape = (kind = 'rect', props = {}) => Object.assign({
    id: PS.uid(), type: 'shape', kind, x: 72, y: 72, w: 144, h: 108, rotation: 0,
    fill: '#c8a868', stroke: '#6b4a2b', strokeWidth: 1, dash: 'solid', radius: 12, opacity: 1,
    html: '', font: Object.assign({}, PS.defaultFont, { color: '#ffffff' }),
    padding: [7.2, 7.2, 7.2, 7.2], valign: 'middle', lineHeight: 1.15,
  }, props);

  PS.makeImage = (asset, props = {}) => Object.assign({
    id: PS.uid(), type: 'image', asset, x: 72, y: 72, w: 216, h: 144, rotation: 0,
    fit: 'stretch', focusX: 50, focusY: 50, opacity: 1, stroke: null, strokeWidth: 0, radius: 0, wrap: 'square',
    flipH: false, flipV: false,
  }, props);

  /**
   * Pictures, like Publisher: resizing a picture stretches it to the frame. A cropped picture keeps its crop
   * (fit 'crop', with crop = { l, t, r, b }: the fraction cut off each side of the original) and the part that's left
   * is stretched. 'cover' (Fill) and 'contain' (Fit) are the ribbon's Fill and Fit.
   * Where the whole picture sits inside its frame (frame coordinates, pt): { x, y, w, h }.
   */
  PS.imagePlacement = (o, aw, ah) => {
    const fit = o.fit || 'stretch';
    if (fit === 'crop' && o.crop) {
      const c = o.crop;
      const IW = o.w / Math.max(0.01, 1 - c.l - c.r), IH = o.h / Math.max(0.01, 1 - c.t - c.b);
      return { x: -c.l * IW, y: -c.t * IH, w: IW, h: IH };
    }
    if ((fit === 'cover' || fit === 'contain') && aw && ah) {
      const k = fit === 'cover' ? Math.max(o.w / aw, o.h / ah) : Math.min(o.w / aw, o.h / ah);
      const w = aw * k, h = ah * k;
      return { x: (o.w - w) * ((o.focusX ?? 50) / 100), y: (o.h - h) * ((o.focusY ?? 50) / 100), w, h };
    }
    return { x: 0, y: 0, w: o.w, h: o.h };
  };
  /** The same as a crop: the part of the picture that shows. Turns Fill (cover) into an explicit crop. */
  PS.cropOf = (o, aw, ah) => {
    if (o.fit === 'crop' && o.crop) return Object.assign({}, o.crop);
    if (o.fit === 'contain' || !aw || !ah) return { l: 0, t: 0, r: 0, b: 0 };
    const p = PS.imagePlacement(o, aw, ah);
    const l = -p.x / p.w, t = -p.y / p.h;
    return { l: Math.max(0, l), t: Math.max(0, t), r: Math.max(0, 1 - l - o.w / p.w), b: Math.max(0, 1 - t - o.h / p.h) };
  };
  /** Back to the whole picture in its own proportions (same width, same centre), uncropped and unstretched. */
  PS.resetPictureShape = (o, a) => {
    if (a && a.w && a.h) { const cy = o.y + o.h / 2; o.h = o.w * a.h / a.w; o.y = cy - o.h / 2; }
    o.fit = 'stretch'; delete o.crop; o.focusX = 50; o.focusY = 50; o.cropShape = null;
  };
  /** Source rectangle of the picture (in its own pixels) that fills the frame, for drawing to a canvas. */
  PS.imageSourceRect = (o, iw, ih) => {
    if (o.fit === 'contain') return null;
    const c = (o.fit === 'stretch' || !o.fit) ? { l: 0, t: 0, r: 0, b: 0 } : PS.cropOf(o, iw, ih);
    return { sx: c.l * iw, sy: c.t * ih, sw: Math.max(1, (1 - c.l - c.r) * iw), sh: Math.max(1, (1 - c.t - c.b) * ih) };
  };

  PS.makeLine = (props = {}) => Object.assign({
    id: PS.uid(), type: 'line', x1: 72, y1: 72, x2: 288, y2: 72,
    stroke: '#000000', strokeWidth: 1.5, dash: 'solid', arrowStart: false, arrowEnd: false, opacity: 1,
  }, props);

  // Bounding box (unrotated) for any object
  PS.bbox = (o) => {
    if (o.type === 'line') {
      return { x: Math.min(o.x1, o.x2), y: Math.min(o.y1, o.y2), w: Math.abs(o.x2 - o.x1), h: Math.abs(o.y2 - o.y1) };
    }
    return { x: o.x, y: o.y, w: o.w, h: o.h };
  };
  // Axis-aligned bounds including rotation
  PS.visualBounds = (o) => {
    const b = PS.bbox(o);
    const r = ((o.rotation || 0) * Math.PI) / 180;
    if (!r || o.type === 'line') return b;
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    const c = Math.abs(Math.cos(r)), s = Math.abs(Math.sin(r));
    const W = b.w * c + b.h * s, H = b.w * s + b.h * c;
    return { x: cx - W / 2, y: cy - H / 2, w: W, h: H };
  };
  PS.isOffPage = (o, pg) => {
    const b = PS.visualBounds(o);
    return b.x + b.w <= 0 || b.y + b.h <= 0 || b.x >= pg.width || b.y >= pg.height;
  };
  PS.moveObj = (o, dx, dy) => {
    if (o.type === 'line') { o.x1 += dx; o.x2 += dx; o.y1 += dy; o.y2 += dy; }
    else { o.x += dx; o.y += dy; }
  };

  // ------------------------------------------------------------------ shapes
  PS.SHAPES = [
    { kind: 'rect', name: 'Rectangle' },
    { kind: 'roundrect', name: 'Rounded rectangle' },
    { kind: 'ellipse', name: 'Oval' },
    { kind: 'triangle', name: 'Triangle' },
    { kind: 'diamond', name: 'Diamond' },
    { kind: 'pentagon', name: 'Pentagon' },
    { kind: 'hexagon', name: 'Hexagon' },
    { kind: 'octagon', name: 'Octagon' },
    { kind: 'star5', name: 'Star' },
    { kind: 'heart', name: 'Heart' },
    { kind: 'cross', name: 'Cross' },
    { kind: 'plus', name: 'Plus' },
    { kind: 'arrowRight', name: 'Right arrow' },
    { kind: 'arrowLeft', name: 'Left arrow' },
    { kind: 'speech', name: 'Speech bubble' },
    { kind: 'banner', name: 'Ribbon banner' },
    { kind: 'rtriangle', name: 'Right triangle' },
    { kind: 'parallelogram', name: 'Parallelogram' },
    { kind: 'trapezoid', name: 'Trapezoid' },
    { kind: 'snip1', name: 'Snip corner rectangle' },
    { kind: 'snip2diag', name: 'Snip diagonal corners' },
    { kind: 'round2diag', name: 'Round diagonal corners' },
    { kind: 'round1', name: 'Round one corner' },
    { kind: 'star4', name: '4-point star' },
    { kind: 'star6', name: '6-point star' },
    { kind: 'star8', name: '8-point star' },
    { kind: 'star12', name: '12-point seal' },
    { kind: 'sun', name: 'Sun' },
    { kind: 'moon', name: 'Moon' },
    { kind: 'cloud', name: 'Cloud' },
    { kind: 'lightning', name: 'Lightning bolt' },
    { kind: 'arrowUp', name: 'Up arrow' },
    { kind: 'arrowDown', name: 'Down arrow' },
    { kind: 'arrowLR', name: 'Left-right arrow' },
    { kind: 'chevron', name: 'Chevron' },
    { kind: 'homePlate', name: 'Pentagon arrow' },
    { kind: 'calloutRect', name: 'Rectangular callout' },
    { kind: 'cloudCallout', name: 'Thought bubble' },
    { kind: 'frame', name: 'Frame' },
    { kind: 'donut', name: 'Donut' },
    { kind: 'teardrop', name: 'Teardrop' },
    { kind: 'cylinder', name: 'Can' },
    { kind: 'wave', name: 'Wave' },
    { kind: 'scroll', name: 'Scroll' },
    { kind: 'flowDecision', name: 'Decision' },
    { kind: 'flowDocument', name: 'Document' },
  ];

  const poly = (pts) => 'M' + pts.map(p => p[0].toFixed(2) + ' ' + p[1].toFixed(2)).join(' L') + ' Z';
  const regular = (n, w, h, rot = -Math.PI / 2) => {
    const pts = [];
    for (let i = 0; i < n; i++) {
      const a = rot + (i * 2 * Math.PI) / n;
      pts.push([w / 2 + (w / 2) * Math.cos(a), h / 2 + (h / 2) * Math.sin(a)]);
    }
    return pts;
  };

  PS.shapePath = (kind, w, h, o = {}) => {
    switch (kind) {
      case 'custom': {
        const pa = o.path; if (!pa) return `M0 0 H${w} V${h} H0 Z`;
        const sx = w / pa.w, sy = h / pa.h, f = (x, y) => ((x - pa.ox) * sx).toFixed(2) + ' ' + ((y - pa.oy) * sy).toFixed(2);
        return pa.cmds.map(c => c[0] === 'Z' ? 'Z' : c[0] === 'C' ? `C${f(c[1], c[2])} ${f(c[3], c[4])} ${f(c[5], c[6])}` : `${c[0]}${f(c[1], c[2])}`).join(' ');
      }
      case 'roundrect': {
        const r = Math.min(o.radius ?? 12, w / 2, h / 2);
        return `M${r} 0 H${w - r} A${r} ${r} 0 0 1 ${w} ${r} V${h - r} A${r} ${r} 0 0 1 ${w - r} ${h} H${r} A${r} ${r} 0 0 1 0 ${h - r} V${r} A${r} ${r} 0 0 1 ${r} 0 Z`;
      }
      case 'ellipse':
        return `M0 ${h / 2} A${w / 2} ${h / 2} 0 1 0 ${w} ${h / 2} A${w / 2} ${h / 2} 0 1 0 0 ${h / 2} Z`;
      case 'triangle': return poly([[w / 2, 0], [w, h], [0, h]]);
      case 'diamond': return poly([[w / 2, 0], [w, h / 2], [w / 2, h], [0, h / 2]]);
      case 'pentagon': return poly(regular(5, w, h));
      case 'hexagon': return poly([[w * 0.25, 0], [w * 0.75, 0], [w, h / 2], [w * 0.75, h], [w * 0.25, h], [0, h / 2]]);
      case 'octagon': {
        const c = Math.min(w, h) * 0.2929;
        return poly([[c, 0], [w - c, 0], [w, c], [w, h - c], [w - c, h], [c, h], [0, h - c], [0, c]]);
      }
      case 'star5': {
        const pts = [];
        for (let i = 0; i < 10; i++) {
          const a = -Math.PI / 2 + (i * Math.PI) / 5;
          const rr = i % 2 ? 0.382 : 1;
          pts.push([w / 2 + (w / 2) * rr * Math.cos(a), h / 2 + (h / 2) * rr * Math.sin(a) + h * 0.05 * (1 - rr)]);
        }
        return poly(pts);
      }
      case 'heart': {
        const X = (v) => (v * w).toFixed(2), Y = (v) => (v * h).toFixed(2);
        return `M${X(.5)} ${Y(.24)} C${X(.5)} ${Y(.1)} ${X(.36)} ${Y(0)} ${X(.23)} ${Y(0)} C${X(.08)} ${Y(0)} ${X(0)} ${Y(.13)} ${X(0)} ${Y(.29)} C${X(0)} ${Y(.56)} ${X(.3)} ${Y(.76)} ${X(.5)} ${Y(1)} C${X(.7)} ${Y(.76)} ${X(1)} ${Y(.56)} ${X(1)} ${Y(.29)} C${X(1)} ${Y(.13)} ${X(.92)} ${Y(0)} ${X(.77)} ${Y(0)} C${X(.64)} ${Y(0)} ${X(.5)} ${Y(.1)} ${X(.5)} ${Y(.24)} Z`;
      }
      case 'cross': {
        const t = Math.min(w * 0.3, h * 0.22);
        const cx = w / 2, cy = h * 0.3;
        return poly([[cx - t / 2, 0], [cx + t / 2, 0], [cx + t / 2, cy - t / 2], [w, cy - t / 2], [w, cy + t / 2], [cx + t / 2, cy + t / 2],
          [cx + t / 2, h], [cx - t / 2, h], [cx - t / 2, cy + t / 2], [0, cy + t / 2], [0, cy - t / 2], [cx - t / 2, cy - t / 2]]);
      }
      case 'plus': {
        const tw = w * 0.34, th = h * 0.34;
        const x1 = (w - tw) / 2, x2 = x1 + tw, y1 = (h - th) / 2, y2 = y1 + th;
        return poly([[x1, 0], [x2, 0], [x2, y1], [w, y1], [w, y2], [x2, y2], [x2, h], [x1, h], [x1, y2], [0, y2], [0, y1], [x1, y1]]);
      }
      case 'arrowRight': {
        const hl = Math.min(h, w * 0.45);
        return poly([[0, h * 0.25], [w - hl, h * 0.25], [w - hl, 0], [w, h / 2], [w - hl, h], [w - hl, h * 0.75], [0, h * 0.75]]);
      }
      case 'arrowLeft': {
        const hl = Math.min(h, w * 0.45);
        return poly([[w, h * 0.25], [hl, h * 0.25], [hl, 0], [0, h / 2], [hl, h], [hl, h * 0.75], [w, h * 0.75]]);
      }
      case 'speech': {
        const bh = h * 0.78, r = Math.min(o.radius ?? 12, w / 4, bh / 3);
        return `M${r} 0 H${w - r} A${r} ${r} 0 0 1 ${w} ${r} V${bh - r} A${r} ${r} 0 0 1 ${w - r} ${bh} H${w * 0.38} L${w * 0.18} ${h} L${w * 0.24} ${bh} H${r} A${r} ${r} 0 0 1 0 ${bh - r} V${r} A${r} ${r} 0 0 1 ${r} 0 Z`;
      }
      case 'banner': {
        const n = Math.min(w * 0.08, h * 0.5);
        return poly([[0, 0], [w, 0], [w - n, h / 2], [w, h], [0, h], [n, h / 2]]);
      }
      case 'rtriangle': return poly([[0, 0], [w, h], [0, h]]);
      case 'parallelogram': { const k = w * 0.22; return poly([[k, 0], [w, 0], [w - k, h], [0, h]]); }
      case 'trapezoid': { const k = w * 0.2; return poly([[k, 0], [w - k, 0], [w, h], [0, h]]); }
      case 'snip1': { const c = Math.min(w, h) * 0.18; return poly([[0, 0], [w - c, 0], [w, c], [w, h], [0, h]]); }
      case 'snip2diag': { const c = Math.min(w, h) * 0.18; return poly([[c, 0], [w, 0], [w, h - c], [w - c, h], [0, h], [0, c]]); }
      case 'round2diag': {
        const r = Math.min(w, h) * 0.2;
        return `M${r} 0 H${w} V${h - r} A${r} ${r} 0 0 1 ${w - r} ${h} H0 V${r} A${r} ${r} 0 0 1 ${r} 0 Z`;
      }
      case 'round1': { const r = Math.min(w, h) * 0.2; return `M0 0 H${w - r} A${r} ${r} 0 0 1 ${w} ${r} V${h} H0 Z`; }
      case 'star4': case 'star6': case 'star8': case 'star12': {
        const pts = +kind.slice(4), inner = { 4: 0.38, 6: 0.55, 8: 0.62, 12: 0.75 }[pts];
        const out = [];
        for (let i = 0; i < pts * 2; i++) {
          const a = -Math.PI / 2 + (i * Math.PI) / pts, rr = i % 2 ? inner : 1;
          out.push([w / 2 + (w / 2) * rr * Math.cos(a), h / 2 + (h / 2) * rr * Math.sin(a)]);
        }
        return poly(out);
      }
      case 'sun': {
        const cx = w / 2, cy = h / 2, rx = w * 0.26, ry = h * 0.26;
        let d = `M${cx - rx} ${cy} A${rx} ${ry} 0 1 0 ${cx + rx} ${cy} A${rx} ${ry} 0 1 0 ${cx - rx} ${cy} Z`;
        for (let i = 0; i < 8; i++) {
          const a = (i * Math.PI) / 4, a1 = a - 0.16, a2 = a + 0.16;
          const p = (ang, k) => `${(cx + Math.cos(ang) * w / 2 * k).toFixed(2)} ${(cy + Math.sin(ang) * h / 2 * k).toFixed(2)}`;
          d += ` M${p(a1, 0.62)} L${p(a, 1)} L${p(a2, 0.62)} Z`;
        }
        return d;
      }
      case 'moon': return `M${w * 0.75} 0 A${w * 0.75} ${h / 2} 0 1 0 ${w * 0.75} ${h} A${w * 0.5} ${h * 0.5} 0 1 1 ${w * 0.75} 0 Z`;
      case 'cloud': case 'cloudCallout': {
        const X = (v) => (v * w).toFixed(2), Y = (v) => (v * h).toFixed(2);
        let d = `M${X(.18)} ${Y(.78)} C${X(.02)} ${Y(.78)} ${X(0)} ${Y(.52)} ${X(.14)} ${Y(.46)} C${X(.06)} ${Y(.26)} ${X(.3)} ${Y(.12)} ${X(.42)} ${Y(.24)} C${X(.48)} ${Y(.04)} ${X(.78)} ${Y(.02)} ${X(.8)} ${Y(.26)} C${X(.98)} ${Y(.24)} ${X(1.02)} ${Y(.52)} ${X(.9)} ${Y(.6)} C${X(1)} ${Y(.78)} ${X(.84)} ${Y(.9)} ${X(.72)} ${Y(.82)} C${X(.64)} ${Y(.96)} ${X(.36)} ${Y(.96)} ${X(.3)} ${Y(.84)} C${X(.26)} ${Y(.86)} ${X(.22)} ${Y(.82)} ${X(.18)} ${Y(.78)} Z`;
        if (kind === 'cloudCallout') {
          const c = (cx, cy, r) => ` M${X(cx - r)} ${Y(cy)} A${(r * w).toFixed(2)} ${(r * w).toFixed(2)} 0 1 0 ${X(cx + r)} ${Y(cy)} A${(r * w).toFixed(2)} ${(r * w).toFixed(2)} 0 1 0 ${X(cx - r)} ${Y(cy)} Z`;
          d += c(0.2, 0.92, 0.04) + c(0.1, 0.98, 0.022);
        }
        return d;
      }
      case 'lightning': return poly([[w * 0.38, 0], [w * 0.62, 0], [w * 0.5, h * 0.36], [w * 0.8, h * 0.36], [w * 0.28, h], [w * 0.42, h * 0.52], [w * 0.15, h * 0.52]]);
      case 'arrowUp': { const hl = Math.min(w, h * 0.45); return poly([[w * 0.25, h], [w * 0.25, hl], [0, hl], [w / 2, 0], [w, hl], [w * 0.75, hl], [w * 0.75, h]]); }
      case 'arrowDown': { const hl = Math.min(w, h * 0.45); return poly([[w * 0.25, 0], [w * 0.75, 0], [w * 0.75, h - hl], [w, h - hl], [w / 2, h], [0, h - hl], [w * 0.25, h - hl]]); }
      case 'arrowLR': { const hl = Math.min(h, w * 0.25); return poly([[0, h / 2], [hl, 0], [hl, h * 0.25], [w - hl, h * 0.25], [w - hl, 0], [w, h / 2], [w - hl, h], [w - hl, h * 0.75], [hl, h * 0.75], [hl, h]]); }
      case 'chevron': { const k = Math.min(w * 0.4, h * 0.5); return poly([[0, 0], [w - k, 0], [w, h / 2], [w - k, h], [0, h], [k, h / 2]]); }
      case 'homePlate': { const k = Math.min(w * 0.4, h * 0.5); return poly([[0, 0], [w - k, 0], [w, h / 2], [w - k, h], [0, h]]); }
      case 'calloutRect': { const bh = h * 0.78; return poly([[0, 0], [w, 0], [w, bh], [w * 0.42, bh], [w * 0.2, h], [w * 0.25, bh], [0, bh]]); }
      case 'frame': {
        const t = Math.min(w, h) * 0.12;
        return `M0 0 H${w} V${h} H0 Z M${t} ${t} V${h - t} H${w - t} V${t} Z`;
      }
      case 'donut': {
        const rx = w / 2, ry = h / 2, ix = rx * 0.55, iy = ry * 0.55;
        return `M0 ${ry} A${rx} ${ry} 0 1 0 ${w} ${ry} A${rx} ${ry} 0 1 0 0 ${ry} Z M${rx - ix} ${ry} A${ix} ${iy} 0 1 1 ${rx + ix} ${ry} A${ix} ${iy} 0 1 1 ${rx - ix} ${ry} Z`;
      }
      case 'teardrop': return `M${w / 2} 0 H${w} V${h / 2} A${w / 2} ${h / 2} 0 1 1 ${w / 2} 0 Z`;
      case 'cylinder': {
        const e = h * 0.12;
        return `M0 ${e} A${w / 2} ${e} 0 0 1 ${w} ${e} V${h - e} A${w / 2} ${e} 0 0 1 0 ${h - e} Z M0 ${e} A${w / 2} ${e} 0 0 0 ${w} ${e}`;
      }
      case 'wave': {
        const a = h * 0.12;
        return `M0 ${a} C${w * 0.25} ${-a} ${w * 0.25} ${3 * a} ${w / 2} ${a} S${w * 0.75} ${-a} ${w} ${a} V${h - a} C${w * 0.75} ${h + a} ${w * 0.75} ${h - 3 * a} ${w / 2} ${h - a} S${w * 0.25} ${h + a} 0 ${h - a} Z`;
      }
      case 'scroll': {
        const r = Math.min(w, h) * 0.08;
        return `M${r} ${r * 2} A${r} ${r} 0 0 1 ${r * 2} ${r} H${w - r} A${r} ${r} 0 0 1 ${w - r} ${r * 3} H${w - r * 2} V${h - r} A${r} ${r} 0 0 1 ${w - r * 3} ${h} H${r} A${r} ${r} 0 0 1 ${r} ${h - r * 2} H${r * 2} V${r * 2} Z`;
      }
      case 'flowDecision': return poly([[w / 2, 0], [w, h / 2], [w / 2, h], [0, h / 2]]);
      case 'flowDocument': return `M0 0 H${w} V${h * 0.82} C${w * 0.7} ${h * 0.68} ${w * 0.4} ${h * 1.08} 0 ${h * 0.9} Z`;
      case 'rect':
      default:
        return `M0 0 H${w} V${h} H0 Z`;
    }
  };

  // ------------------------------------------------------------------ HTML sanitizing for rich text
  const ALLOWED_TAGS = new Set(['P', 'DIV', 'BR', 'SPAN', 'B', 'STRONG', 'I', 'EM', 'U', 'UL', 'OL', 'LI', 'SUP', 'SUB', 'S', 'STRIKE', 'H1', 'H2', 'H3', 'A']);
  const ALLOWED_STYLES = ['font-family', 'font-size', 'font-weight', 'font-style', 'text-decoration', 'text-decoration-line',
    'color', 'background-color', 'text-align', 'margin-top', 'margin-bottom', 'line-height', 'letter-spacing',
    'text-transform', 'text-indent', 'font-variant', 'text-decoration-style', 'text-decoration-thickness', 'vertical-align',
    'initial-letter', 'margin-left', 'margin-right', 'border-bottom', 'float', 'height',
    'text-shadow', '-webkit-text-stroke-width', '-webkit-text-stroke-color', '-webkit-text-fill-color', 'font-kerning', 'font-feature-settings',
    'font-variant-ligatures', 'font-variant-numeric', 'font-variant-caps', 'word-spacing', 'text-decoration-color', 'hyphens', 'list-style-type',
    'background-image', 'background-clip', '-webkit-background-clip', 'padding-left', 'tab-size',
    'break-inside', 'break-after', 'break-before', 'orphans', 'widows'];

  /**
   * Tabs like Publisher's: a tab goes to the next tab stop, even when the text ends just before it. (A browser skips a
   * stop that is less than half a space away, which pushed some lines of tabbed lists one stop too far.) Each tab is
   * wrapped in a span that starts it a half-space earlier; the stop it lands on is the same, so nothing else moves.
   */
  PS.fixTabs = (root) => {
    if (!root || root.textContent.indexOf('\t') < 0) return;
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (w.nextNode()) if (w.currentNode.data.indexOf('\t') >= 0 && !(w.currentNode.parentElement && w.currentNode.parentElement.classList.contains('ps-tab'))) nodes.push(w.currentNode);
    for (const n of nodes) {
      const frag = document.createDocumentFragment();
      for (const piece of n.data.split(/(\t)/)) {
        if (!piece) continue;
        if (piece === '\t') { const sp = document.createElement('span'); sp.className = 'ps-tab'; sp.style.marginLeft = '-0.08em'; sp.textContent = '\t'; frag.append(sp); }
        else frag.append(document.createTextNode(piece));
      }
      n.replaceWith(frag);
    }
  };

  /**
   * Custom tab stops (Publisher stores them on the paragraph, in points from the left edge of the text). Each tab
   * becomes a gap that ends at the next stop, so write-in lines and dot leaders reach as far as they do in Publisher.
   * Needs the text on screen to measure, so it is placed off to the side for a moment.
   */
  PS.applyTabStops = (content, outer) => {
    const paras = content.querySelectorAll('p[data-tabs]');
    if (!paras.length || !document.body) return;
    const host = outer || content;
    const parent = host.parentNode, next = host.nextSibling;
    const holder = document.createElement('div');
    holder.style.cssText = 'position:absolute;left:-99999px;top:0;visibility:hidden';
    holder.appendChild(host);
    document.body.appendChild(holder);
    try {
      const origin = content.getBoundingClientRect().left + (parseFloat(getComputedStyle(content).paddingLeft) || 0);
      const scale = content.offsetWidth ? content.getBoundingClientRect().width / content.offsetWidth : 1;
      for (const p of paras) {
        const stops = p.dataset.tabs.split(',').map(Number).filter(n => n > 0).sort((a, b) => a - b);
        for (const sp of p.querySelectorAll('.ps-tab')) {
          sp.style.display = 'inline-block'; sp.style.whiteSpace = 'pre'; sp.style.width = '0px'; sp.style.marginLeft = '0px';
          const x = (sp.getBoundingClientRect().left - origin) / scale / PS.PX_PER_PT;
          const stop = stops.find(t => t > x + 0.5);
          if (stop == null) { sp.style.display = ''; sp.style.width = ''; sp.style.whiteSpace = ''; sp.style.marginLeft = '-0.08em'; continue; }
          sp.style.width = (stop - x) + 'pt';
        }
      }
    } finally {
      if (parent) parent.insertBefore(host, next); else host.remove();
      holder.remove();
    }
  };

  PS.sanitizeHtml = (html) => {
    const tpl = document.createElement('template');
    tpl.innerHTML = String(html || '');
    tpl.content.querySelectorAll('.ps-wrap').forEach(n => n.remove());
    tpl.content.querySelectorAll('span.ps-tab').forEach(n => n.replaceWith(...n.childNodes));
    const clean = (node) => {
      for (const child of Array.from(node.childNodes)) {
        if (child.nodeType === 3) continue;
        if (child.nodeType !== 1) { child.remove(); continue; }
        let el = child;
        const tag = el.tagName;
        if (tag === 'FONT') {
          const span = document.createElement('span');
          if (el.getAttribute('face')) span.style.fontFamily = el.getAttribute('face');
          if (el.getAttribute('color')) span.style.color = el.getAttribute('color');
          span.append(...el.childNodes);
          el.replaceWith(span);
          el = span;
        } else if (['SCRIPT', 'STYLE', 'META', 'LINK', 'TITLE', 'XML', 'IFRAME', 'OBJECT', 'EMBED', 'IMG', 'SVG', 'VIDEO', 'AUDIO'].includes(tag)) {
          el.remove(); continue;
        } else if (!ALLOWED_TAGS.has(tag)) {
          // Unwrap unknown elements but keep their content
          const isBlock = ['TABLE', 'TR', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'BLOCKQUOTE', 'H4', 'H5', 'H6', 'PRE', 'ADDRESS'].includes(tag);
          const repl = document.createElement(isBlock ? 'p' : 'span');
          repl.append(...el.childNodes);
          el.replaceWith(repl);
          el = repl;
        }
        // attributes
        const style = el.getAttribute('style') || '';
        const href = el.tagName === 'A' ? (el.getAttribute('href') || '') : '';
        for (const a of Array.from(el.attributes)) el.removeAttribute(a.name);
        if (href && /^(https?:|mailto:|tel:)/i.test(href.trim())) el.setAttribute('href', href.trim());
        if (style) {
          const tmp = document.createElement('span');
          tmp.setAttribute('style', style);
          const keep = [];
          for (const prop of ALLOWED_STYLES) {
            const v = tmp.style.getPropertyValue(prop);
            if (v && !/expression|url\(/i.test(v)) keep.push(`${prop}: ${v}`);
          }
          if (keep.length) el.setAttribute('style', keep.join('; '));
        }
        clean(el);
      }
    };
    clean(tpl.content);
    let out = tpl.innerHTML.trim();
    if (!out) out = '<p><br></p>';
    return out;
  };

  PS.htmlToPlain = (html) => {
    const d = document.createElement('div');
    d.innerHTML = html || '';
    d.querySelectorAll('br').forEach(b => b.replaceWith('\n'));
    d.querySelectorAll('p,div,li,h1,h2,h3').forEach(b => b.append('\n'));
    return d.textContent.replace(/\n{3,}/g, '\n\n').trim();
  };

  // ------------------------------------------------------------------ assets → object URLs (one per asset)
  const urlCache = new Map(); // assetId -> { dataUrl, url }
  PS.assetUrl = (doc, id) => {
    const a = doc.assets && doc.assets[id];
    if (!a) return '';
    const c = urlCache.get(id);
    if (c && c.dataUrl === a.dataUrl) return c.url;
    try {
      const [head, b64] = a.dataUrl.split(',');
      const mime = (head.match(/data:([^;]+)/) || [])[1] || a.mime || 'image/png';
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
      if (c) URL.revokeObjectURL(c.url);
      urlCache.set(id, { dataUrl: a.dataUrl, url });
      return url;
    } catch {
      return a.dataUrl;
    }
  };

  // ------------------------------------------------------------------ object rendering
  // Dash patterns (PowerPoint's set): round dot uses round line caps, the rest square ones
  const dashArray = (dash, w) => dash === 'dash' ? `${w * 4} ${w * 3}` : dash === 'dot' ? `${Math.max(w, 0.5) * 0.01} ${w * 2.2}`
    : dash === 'sqdot' ? `${w} ${w}` : dash === 'dashdot' ? `${w * 4} ${w * 3} ${w} ${w * 3}` : dash === 'longdash' ? `${w * 8} ${w * 3}`
    : dash === 'longdashdot' ? `${w * 8} ${w * 3} ${w} ${w * 3}` : dash === 'longdashdotdot' ? `${w * 8} ${w * 3} ${w} ${w * 3} ${w} ${w * 3}` : '';
  PS.dashArray = dashArray;

  /**
   * Text wrapping: objects in front of a text box that have wrap = 'square' push its text aside,
   * like Publisher. Returns rectangles relative to the text area (pt).
   */
  PS.exclusionsFor = (o, list) => {
    if (!list || o.type !== 'text' || (o.columns || 1) > 1 || o.rotation) return [];
    const idx = list.indexOf(o);
    if (idx < 0) return [];
    const pad = o.padding || [0, 0, 0, 0];
    const ax = o.x + pad[3], ay = o.y + pad[0], aw = o.w - pad[1] - pad[3], ah = o.h - pad[0] - pad[2];
    const out = [];
    for (let i = 0; i < list.length; i++) {
      if (i === idx) continue;
      const e = list[i];
      if (!e || e.type === 'line' || !e.wrap || e.wrap === 'none') continue;
      // Text boxes whose wrap flag is off still flow around pictures (only other shapes may sit on top of their text)
      if (o.wrapText === false && e.type !== 'image') continue;
      const b = PS.visualBounds(e);
      // Publisher also flows text around pictures sitting behind the box, as long as they are a small part of it
      // (a large shape behind the text is a backdrop, not an obstacle)
      if (i < idx && !(e.type === 'image' && b.w * b.h < 0.5 * aw * ah)) continue;
      // Like Publisher: a little room at the sides, less above and below, and a sliver of overlap doesn't count
      const gap = 5, vgap = 2;
      const x1 = Math.max(ax, b.x - gap), y1 = Math.max(ay, b.y - vgap);
      // An object reaching past the bottom of the text stops just short of it, so it doesn't count as overflow
      const x2 = Math.min(ax + aw, b.x + b.w + gap), y2 = Math.min(ay + ah - 1, b.y + b.h + vgap);
      if (x2 - x1 < 1 || y2 - y1 < 2) continue;
      // Top and Bottom: text stops above the object and carries on below it
      if (e.wrap === 'topBottom') { out.push({ side: 'left', top: y1 - ay, height: y2 - y1, width: aw }); continue; }
      // Tight around an oval: the text follows its curve in thin bands
      if (e.wrap === 'tight' && e.type === 'shape' && /ellipse|circle|oval/i.test(e.kind || '') && !e.rotation) {
        const cx = b.x + b.w / 2, cy = b.y + b.h / 2, rx = b.w / 2 + gap, ry = b.h / 2 + vgap, step = 6;
        const bands = [];
        for (let y = Math.max(ay, cy - ry); y < Math.min(ay + ah - 1, cy + ry); y += step) {
          const ym = Math.min(cy + ry, y + step / 2), t = (ym - cy) / ry, half = rx * Math.sqrt(Math.max(0, 1 - t * t));
          const bx1 = Math.max(ax, cx - half), bx2 = Math.min(ax + aw, cx + half);
          if (bx2 - bx1 < 1) continue;
          const lr = bx1 - ax, rr = ax + aw - bx2, sd = lr > rr ? 'right' : 'left';
          bands.push({ side: sd, top: y - ay, height: step, width: Math.max(lr, rr) < 36 ? aw : (sd === 'left' ? bx2 - ax : ax + aw - bx1) });
        }
        if (bands.length) { out.push(...bands); continue; }
      }
      // Push text to the side with more room; if neither side leaves room, text goes below
      const leftRoom = x1 - ax, rightRoom = ax + aw - x2;
      const side = leftRoom > rightRoom ? 'right' : 'left';
      const full = Math.max(leftRoom, rightRoom) < 36;
      out.push({
        side, top: y1 - ay, height: y2 - y1,
        width: full ? aw : (side === 'left' ? x2 - ax : ax + aw - x1),
      });
    }
    return out.sort((a, b) => a.top - b.top || 0);
  };

  function exclusionHtml(ex) {
    // A zero-width spacer float pushes each exclusion down to its position. A float can't start above an
    // earlier one, so each spacer starts where the previous exclusion did.
    let floor = 0;
    return ex.map(e => {
      const gapH = Math.max(0, e.top - floor);
      floor = Math.max(floor, e.top);
      return `<div class="ps-wrap" contenteditable="false" style="float:${e.side};width:0;height:${gapH.toFixed(2)}pt"></div>` +
        `<div class="ps-wrap" contenteditable="false" style="float:${e.side};clear:${e.side};width:${e.width.toFixed(2)}pt;height:${e.height.toFixed(2)}pt"></div>`;
    }).join('');
  }

  /**
   * Other names a font goes by. Publisher calls some fonts by a name the browser doesn't know:
   * Letraset fonts are installed as "… LET Plain", and Adobe's bold fonts as "… Bold".
   */
  PS.fontAliases = {};
  PS.learnFontNames = (families, fullNames) => {
    const have = new Set(families.map(f => f.toLowerCase()));
    const add = (from, to) => { const k = from.toLowerCase(); if (!have.has(k) && !PS.fontAliases[k]) PS.fontAliases[k] = to; };
    for (const f of families) {
      const m = f.match(/^(.*?)\s+(Plain(?::\d+(?:\.\d+)?)?|Regular|Normal)$/i);
      if (m) add(m[1], f);
    }
    for (const [full, fam] of fullNames || []) if (full && fam && full !== fam) add(full, fam);
  };
  PS.fontAlias = (family) => {
    const f = String(family || '').replace(/["']/g, '').trim();
    if (!f) return null;
    const a = PS.fontAliases[f.toLowerCase()];
    if (a) return a;
    if (/\sLET$/i.test(f)) return f + ' Plain';
    return null;
  };

  PS.fontStack = (family) => {
    const f = String(family || '');
    let generic = 'sans-serif';
    if (/script|brush|callig|hand|corsiva|chancery|vivaldi|edwardian|kunstler|alex|signature|watermelon|winter/i.test(f)) generic = 'cursive';
    else if (/roman|garamond|goudy|times|georgia|baskerville|caslon|antiqua|palatino|century|cambria|trajan|bodoni|serif|book|bookman|minion|caslon|engravers|albertus|perpetua|constantia|rockwell|elephant|bell|footlight|modern|centaur|plantagenet|old style|stempel|sabon|janson|bembo/i.test(f)) generic = 'serif';
    else if (/courier|mono|consolas/i.test(f)) generic = 'monospace';
    const alias = PS.fontAlias(f);
    return `"${f.replace(/"/g, '')}", ${alias ? `"${alias.replace(/"/g, '')}", ` : ''}${generic}`;
  };

  /** How much a rendered text box's text is too big for it (≤ 1 fits). Works with Text Fit zoom and the editor's scaling. */
  PS.textOverflowRatio = (c, o) => {
    if (o.columns > 1) return c.scrollWidth / Math.max(1, c.clientWidth);
    const z = parseFloat(c.style.zoom) || 1;
    const pad = o.padding || [0, 0, 0, 0];
    if (o.textDirection === 'vertical') return (c.scrollWidth * z) / Math.max(0.5, (o.w - pad[1] - pad[3]) * PS.PX_PER_PT);
    // Text may run into the bottom margin before it counts as not fitting (it's still shown there), like Publisher
    const avail = Math.max(0.5, (o.h - pad[0] - (pad[2] || 0)) * PS.PX_PER_PT);   // a line must fit above the bottom margin (Publisher)
    return (c.scrollHeight * z) / avail;
  };

  function textLayer(o, exclusions) {
    const outer = document.createElement('div');
    outer.className = 'ps-text';
    const pad = o.padding || [0, 0, 0, 0];
    const f = o.font || PS.defaultFont;
    Object.assign(outer.style, {
      position: 'absolute', inset: '0',
      padding: `${pad[0]}pt ${pad[1]}pt ${pad[2]}pt ${pad[3]}pt`,
      display: 'flex', flexDirection: 'column',
      justifyContent: o.valign === 'middle' ? 'center' : o.valign === 'bottom' ? 'flex-end' : 'flex-start',
      overflow: 'hidden',      // like Publisher, text that doesn't fit is hidden (the editor marks it)
      boxSizing: 'border-box',
    });
    const content = document.createElement('div');
    content.className = 'ps-text-content';
    Object.assign(content.style, {
      fontFamily: PS.fontStack(f.family),
      fontSize: `${f.size}pt`,
      color: f.color,
      lineHeight: String(o.lineHeight || 1.15),
      outline: 'none',
      minHeight: '1em',
      wordWrap: 'break-word',
      overflowWrap: 'break-word',
      whiteSpace: 'pre-wrap',
      tabSize: `${o.tabSize || 18}pt`,          // Publisher's default tab stops are every quarter inch
    });
    if (o.hyphenate) { content.style.hyphens = 'auto'; content.lang = 'en'; }
    if (o.textDirection === 'vertical') {
      // Text Direction: the text runs down the box, turned a quarter turn like Publisher's
      outer.style.writingMode = 'vertical-rl';
      outer.style.justifyContent = o.valign === 'middle' ? 'center' : o.valign === 'bottom' ? 'flex-end' : 'flex-start';
    }
    if (o.columns > 1) {
      content.style.columnCount = String(o.columns);
      content.style.columnGap = `${o.columnGap || 14.4}pt`;
      content.style.columnFill = 'auto';
      // Like Publisher, the last line may sit in the bottom margin
      content.style.height = `calc(100% + ${Math.max(0, pad[2] || 0)}pt)`;
      content.style.flexShrink = '0';
    }
    if (o.shrinkScale && o.shrinkScale !== 1) {
      // Text Fit: scale everything in the box (sizes set on each run included) by zooming the text
      content.style.zoom = String(o.shrinkScale);
      content.dataset.shrink = String(o.shrinkScale);
    }
    content.innerHTML = o.html || '';
    // A paragraph whose letters are all smaller than the box's font would still get a line as tall as the box's size, leaving
    // small text sitting low in the box. Size the paragraph to its largest letters so the line fits them.
    let blocksSeen = 0, blocksSized = 0;
    content.querySelectorAll(':scope > p, :scope > div').forEach((p) => {
      blocksSeen++;
      if (p.style.fontSize) return;
      let max = 0, any = false;
      const w = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
      for (let n = w.nextNode(); n; n = w.nextNode()) {
        if (!n.data.replace(/[\u200b\s]/g, '')) continue;
        any = true;
        let size = f.size;
        for (let e = n.parentElement; e && e !== p; e = e.parentElement) { if (e.style.fontSize) { const m = /^([\d.]+)pt$/.exec(e.style.fontSize); size = m ? parseFloat(m[1]) : f.size; break; } }
        if (size > max) max = size;
      }
      if (any && max > 0 && max < f.size) { p.style.fontSize = max + 'pt'; blocksSized++; }
    });
    if (blocksSeen && blocksSized === blocksSeen) content.style.minHeight = '0';
    PS.fixTabs(content);
    PS.applyTabStops(content, outer);
    if (exclusions && exclusions.length) {
      const wrap = document.createElement('div');
      wrap.className = 'ps-wrap-holder';
      wrap.innerHTML = exclusionHtml(exclusions);
      content.prepend(...wrap.childNodes);
    }
    outer.appendChild(content);
    return outer;
  }

  /**
   * Render one object. Returns an absolutely-positioned element in page coordinates (pt).
   * opts: { doc, editable }
   */
  // ------------------------------------------------------------------ mail merge fields
  // A merge field is written «Field Name» in the text, the way Publisher shows it.
  PS.FIELD_RE = /«([^«»\n]{1,80})»/g;
  PS.hasFields = (html) => typeof html === 'string' && html.indexOf('«') >= 0 && /«[^«»]+»/.test(html);
  /** Replace «fields» in rich-text HTML with a record's values. record: { fieldNameLowercase: value } */
  PS.mergeHtml = (html, record) => {
    if (!PS.hasFields(html)) return html;
    const tpl = document.createElement('template');
    tpl.innerHTML = html;
    const walker = document.createTreeWalker(tpl.content, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) if (walker.currentNode.data.indexOf('«') >= 0) nodes.push(walker.currentNode);
    for (const n of nodes) {
      n.data = n.data.replace(PS.FIELD_RE, (m, name) => {
        const k = name.trim().toLowerCase();
        return Object.prototype.hasOwnProperty.call(record, k) ? record[k] : m;
      });
    }
    return tpl.innerHTML;
  };
  // Page number fields work like merge fields, filled in for every page
  PS.PAGE_FIELDS = ['page number', 'page count'];
  PS.pageRecord = (doc, pageIndex) => ({ 'page number': String((pageIndex | 0) + 1 + ((doc.page && doc.page.firstPageNumber) ? doc.page.firstPageNumber - 1 : 0)), 'page count': String(doc.pages.length) });
  /** Shade «fields» (View > Fields) — only on screen. */
  PS.shadeFields = (html) => {
    if (!PS.hasFields(html)) return html;
    const tpl = document.createElement('template');
    tpl.innerHTML = html;
    const walker = document.createTreeWalker(tpl.content, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) if (walker.currentNode.data.indexOf('«') >= 0) nodes.push(walker.currentNode);
    for (const n of nodes) {
      const frag = document.createDocumentFragment();
      let last = 0;
      n.data.replace(PS.FIELD_RE, (m, name, off) => {
        frag.append(n.data.slice(last, off));
        const sp = document.createElement('span'); sp.className = 'ps-field'; sp.textContent = m; frag.append(sp);
        last = off + m.length; return m;
      });
      frag.append(n.data.slice(last));
      n.replaceWith(frag);
    }
    return tpl.innerHTML;
  };
  /** The field names used in a document, in order of first use. */
  PS.fieldsInDoc = (doc) => {
    const out = [];
    const scan = (objs) => objs.forEach(o => {
      if (!PS.hasFields(o.html)) return;
      for (const m of PS.htmlToPlain(o.html).matchAll(PS.FIELD_RE)) if (!out.includes(m[1].trim()) && !PS.PAGE_FIELDS.includes(m[1].trim().toLowerCase())) out.push(m[1].trim());
    });
    scan(doc.master.objects); doc.pages.forEach(p => scan(p.objects)); scan((doc.scratch && doc.scratch.objects) || []);
    return out;
  };

  // Compound lines (double, thick-thin, thin-thick, triple): several thin parallel strokes that together are as wide as the line weight
  const COMPOUND = { double: [[-1 / 3, 1 / 3], [1 / 3, 1 / 3]], thickThin: [[-0.25, 0.5], [0.375, 0.25]], thinThick: [[-0.375, 0.25], [0.25, 0.5]], triple: [[-0.4, 0.2], [0, 0.2], [0.4, 0.2]] };
  const compoundLines = (o, x1, y1, x2, y2, sw) => {
    const parts = COMPOUND[o.compound];
    if (!parts) return '';
    const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy) || 1, nx = dy / len, ny = -dx / len;
    return parts.map(([off, wf]) => `<line x1="${x1 + nx * off * sw}" y1="${y1 + ny * off * sw}" x2="${x2 + nx * off * sw}" y2="${y2 + ny * off * sw}" stroke="${o.stroke}" stroke-width="${sw * wf}" stroke-linecap="butt" stroke-dasharray="${dashArray(o.dash, sw * wf)}"/>`).join('');
  };
  PS.renderObject = (o, opts) => {
    // Handwriting with mail-merge fields: every recipient's copy is written a little differently
    if (o.hw && opts.merge && o.id !== opts.mergeSkip && PS.hasFields(o.html) && window.HW) { const k = HW.recordKey(opts.merge); if (k) o = Object.assign({}, o, { __hwVariant: (o.__hwVariant || '') + k }); }
    if (opts.merge && o.id !== opts.mergeSkip && PS.hasFields(o.html)) o = Object.assign({}, o, { html: PS.mergeHtml(o.html, opts.merge) });
    if (opts.shadeFields && PS.hasFields(o.html)) o = Object.assign({}, o, { html: PS.shadeFields(o.html) });
    // A picture field shows the recipient's own picture
    if (o.type === 'image' && o.mergePicture && opts.merge && opts.merge.__pics) {
      const id = opts.merge.__pics[opts.merge[o.mergePicture.toLowerCase()]];
      if (id) o = Object.assign({}, o, { asset: id, placeholder: false });
    }
    const doc = opts.doc;
    const el = document.createElement('div');
    el.className = 'ps-obj ps-' + o.type;
    el.dataset.id = o.id;
    if (o.type === 'line') {
      const sw = o.strokeWidth || 1;
      const pad = sw * 4 + 4;
      const minx = Math.min(o.x1, o.x2) - pad, miny = Math.min(o.y1, o.y2) - pad;
      const W = Math.abs(o.x2 - o.x1) + pad * 2, H = Math.abs(o.y2 - o.y1) + pad * 2;
      Object.assign(el.style, { left: minx + 'pt', top: miny + 'pt', width: W + 'pt', height: H + 'pt', opacity: o.opacity ?? 1, pointerEvents: 'none' });
      const x1 = o.x1 - minx, y1 = o.y1 - miny, x2 = o.x2 - minx, y2 = o.y2 - miny;
      const mk = (id, flip) => `<marker id="${id}" viewBox="0 0 10 10" refX="${flip ? 2 : 8}" refY="5" markerWidth="${Math.max(3, 9 / Math.sqrt(sw))}" markerHeight="${Math.max(3, 9 / Math.sqrt(sw))}" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 Z" fill="${o.stroke}"/></marker>`;
      const mid = o.id.replace(/[^a-z0-9]/gi, '');
      el.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" viewBox="0 0 ${W} ${H}" style="overflow:visible;display:block">
        <defs>${o.arrowStart ? mk('as' + mid, true) : ''}${o.arrowEnd ? mk('ae' + mid) : ''}</defs>
        <line class="ps-hit" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="transparent" stroke-width="${Math.max(sw, 8)}" style="pointer-events:stroke"/>
        ${compoundLines(o, x1, y1, x2, y2, sw) || `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${o.stroke}" stroke-width="${sw}" stroke-linecap="${o.dash === 'dot' ? 'round' : 'butt'}"
          stroke-dasharray="${dashArray(o.dash, sw)}" ${o.arrowStart ? `marker-start="url(#as${mid})"` : ''} ${o.arrowEnd ? `marker-end="url(#ae${mid})"` : ''}/>`}
      </svg>`;
      return el;
    }

    Object.assign(el.style, {
      left: o.x + 'pt', top: o.y + 'pt', width: o.w + 'pt', height: o.h + 'pt',
      transform: o.rotation ? `rotate(${o.rotation}deg)` : '',
      opacity: o.opacity ?? 1,
    });

    if (o.type === 'shape') {
      const sw = o.stroke ? (o.strokeWidth || 0) : 0;
      const d = PS.shapePath(o.kind, o.w, o.h, o);
      const paint = window.PSFX ? PSFX.shapePaint(o, doc) : { defs: '', fill: o.fill || 'none' };
      if (o.kind === 'wordart' && o.wordArt) {
        const wa = o.wordArt, t = String(wa.text).replace(/&/g, '&amp;').replace(/</g, '&lt;'), id = 'wa' + String(o.id).replace(/[^a-z0-9]/gi, '');
        const rx = o.w / 2, ry = o.h / 2, cx = rx, cy = ry, ff = (wa.font || 'Arial').replace(/"/g, '');
        const kind = wa.preset;
        // preset families: 144 arch up, 145 arch down, 146 full circle, 142/143 ring; everything else: plain text stretched to the box
        let pathD = null;
        if (kind === 146 || kind === 142 || kind === 143) pathD = `M${cx} ${cy + ry} A${rx} ${ry} 0 1 1 ${cx} ${cy - ry} A${rx} ${ry} 0 1 1 ${cx} ${cy + ry}`;
        else if (kind === 144) pathD = `M0 ${o.h} A${rx} ${o.h} 0 0 1 ${o.w} ${o.h}`;
        else if (kind === 145) pathD = `M0 0 A${rx} ${o.h} 0 0 0 ${o.w} 0`;
        const fs = pathD ? Math.max(6, Math.min(o.w, o.h) / 7) : o.h * 0.8;
        const body = pathD
          ? `<defs><path id="${id}" d="${pathD}"/></defs><text font-family="${ff}" font-size="${fs}" fill="${o.fill || '#000'}"><textPath href="#${id}" startOffset="0" textLength="${(Math.PI * (rx + ry)).toFixed(1)}" lengthAdjust="spacing">${t}</textPath></text>`
          : `<text x="0" y="${o.h * 0.8}" font-family="${ff}" font-size="${fs}" fill="${o.fill || '#000'}" textLength="${o.w}" lengthAdjust="spacingAndGlyphs">${t}</text>`;
        el.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" viewBox="0 0 ${o.w} ${o.h}" preserveAspectRatio="none" style="overflow:visible;display:block;position:absolute;inset:0">${body}</svg>`;
        return el;
      }
      el.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" viewBox="0 0 ${o.w} ${o.h}" preserveAspectRatio="none" style="overflow:visible;display:block;position:absolute;inset:0">
        ${paint.defs ? `<defs>${paint.defs}</defs>` : ''}<path d="${d}" fill="${paint.fill}" stroke="${o.stroke || 'none'}" stroke-width="${sw}" stroke-dasharray="${dashArray(o.dash, sw)}" stroke-linejoin="round"/></svg>`;
      if (o.html && PS.htmlToPlain(o.html).length) el.appendChild(textLayer(o));
      else if (opts.editable) el.appendChild(textLayer(Object.assign({}, o, { html: '' })));
      if (o.hw && window.HW && o.html && PS.htmlToPlain(o.html).length) HW.decorate(el, o, opts);
      return el;
    }

    if (o.type === 'text') {
      if (o.fill) el.style.background = o.fill;
      const grad = o.fillGradient && window.PSFX ? PSFX.cssGradient(o.fillGradient) : null;
      if (grad) el.style.background = grad;
      if (o.fillPattern && window.PSFX && PSFX.patternCss) Object.assign(el.style, PSFX.patternCss(o.fillPattern));
      if (o.fillImage && doc.assets && doc.assets[o.fillImage]) Object.assign(el.style, { backgroundImage: `url("${PS.assetUrl(doc, o.fillImage)}")`, backgroundSize: 'cover', backgroundPosition: 'center' });
      if (o.stroke && o.strokeWidth) {
        el.style.outline = `${o.strokeWidth}pt ${/dash/.test(o.dash || '') ? 'dashed' : /dot/.test(o.dash || '') ? 'dotted' : 'solid'} ${o.stroke}`;
        el.style.outlineOffset = `-${o.strokeWidth}pt`;
      }
      if (o.borders) {   // table cells: each side has its own line, centred on the cell's edge. A shared edge is drawn once
        // (by the cell to its right / below), so thin lines aren't painted twice and darkened
        const b = o.borders, wd = (k) => (b[k] && b[k].w) || 0;
        const tid = o.tableId || o.groupId, list = opts.list || [];
        const nb = (k) => list.some(c => c !== o && c.tableCell && (c.tableId || c.groupId) === tid && c.borders && c.borders[k === 'r' ? 'l' : 't'] && c.borders[k === 'r' ? 'l' : 't'].w &&
          (k === 'r' ? Math.abs(c.x - (o.x + o.w)) < 0.6 && c.y < o.y + o.h - 0.6 && c.y + c.h > o.y + 0.6
            : Math.abs(c.y - (o.y + o.h)) < 0.6 && c.x < o.x + o.w - 0.6 && c.x + c.w > o.x + 0.6));
        const W = o.w, H = o.h, seg = [];
        const ln = (k, x1, y1, x2, y2) => {
          const w = wd(k); if (!w) return;
          const d = b[k].dash || 'solid';
          seg.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${b[k].c || '#000'}" stroke-width="${w}" stroke-linecap="${d === 'solid' ? 'square' : 'butt'}" stroke-dasharray="${dashArray(d, w)}"/>`);
        };
        ln('t', 0, 0, W, 0); ln('l', 0, 0, 0, H);
        if (!nb('r')) ln('r', W, 0, W, H);
        if (!nb('b')) ln('b', 0, H, W, H);
        if (seg.length) {
          const bd = document.createElement('div');
          bd.className = 'ps-cell-borders';
          bd.style.cssText = 'position:absolute;inset:0;pointer-events:none;overflow:visible';
          bd.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="overflow:visible;display:block">${seg.join('')}</svg>`;
          el.appendChild(bd);
        }
      }
      el.appendChild(textLayer(o, opts.list ? PS.exclusionsFor(o, opts.list) : null));
      if (o.hw && window.HW) HW.decorate(el, o, opts);
      return el;
    }

    if (o.type === 'image') {
      const wrap = document.createElement('div');
      wrap.className = 'ps-img-wrap';
      const corner = o.frame === 'ellipse' ? '50%' : (o.radius || 0) + 'pt';
      Object.assign(wrap.style, { position: 'absolute', inset: '0', overflow: 'hidden', borderRadius: corner });
      const img = document.createElement('img');
      img.draggable = false;
      img.src = PS.assetUrl(doc, o.asset);
      Object.assign(img.style, {
        width: '100%', height: '100%', display: 'block',
        objectFit: o.fit === 'stretch' || !o.fit ? 'fill' : o.fit === 'crop' ? 'fill' : o.fit,
        objectPosition: `${o.focusX ?? 50}% ${o.focusY ?? 50}%`,
        transform: `scale(${o.flipH ? -1 : 1}, ${o.flipV ? -1 : 1})`,
      });
      if (o.fit === 'crop' && o.crop) {
        // A cropped picture: the part that's left fills the frame (stretched if the frame was resized)
        const p = PS.imagePlacement(o);
        Object.assign(img.style, { position: 'absolute', maxWidth: 'none', left: (p.x / o.w * 100) + '%', top: (p.y / o.h * 100) + '%', width: (p.w / o.w * 100) + '%', height: (p.h / o.h * 100) + '%' });
      }
      wrap.appendChild(img);
      el.appendChild(wrap);
      // Crop to Shape: the picture is cut to a shape, and its border follows the shape
      if (o.cropShape && o.cropShape !== 'ellipse' && o.cropShape !== 'rect') {
        const k = PS.PX_PER_PT;
        wrap.style.clipPath = `path('${PS.shapePath(o.cropShape, o.w * k, o.h * k, { radius: (o.radius || 12) * k })}')`;
        wrap.style.borderRadius = '0';
        if (o.stroke && o.strokeWidth) {
          const sv = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
          sv.setAttribute('viewBox', `0 0 ${o.w} ${o.h}`); sv.setAttribute('preserveAspectRatio', 'none');
          sv.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;overflow:visible;pointer-events:none';
          sv.innerHTML = `<path d="${PS.shapePath(o.cropShape, o.w, o.h, o)}" fill="none" stroke="${o.stroke}" stroke-width="${o.strokeWidth * 2}" clip-path="url(#cs${String(o.id).replace(/[^a-z0-9]/gi, '')})"/><clipPath id="cs${String(o.id).replace(/[^a-z0-9]/gi, '')}"><path d="${PS.shapePath(o.cropShape, o.w, o.h, o)}"/></clipPath>`;
          el.appendChild(sv);
        }
        return el;
      }
      if (o.stroke && o.strokeWidth) {
        const b = document.createElement('div');
        Object.assign(b.style, { position: 'absolute', inset: '0', border: `${o.strokeWidth}pt ${o.compound && o.strokeWidth >= 2.5 ? 'double' : 'solid'} ${o.stroke}`, borderRadius: corner, pointerEvents: 'none' });
        el.appendChild(b);
      }
      if (!doc.assets[o.asset]) {
        el.classList.add('ps-missing');
        el.title = 'Picture missing';
        if (o.placeholder) {
          el.classList.add('ps-placeholder');
          el.title = o.mergePicture ? `Picture from «${o.mergePicture}»` : 'Picture placeholder — double-click to add a picture';
          if (opts.editable) el.insertAdjacentHTML('beforeend', `<div class="ps-ph-icon">${PS.icon ? PS.icon('image') : ''}<span>${o.mergePicture ? '«' + PS.escapeHtml(o.mergePicture) + '»' : ''}</span></div>`);
          else el.style.background = 'transparent';
        }
      }
      return el;
    }
    return el;
  };

  /**
   * Render a page into a fresh element sized in pt. Returns the page element.
   * opts: { doc, pageIndex, editingMaster, editable }
   */
  PS.renderPageEl = (opts) => {
    const { doc, pageIndex } = opts;
    // Page numbers, plus the mail-merge record being previewed
    const rec = Object.assign(PS.pageRecord(doc, pageIndex), opts.merge || {});
    if (opts.merge && opts.merge.__pics) Object.defineProperty(rec, '__pics', { value: opts.merge.__pics, enumerable: false });
    const page = doc.pages[pageIndex];
    const pg = doc.page;
    const el = document.createElement('div');
    el.className = 'ps-page';
    let bg = (page && page.background) || pg.background || '#ffffff';
    if (!(page && page.background) && pg.bgGradient && pg.bgGradient.stops) {
      const g = pg.bgGradient;
      bg = `linear-gradient(${g.angle == null ? 180 : g.angle}deg, ${g.stops.map(([p2, c]) => `${c} ${Math.round(p2 * 100)}%`).join(', ')})`;
    }
    Object.assign(el.style, {
      position: 'relative', width: pg.width + 'pt', height: pg.height + 'pt',
      background: opts.showScratch ? 'transparent' : bg, overflow: opts.showScratch ? 'visible' : 'hidden',
    });
    const scratchMode = opts.scratchMode || 'behind';
    const scratchLayer = () => {
      const layer = document.createElement('div');
      layer.className = 'ps-obj-layer ps-scratch-layer';
      layer.style.cssText = 'position:absolute;inset:0;overflow:visible;';
      for (const o of doc.scratch.objects) layer.appendChild(PS.renderObject(o, { doc, editable: opts.editable, list: doc.scratch.objects, merge: rec, mergeSkip: opts.mergeSkip, shadeFields: opts.shadeFields }));
      return layer;
    };
    if (opts.showScratch) {
      if (scratchMode === 'behind' && doc.scratch && doc.scratch.objects.length) el.appendChild(scratchLayer());
      const paper = document.createElement('div');
      paper.className = 'ps-paper';
      paper.style.cssText = `position:absolute;inset:0;background:${bg};`;
      el.appendChild(paper);
    }
    const showMaster = opts.editingMaster || (page && page.useMaster !== false);
    if (showMaster && doc.master && doc.master.objects.length) {
      const layer = document.createElement('div');
      layer.className = 'ps-master-layer';
      layer.style.cssText = 'position:absolute;inset:0;';
      for (const o of doc.master.objects) layer.appendChild(PS.renderObject(o, { doc, editable: opts.editable && opts.editingMaster, list: doc.master.objects, merge: opts.editingMaster ? opts.merge : rec, mergeSkip: opts.mergeSkip, shadeFields: opts.shadeFields }));
      el.appendChild(layer);
    }
    if (!opts.editingMaster && page) {
      const layer = document.createElement('div');
      layer.className = 'ps-obj-layer';
      layer.style.cssText = 'position:absolute;inset:0;';
      for (const o of page.objects) layer.appendChild(PS.renderObject(o, { doc, editable: opts.editable, list: page.objects, merge: rec, mergeSkip: opts.mergeSkip, shadeFields: opts.shadeFields }));
      el.appendChild(layer);
    }
    if (opts.showScratch && scratchMode === 'front' && doc.scratch && doc.scratch.objects.length) el.appendChild(scratchLayer());
    return el;
  };

  // ------------------------------------------------------------------ rich text <-> paragraphs (used by the Publisher bridge)
  const BLOCKS = new Set(['P', 'DIV', 'LI', 'H1', 'H2', 'H3', 'UL', 'OL']);
  const rgbToHex = (rgb) => {
    const m = String(rgb).match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i);
    if (!m) return rgb && rgb.startsWith('#') ? rgb : '#000000';
    return '#' + [m[1], m[2], m[3]].map(v => (+v).toString(16).padStart(2, '0')).join('');
  };
  PS.rgbToHex = rgbToHex;
  const firstFamily = (ff) => String(ff || '').split(',')[0].trim().replace(/^["']|["']$/g, '') || 'Calibri';

  /**
   * Convert a text object's HTML into paragraphs of styled runs, using the browser's computed styles.
   * Returns [{ align, spaceBefore, spaceAfter, runs: [{ text, font, size, bold, italic, underline, color }] }]
   * Line breaks inside a paragraph are returned as "\u000b" (Publisher's line break character).
   */
  PS.htmlToParagraphs = (o) => {
    const host = document.createElement('div');
    host.style.cssText = 'position:absolute;left:-99999px;top:0;visibility:hidden;';
    host.style.width = Math.max(10, (o.w || 300) - ((o.padding || [0, 0, 0, 0])[1] + (o.padding || [0, 0, 0, 0])[3])) + 'pt';
    const tl = textLayer(Object.assign({}, o, { shrinkScale: 1 }));
    host.appendChild(tl);
    document.body.appendChild(host);
    const root = tl.querySelector('.ps-text-content');
    const paras = [];
    let cur = null;
    const startPara = (blockEl) => {
      const cs = getComputedStyle(blockEl || root);
      const al = cs.textAlign;
      cur = {
        align: al === 'center' ? 'center' : al === 'right' || al === 'end' ? 'right' : al === 'justify' ? 'justify' : 'left',
        spaceBefore: PS.round(parseFloat(cs.marginTop || '0') * 0.75, 1) || 0,
        spaceAfter: PS.round(parseFloat(cs.marginBottom || '0') * 0.75, 1) || 0,
        runs: [],
      };
      const ind = (v) => PS.round(parseFloat(v || '0') * 0.75, 1) || 0;
      if (blockEl && blockEl !== root) {
        if (ind(cs.marginLeft)) cur.leftIndent = ind(cs.marginLeft);
        if (ind(cs.marginRight)) cur.rightIndent = ind(cs.marginRight);
        if (ind(cs.textIndent)) cur.firstIndent = ind(cs.textIndent);
      }
      paras.push(cur);
    };
    const underlined = (el) => {
      for (let n = el; n && n !== host; n = n.parentElement) {
        const c = getComputedStyle(n);
        if (c.borderBottomStyle && c.borderBottomStyle !== 'none' && parseFloat(c.borderBottomWidth) > 0 && n.tagName === 'SPAN') {
          const bs = c.borderBottomStyle;
          return bs === 'dotted' || bs === 'dashed' || bs === 'double' ? bs : parseFloat(c.borderBottomWidth) >= 2 ? 'thick' : 'single';
        }
        if ((c.textDecorationLine || '').includes('underline')) {
          const st = c.textDecorationStyle;
          if (st === 'dotted' || st === 'dashed' || st === 'double' || st === 'wavy') return st;
          const th = parseFloat(c.textDecorationThickness);
          return th && th > parseFloat(c.fontSize) * 0.09 ? 'thick' : 'single';
        }
      }
      return false;
    };
    const scriptOf = (el) => {
      for (let n = el; n && n !== host && n !== root; n = n.parentElement) {
        const va = getComputedStyle(n).verticalAlign;
        if (va === 'super' || n.tagName === 'SUP') return 'super';
        if (va === 'sub' || n.tagName === 'SUB') return 'sub';
      }
      return null;
    };
    const pushRun = (text, el) => {
      if (!cur) startPara(el.closest('p,div,li,h1,h2,h3') || root);
      const cs = getComputedStyle(el);
      const script = scriptOf(el);
      const run = {
        text,
        font: firstFamily(cs.fontFamily),
        size: PS.round(parseFloat(cs.fontSize) * 0.75 / (script ? 0.6 : 1), 1),
        bold: (parseInt(cs.fontWeight, 10) || 400) >= 600,
        italic: cs.fontStyle === 'italic' || cs.fontStyle === 'oblique',
        underline: underlined(el),
        color: rgbToHex(cs.color),
      };
      if (script) run.script = script;
      if ((cs.textDecorationLine || '').includes('line-through')) run.strike = true;
      const ls = parseFloat(cs.letterSpacing);
      if (ls) run.tracking = PS.round(ls * 0.75, 2);
      const fx = PS.effectOf(cs);
      if (fx) run.effect = fx;
      // Highlight: a background on the text itself or a span around it (not the paragraph)
      for (let n = el; n && n !== root && n !== host && !BLOCKS.has(n.tagName); n = n.parentElement) {
        const bg = getComputedStyle(n).backgroundColor;
        if (bg && bg !== 'transparent' && !/rgba\(\d+, \d+, \d+, 0\)/.test(bg)) { run.highlight = rgbToHex(bg); break; }
      }
      if (cs.textTransform === 'uppercase') run.allCaps = true;
      if (/small-caps/.test(cs.fontVariant || cs.fontVariantCaps || '')) run.smallCaps = true;
      const il = parseInt(cs.initialLetter, 10);
      if (il > 1 && !cur.runs.length && !cur.dropCap) {
        cur.dropCap = { lines: il, letters: [...text].length, font: run.font };
        cur.runs.push(run);
        cur.dropRun = true;
        return;
      }
      if (cur.dropRun) {  // the drop cap letters take the size of the text that follows
        cur.dropRun = false;
        cur.runs[0].size = run.size;
      }
      const last = cur.runs[cur.runs.length - 1];
      if (last && !(cur.dropCap && cur.runs.length === 1) && last.font === run.font && last.size === run.size && last.bold === run.bold && last.italic === run.italic &&
          last.underline === run.underline && last.color === run.color && last.script === run.script && last.allCaps === run.allCaps && last.smallCaps === run.smallCaps &&
          last.strike === run.strike && last.tracking === run.tracking && last.effect === run.effect && last.highlight === run.highlight) last.text += text;
      else cur.runs.push(run);
    };
    const walk = (node, listInfo) => {
      for (const child of Array.from(node.childNodes)) {
        if (child.nodeType === 3) {
          const t = child.data.replace(/ /g, ' ').replace(/[\r\n]+/g, ' ');
          if (t) pushRun(t, child.parentElement);
        } else if (child.nodeType === 1) {
          const tag = child.tagName;
          if (tag === 'BR') {
            const parentBlock = child.parentElement;
            const isTrailing = !child.nextSibling && parentBlock !== root && BLOCKS.has(parentBlock.tagName);
            if (!isTrailing) pushRun('\u000b', parentBlock);
          } else if (tag === 'UL' || tag === 'OL') {
            cur = null;
            walk(child, { ordered: tag === 'OL', n: 0 });
            cur = null;
          } else if (BLOCKS.has(tag)) {
            startPara(child);
            if (tag === 'LI' && listInfo) {
              listInfo.n++;
              pushRun(listInfo.ordered ? `${listInfo.n}.\t` : '•\t', child);
            }
            walk(child, null);
            cur = null;
          } else {
            walk(child, listInfo);
          }
        }
      }
    };
    walk(root, null);
    host.remove();
    paras.forEach(p => { delete p.dropRun; });
    // Strip trailing empty paragraphs created by editors, keep at least one
    while (paras.length > 1 && paras[paras.length - 1].runs.length === 0) paras.pop();
    if (!paras.length) paras.push({ align: 'left', spaceBefore: 0, spaceAfter: 0, runs: [] });
    return paras;
  };

  const UNDERLINE_CSS = {
    single: 'text-decoration: underline', words: 'text-decoration: underline', double: 'text-decoration: underline; text-decoration-style: double',
    dotted: 'text-decoration: underline; text-decoration-style: dotted', dashed: 'text-decoration: underline; text-decoration-style: dashed',
    wavy: 'text-decoration: underline; text-decoration-style: wavy', thick: 'text-decoration: underline; text-decoration-thickness: 0.12em',
  };
  // Publisher's "single" spacing for some common fonts is tighter than the browser's (measured from Publisher PDFs)
  const FONT_LINE = { 'Times New Roman': 1.06 };
  PS.isSymbolFont = (f) => /^(webdings|wingdings( 2| 3)?|symbol|marlett|mt extra|segoe ui symbol|zapf ?dingbats)$/i.test(String(f || '').trim());
  /** A font's own single line (ascent, descent and line gap) as a multiple of its size; at most 1.2 like Publisher. */
  const naturalCache = new Map();
  PS.naturalLine = (family) => {
    if (!family || typeof document === 'undefined' || !document.body) return 1.2;
    if (naturalCache.has(family)) return naturalCache.get(family);
    const d = document.createElement('div');
    d.style.cssText = `position:absolute;left:-9999px;top:0;font-family:${PS.fontStack(family)};font-size:100px;line-height:normal;white-space:nowrap;padding:0;margin:0`;
    d.textContent = 'Hxgy';
    document.body.append(d);
    const h = d.getBoundingClientRect().height / 100;
    d.remove();
    const v = h > 0.5 ? (h <= 1.225 ? h : 1.2) : 1.2;   // Calibri's own line is 1.2207; only the taller Pro fonts are held to 1.2
    naturalCache.set(family, v);
    return v;
  };
  // Publisher's font effects (Font dialog): how they look here, and how they are recognised again
  PS.TEXT_EFFECTS = {
    outline: '-webkit-text-stroke-width: 0.045em; -webkit-text-stroke-color: currentColor; -webkit-text-fill-color: #ffffff',
    shadow: 'text-shadow: 0.07em 0.07em 0 rgba(0, 0, 0, 0.35)',
    emboss: 'text-shadow: -0.03em -0.03em 0 rgba(255, 255, 255, 0.95), 0.05em 0.05em 0.02em rgba(0, 0, 0, 0.45); -webkit-text-fill-color: #e6e6e6',
    engrave: 'text-shadow: -0.04em -0.04em 0.02em rgba(0, 0, 0, 0.45), 0.03em 0.03em 0 rgba(255, 255, 255, 0.95); -webkit-text-fill-color: #ffffff',
  };
  PS.effectOf = (cs) => {
    if (parseFloat(cs.webkitTextStrokeWidth) > 0) return 'outline';
    const ts = cs.textShadow || '';
    if (!ts || ts === 'none') return null;
    const firstWhite = /^rgba?\(255, 255, 255/.test(ts.trim());
    if (firstWhite && /rgba?\(0, 0, 0/.test(ts)) return 'emboss';
    if (/^rgba?\(0, 0, 0, 0\.45\)/.test(ts.trim()) && /255, 255, 255/.test(ts)) return 'engrave';
    return 'shadow';
  };

  const runCss = (r) => {
    const st = [];
    if (r.font) st.push(`font-family: ${PS.fontStack(r.font).replace(/"/g, "'")}`);
    if (r.size) st.push(`font-size: ${r.script ? PS.round(r.size * 0.6, 1) : r.size}pt`);
    if (r.bold) st.push('font-weight: bold');
    if (r.italic) st.push('font-style: italic');
    if (r.underline) st.push(UNDERLINE_CSS[r.underline] || UNDERLINE_CSS.single);
    if (r.allCaps) st.push('text-transform: uppercase');
    if (r.smallCaps) st.push('font-variant: small-caps');
    if (r.script) st.push(`vertical-align: ${r.script === 'sub' ? 'sub' : 'super'}; line-height: 0`);
    if (r.color) st.push(`color: ${r.color}`);
    if (r.strike) st.push(r.underline ? 'text-decoration-line: underline line-through' : 'text-decoration-line: line-through');
    if (r.tracking) st.push(`letter-spacing: ${r.tracking}pt`);
    if (r.effect && PS.TEXT_EFFECTS[r.effect]) st.push(PS.TEXT_EFFECTS[r.effect]);
    if (r.highlight) st.push(`background-color: ${r.highlight}`);
    return st.join('; ');
  };

  // Drop cap: the letters float at the start of the paragraph, sized to span the given number of lines.
  // (initial-letter is kept as a marker so the drop cap can be read back.)
  /** Inline style for drop-cap letters spanning `lines` lines of text at bodySize pt. */
  PS.dropCapStyle = (lines, bodySize, font, color) => {
    const lh = bodySize * 1.15;
    const fs = PS.round((lh * (lines - 1) + bodySize * 0.7) / 0.7, 1);
    const st = [`font-size: ${fs}pt`, 'float: left', `line-height: ${PS.round(lh * lines, 1)}pt`, `height: ${PS.round(lh * lines, 1)}pt`, 'margin-right: 2pt', `initial-letter: ${lines}`];
    if (font) st.unshift(`font-family: ${PS.fontStack(font).replace(/"/g, "'")}`);
    if (color) st.push(`color: ${color}`);
    return st.join('; ');
  };
  const dropCapHtml = (letters, r, dc, bodySize) => {
    const lh = bodySize * 1.15, lines = dc.lines;
    const fs = PS.round((lh * (lines - 1) + bodySize * 0.7) / 0.7, 1);
    const dr = Object.assign({}, r, dc.font ? { font: dc.font } : {}, { script: null, size: fs, underline: false });
    return `<span style="${runCss(dr)}; float: left; line-height: ${PS.round(lh * lines, 1)}pt; height: ${PS.round(lh * lines, 1)}pt; margin-right: 2pt; initial-letter: ${lines}">${PS.escapeHtml(letters)}</span>`;
  };

  /** Build editor HTML from Publisher paragraphs (inverse of htmlToParagraphs). */
  PS.paragraphsToHtml = (paras) => {
    const out = [];
    for (const p of paras || []) {
      const ps = [];
      if (p.align && p.align !== 'left') ps.push(`text-align: ${p.align}`);
      if (p.spaceBefore) ps.push(`margin-top: ${p.spaceBefore}pt`);
      if (p.spaceAfter) ps.push(`margin-bottom: ${p.spaceAfter}pt`);
      if (p.leftIndent) ps.push(`margin-left: ${p.leftIndent}pt`);
      if (p.rightIndent) ps.push(`margin-right: ${p.rightIndent}pt`);
      // Publisher never lets a hanging first line start left of the text box edge
      const fi = p.firstIndent ? Math.max(p.firstIndent, -(p.leftIndent || 0)) : 0;
      if (fi) ps.push(`text-indent: ${fi}pt`);
      const runs = (p.runs || []).filter(r => r.text);
      // The paragraph's own font sets a minimum line height in the browser; give it the paragraph's
      // smallest text so lines are only as tall as their text, like Publisher. Symbol fonts (check boxes
      // in Webdings and the like) don't set the line: their size counts, their font's shape doesn't.
      const body = runs.filter(r => !r.script);
      const textRuns = body.filter(r => !PS.isSymbolFont(r.font));
      const pool = textRuns.length ? textRuns : body;
      const strut = pool.length ? pool.reduce((a, r) => (r.size && (!a || r.size < a.size) ? r : a), null) : null;
      // Publisher's "1.19 sp" line spacing is that many of the font's own single lines
      if (p.lineSpacingPt) ps.push(`line-height: ${p.lineSpacingPt}pt`);
      else if (p.lineSpacing) ps.push(`line-height: ${PS.round(PS.naturalLine(strut && strut.font) * p.lineSpacing, 3)}`);
      const strutSize = strut ? strut.size : (p.markSize || ((p.runs || [])[0] || {}).size);
      if (strutSize) ps.push(`font-size: ${strutSize}pt`);
      if (strut && strut.font) ps.push(`font-family: ${PS.fontStack(strut.font).replace(/"/g, "'")}`);
      const natural = !p.lineSpacing && !p.lineSpacingPt;
      if (natural && strut && FONT_LINE[strut.font]) ps.push(`line-height: ${FONT_LINE[strut.font]}`);
      const runCssP = (r) => runCss(r) + (natural && FONT_LINE[r.font] && !r.script ? `; line-height: ${FONT_LINE[r.font]}` : '')
        + (textRuns.length && PS.isSymbolFont(r.font) && strut && (r.size || 0) <= strut.size ? '; line-height: 0' : '');
      let inner = '';
      let dropLeft = p.dropCap && p.dropCap.lines > 1 ? p.dropCap.letters || 1 : 0;
      for (const r of runs) {
        let text = r.text;
        if (dropLeft > 0) {
          const chars = [...text];
          const head = chars.slice(0, dropLeft).join('');
          dropLeft = 0;
          text = chars.slice([...head].length).join('');
          inner += dropCapHtml(head, r, p.dropCap, strutSize || r.size || 12);
          if (!text) continue;
        }
        if (r.underline && /\t/.test(text)) {
          // Browsers don't underline tab gaps, but Publisher does (that's how dot leaders are made),
          // so tab gaps get a bottom border in the same style instead.
          const bs = { dotted: 'dotted', dashed: 'dashed', double: 'double' }[r.underline] || 'solid';
          const bw = r.underline === 'double' ? 3 : r.underline === 'thick' ? 2 : 1;
          for (const piece of text.split(/([ \t]*\t[ \t]*)/)) {
            if (!piece) continue;
            if (piece.includes('\t')) inner += `<span style="${runCssP(Object.assign({}, r, { underline: false }))}; border-bottom: ${bw}px ${bs} ${r.color || '#000000'}">${piece}</span>`;
            else inner += `<span style="${runCssP(r)}">${PS.escapeHtml(piece).replace(/\u000b|\n/g, '<br>')}</span>`;
          }
          continue;
        }
        const txt = PS.escapeHtml(text).replace(/\u000b|\n/g, '<br>');
        inner += `<span style="${runCssP(r)}">${txt}</span>`;
      }
      out.push(`<p${ps.length ? ` style="${ps.join('; ')}"` : ''}${p.tabs && p.tabs.length && /\t/.test(inner) ? ` data-tabs="${p.tabs.join(',')}"` : ''}>${inner || '<br>'}</p>`);
    }
    return out.join('') || '<p><br></p>';
  };

  // ------------------------------------------------------------------ misc
  PS.docSummaryName = (filePath) => {
    if (!filePath) return 'Untitled';
    const base = filePath.split(/[\\/]/).pop();
    return base.replace(/\.(pgs|pagestudio|pub)$/i, '');
  };

  PS.collectUsedAssets = (doc) => {
    const used = new Set();
    const scan = (objs) => objs.forEach(o => { if (o.type === 'image' && o.asset) used.add(o.asset); });
    scan(doc.master.objects);
    scan((doc.scratch && doc.scratch.objects) || []);
    doc.pages.forEach(p => scan(p.objects));
    return used;
  };

  PS.normalizeDoc = (doc) => {
    doc.format = 'pagestudio';
    doc.version = doc.version || 1;
    doc.page = Object.assign({ width: 612, height: 792, margins: { top: 36, right: 36, bottom: 36, left: 36 }, background: '#ffffff' }, doc.page || {});
    doc.master = doc.master || { objects: [] };
    doc.master.objects = doc.master.objects || [];
    doc.scratch = doc.scratch || { objects: [] };
    doc.scratch.objects = doc.scratch.objects || [];
    doc.pages = (doc.pages && doc.pages.length) ? doc.pages : [PS.newPage()];
    doc.pages.forEach(p => { p.id = p.id || PS.uid('p'); p.objects = p.objects || []; if (p.useMaster === undefined) p.useMaster = true; });
    doc.assets = doc.assets || {};
    const fix = (o) => {
      o.id = o.id || PS.uid();
      if (o.type === 'text') Object.assign(o, Object.assign(PS.makeText(), o));
      else if (o.type === 'shape') Object.assign(o, Object.assign(PS.makeShape(o.kind), o));
      else if (o.type === 'image') Object.assign(o, Object.assign(PS.makeImage(o.asset), o));
      else if (o.type === 'line') Object.assign(o, Object.assign(PS.makeLine(), o));
    };
    doc.master.objects.forEach(fix);
    doc.scratch.objects.forEach(fix);
    doc.pages.forEach(p => p.objects.forEach(fix));
    return doc;
  };
  // Effects (shadows, glow, soft edges, reflections, bevels, 3-D) and picture adjustments, from effects.js
  const renderObjectBase = PS.renderObject;
  // A table's shadow / glow: drawn once, around the whole table, by its first cell
  function tableBackdrop(el, o, list) {
    const tid = o.tableId || o.groupId;
    const cells = list.filter(c => c.tableCell && (c.tableId || c.groupId) === tid);
    if (!cells.length || cells[0] !== o) return;
    const x0 = Math.min(...cells.map(c => c.x)), y0 = Math.min(...cells.map(c => c.y)), x1 = Math.max(...cells.map(c => c.x + c.w)), y1 = Math.max(...cells.map(c => c.y + c.h));
    const fx = o.tableFx, sh = [];
    const rgba = (hex, a) => { const m = /^#?([0-9a-f]{6})$/i.exec(hex || ''); if (!m) return hex || 'rgba(0,0,0,' + a + ')'; const n = parseInt(m[1], 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`; };
    if (fx.shadow) sh.push(`${fx.shadow.x || 0}pt ${fx.shadow.y || 0}pt ${fx.shadow.blur || 0}pt ${rgba(fx.shadow.color || '#000000', fx.shadow.opacity ?? 0.4)}`);
    if (fx.glow) sh.push(`0 0 ${fx.glow.size || 8}pt ${(fx.glow.size || 8) / 3}pt ${rgba(fx.glow.color || '#f0c040', fx.glow.opacity ?? 0.6)}`);
    if (!sh.length) return;
    const d = document.createElement('div');
    d.className = 'ps-table-fx';
    d.style.cssText = `position:absolute;pointer-events:none;left:${x0 - o.x}pt;top:${y0 - o.y}pt;width:${x1 - x0}pt;height:${y1 - y0}pt;box-shadow:${sh.join(',')}`;
    el.insertBefore(d, el.firstChild);
  }
  PS.renderObject = (o, opts) => {
    const el = renderObjectBase(o, opts);
    if (o.borderArt && window.PSFX && PSFX.borderArtCss && o.type !== 'line') {
      const ba = PSFX.borderArtCss(o);
      if (ba) { const d = document.createElement('div'); Object.assign(d.style, { position: 'absolute', left: 0, top: 0, right: 0, bottom: 0, boxSizing: 'border-box', pointerEvents: 'none', border: ba.width + ' solid transparent', borderImage: ba.img }); d.className = 'ps-borderart'; el.appendChild(d); }
    }
    if (o.tableCell && o.tableFx && opts && opts.list) tableBackdrop(el, o, opts.list);
    if (o.hidden) el.style.display = 'none';        // hidden from the Selection pane: not drawn, not printed
    return window.PSFX && o.type !== 'line' ? PSFX.apply(el, o) : el;
  };
})();
