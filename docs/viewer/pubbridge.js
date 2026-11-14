// PageStudio — Publisher bridge (renderer side): opens Publisher (.pub) files as PageStudio documents. (PageStudio
// no longer writes .pub files.)
'use strict';
(function () {
  const PubBridge = (window.PubBridge = {});

  function withProgress(text) {
    const p = UI.progress(text);
    const off = window.api.on('pub:progress', (t) => p.update(t));
    return { update: p.update, close: () => { off(); p.close(); } };
  }

  // ------------------------------------------------------------------ images
  const loadImg = (src) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });

  PubBridge.toPng = async (dataUrl) => {
    const img = await loadImg(dataUrl);
    const c = document.createElement('canvas');
    c.width = img.naturalWidth || 1; c.height = img.naturalHeight || 1;
    c.getContext('2d').drawImage(img, 0, 0);
    return c.toDataURL('image/png');
  };

  /** Render a picture object exactly as it appears in its frame (fit, crop, flip, corners) as a PNG. */
  async function renderImageObject(o, doc) {
    const a = doc.assets[o.asset];
    if (!a) return null;
    const img = await loadImg(a.dataUrl);
    const iw = img.naturalWidth, ih = img.naturalHeight;
    // Visible source rectangle
    let sx = 0, sy = 0, sw = iw, sh = ih, dx = 0, dy = 0, dw = o.w, dh = o.h;
    const frameAR = o.w / o.h, imgAR = iw / ih;
    if (o.fit !== 'contain') {
      const r = PS.imageSourceRect(o, iw, ih);
      sx = r.sx; sy = r.sy; sw = r.sw; sh = r.sh;
    } else if (o.fit === 'contain') {
      if (imgAR > frameAR) { dh = o.w / imgAR; dy = (o.h - dh) * ((o.focusY ?? 50) / 100); }
      else { dw = o.h * imgAR; dx = (o.w - dw) * ((o.focusX ?? 50) / 100); }
    }
    // Output resolution: as sharp as the source allows, at most 300 dpi
    const maxScale = 300 / 72;
    const srcScale = Math.max(sw / dw, sh / dh);
    let scale = Math.min(maxScale, Math.max(1, srcScale));
    const maxPx = 4000;
    scale = Math.min(scale, maxPx / Math.max(o.w, o.h));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(o.w * scale)); c.height = Math.max(1, Math.round(o.h * scale));
    const ctx = c.getContext('2d');
    ctx.scale(scale, scale);
    if (o.frame === 'ellipse') {
      ctx.beginPath();
      ctx.ellipse(o.w / 2, o.h / 2, o.w / 2, o.h / 2, 0, 0, Math.PI * 2);
      ctx.clip();
    } else if (o.radius) {
      ctx.beginPath();
      ctx.roundRect(0, 0, o.w, o.h, Math.min(o.radius, o.w / 2, o.h / 2));
      ctx.clip();
    }
    ctx.globalAlpha = o.opacity ?? 1;
    ctx.save();
    ctx.translate(o.flipH ? o.w : 0, o.flipV ? o.h : 0);
    ctx.scale(o.flipH ? -1 : 1, o.flipV ? -1 : 1);
    ctx.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh);
    ctx.restore();
    // An oval frame's outline is drawn into the picture (Publisher's picture outline would be square)
    if (o.frame === 'ellipse' && o.stroke && o.strokeWidth) {
      const sw2 = o.strokeWidth;
      ctx.beginPath();
      ctx.ellipse(o.w / 2, o.h / 2, Math.max(0, o.w / 2 - sw2 / 2), Math.max(0, o.h / 2 - sw2 / 2), 0, 0, Math.PI * 2);
      ctx.lineWidth = sw2; ctx.strokeStyle = o.stroke; ctx.stroke();
    }
    return c.toDataURL('image/png');
  }

  /** Draw a shape Publisher doesn't have as a transparent PNG. */
  function renderShapeObject(o) {
    const pad = (o.stroke ? o.strokeWidth || 0 : 0);
    const scale = Math.min(300 / 72, 3000 / Math.max(o.w + pad * 2, o.h + pad * 2));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round((o.w + pad * 2) * scale)); c.height = Math.max(1, Math.round((o.h + pad * 2) * scale));
    const ctx = c.getContext('2d');
    ctx.scale(scale, scale);
    ctx.translate(pad, pad);
    ctx.globalAlpha = o.opacity ?? 1;
    const p = new Path2D(PS.shapePath(o.kind, o.w, o.h, o));
    if (o.fill) { ctx.fillStyle = o.fill; ctx.fill(p); }
    if (o.stroke && o.strokeWidth) {
      ctx.strokeStyle = o.stroke; ctx.lineWidth = o.strokeWidth; ctx.lineJoin = 'round';
      if (o.dash === 'dash') ctx.setLineDash([o.strokeWidth * 4, o.strokeWidth * 2.5]);
      if (o.dash === 'dot') { ctx.setLineDash([0.01, o.strokeWidth * 2.2]); ctx.lineCap = 'round'; }
      ctx.stroke(p);
    }
    return { dataUrl: c.toDataURL('image/png'), pad };
  }

  // ------------------------------------------------------------------ export (PageStudio → .pub)
  /**
   * Effects Publisher can't do (glow, reflections, soft edges, bevels, 3-D, picture corrections, gradients…):
   * the object goes into the .pub file as a picture that looks exactly the same.
   */
  async function flattenObject(o, doc) {
    const e = o.effects || {};
    let pad = 6;
    if (e.shadow) pad = Math.max(pad, Math.abs(e.shadow.x || 0) + Math.abs(e.shadow.y || 0) + (e.shadow.blur || 0) * 2 + 4);
    if (e.glow) pad = Math.max(pad, (e.glow.size || 8) * 1.5 + 4);
    if (e.rotate3d) pad = Math.max(pad, Math.max(o.w, o.h) * 0.25);
    const vb = PS.visualBounds(o);
    const extraBelow = e.reflection ? vb.h + (e.reflection.distance || 0) : 0;
    const W = vb.w + pad * 2, H = vb.h + pad * 2 + extraBelow;
    const copy = JSON.parse(JSON.stringify(o));
    PS.moveObj(copy, pad - vb.x, pad - vb.y);
    const mini = PS.newDoc(W, H);
    mini.assets = {};
    for (const k of [o.asset, o.fillImage]) if (k && doc.assets[k]) mini.assets[k] = doc.assets[k];
    mini.pages[0].objects = [copy];
    const longest = Math.max(W, H);
    const dataUrl = await window.api.snapshot({ doc: mini, pageIndex: 0, maxPx: Math.min(4000, longest * 3), maxScale: 3, transparent: true });
    return { kind: 'picture', left: vb.x - pad, top: vb.y - pad, width: W, height: H, rotation: 0, imageData: dataUrl, alt: o.alt || null };
  }

  PubBridge.flattenObject = (o, doc) => flattenObject(o, doc);

  // ------------------------------------------------------------------ import (.pub → PageStudio)
  const baseFontOf = (text) => {
    for (const p of (text && text.paras) || []) for (const r of p.runs || []) {
      if (r.font) return { family: r.font, size: r.size || 12, color: r.color || '#000000' };
    }
    return Object.assign({}, PS.defaultFont);
  };

  // Publisher's "single" spacing follows each font's own line height, like CSS "normal".
  // Paragraphs with other spacing carry their own line-height (see PS.paragraphsToHtml).
  // Some fonts (Adobe's Pro fonts among them) have a taller "normal" line in a browser than Publisher's single
  // spacing, which made imported boxes overflow by a line. Publisher's single spacing is taken as at most 1.2 lines.
  const lhCache = new Map();
  const naturalLine = (family) => {
    if (lhCache.has(family)) return lhCache.get(family);
    const sp = document.createElement('span');
    sp.style.cssText = `position:absolute;left:-9999px;top:0;font-family:${PS.fontStack(family)};font-size:100px;line-height:normal;white-space:nowrap`;
    sp.textContent = 'Hxgy';
    document.body.append(sp);
    const v = sp.getBoundingClientRect().height / 100;
    sp.remove();
    lhCache.set(family, v);
    return v;
  };
  const lineHeightOf = (text) => {
    const f = baseFontOf(text);
    const n = naturalLine(f.family);
    return n > 1.225 ? 1.2 : 'normal';
  };
  function placeholderPicture(w, h) {
    const c = document.createElement('canvas');
    const s = Math.min(1, 600 / Math.max(w, h, 1));
    c.width = Math.max(8, Math.round(w * 2 * s)); c.height = Math.max(8, Math.round(h * 2 * s));
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#e8e4dd'; ctx.fillRect(0, 0, c.width, c.height);
    ctx.strokeStyle = '#b8b0a4'; ctx.lineWidth = 2; ctx.strokeRect(1, 1, c.width - 2, c.height - 2);
    ctx.fillStyle = '#8c847c'; ctx.font = `${Math.max(10, Math.min(28, c.width / 12))}px Segoe UI, sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('Clip art', c.width / 2, c.height / 2);
    return c.toDataURL('image/png');
  }
  async function cropPicture(dataUrl, crop) {
    try {
      const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = dataUrl; });
      const [t, r, b, l] = crop.map(v => Math.max(-1, Math.min(0.99, v)));
      const W = img.naturalWidth, H = img.naturalHeight;
      const sx = W * l, sy = H * t, sw = W * (1 - l - r), sh = H * (1 - t - b);
      if (sw <= 1 || sh <= 1) return dataUrl;
      const c = document.createElement('canvas');
      c.width = Math.round(sw); c.height = Math.round(sh);
      c.getContext('2d').drawImage(img, sx, sy, sw, sh, 0, 0, c.width, c.height);
      return c.toDataURL('image/png');
    } catch { return dataUrl; }
  }

  /**
   * Publisher stories can run through several linked text boxes. The file stores the whole story
   * once, so fill each box in order and carry the rest on to the next, like Publisher does.
   */
  function flowLinkedText(entries) {
    const groups = new Map();
    for (const e of entries) {
      if (!e.obj) continue;
      if (!groups.has(e.chain.id)) groups.set(e.chain.id, []);
      groups.get(e.chain.id).push(e);
    }
    const host = document.createElement('div');
    host.style.cssText = 'position:absolute;left:-99999px;top:0;visibility:hidden;';
    document.body.append(host);
    const fits = (o, paras, list) => {
      const test = Object.assign({}, o, { html: PS.paragraphsToHtml(paras) });
      host.innerHTML = '';
      const tmpList = list ? list.map(x => (x === o ? test : x)) : null;
      const el = PS.renderObject(test, { doc: App.doc || { assets: {} }, editable: false, list: tmpList });
      host.append(el);
      const c = el.querySelector('.ps-text-content');
      if (!c) return true;
      const pad = o.padding || [0, 0, 0, 0];
      if (o.columns > 1) return c.scrollWidth <= c.clientWidth + 1;
      return c.scrollHeight <= (o.h - pad[0] - pad[2]) * PS.PX_PER_PT + 1;
    };
    // split one paragraph after k words
    const tokens = (p) => {
      const t = [];
      p.runs.forEach((r, ri) => { for (const w of (r.text || '').split(/(?<=\s)/)) if (w) t.push({ ri, w }); });
      return t;
    };
    const take = (p, toks, k) => {
      const runs = p.runs.map(r => Object.assign({}, r, { text: '' }));
      toks.slice(0, k).forEach(({ ri, w }) => { runs[ri].text += w; });
      const rest = p.runs.map(r => Object.assign({}, r, { text: '' }));
      toks.slice(k).forEach(({ ri, w }) => { rest[ri].text += w; });
      return [Object.assign({}, p, { runs: runs.filter(r => r.text) }), Object.assign({}, p, { spaceBefore: 0, dropCap: null, runs: rest.filter(r => r.text) })];
    };
    for (const list of groups.values()) {
      list.sort((a, b) => a.chain.index - b.chain.index);
      // Keep the boxes linked so the text goes on flowing when it's edited
      list.forEach((e, idx) => {
        if (idx > 0) e.obj.linkPrev = list[idx - 1].obj.id;
        if (idx < list.length - 1) e.obj.linkNext = list[idx + 1].obj.id;
      });
      let remaining = list[0].paras.slice();
      let splitBefore = false;
      list.forEach((e, idx) => {
        const o = e.obj;
        if (splitBefore) o.contFirst = true;
        splitBefore = false;
        if (idx === list.length - 1) { o.html = PS.sanitizeHtml(PS.paragraphsToHtml(remaining.length ? remaining : [{ runs: [] }])); return; }
        const placed = [];
        while (remaining.length) {
          const next = remaining[0];
          if (fits(o, [...placed, next], e.list)) { placed.push(remaining.shift()); continue; }
          // Part of the paragraph may still fit: find how many words
          const toks = tokens(next);
          let lo = 0, hi = toks.length;
          while (lo < hi) {
            const mid = Math.ceil((lo + hi) / 2);
            if (fits(o, [...placed, take(next, toks, mid)[0]], e.list)) lo = mid; else hi = mid - 1;
          }
          if (lo > 0) { const [a, b] = take(next, toks, lo); placed.push(Object.assign(a, { spaceAfter: 0 })); remaining[0] = Object.assign(b, { firstIndent: 0 }); splitBefore = true; }
          break;
        }
        o.html = PS.sanitizeHtml(PS.paragraphsToHtml(placed.length ? placed : [{ runs: [] }]));
      });
    }
    host.remove();
  }

  // Publisher shadows are measured on the page; PageStudio's turn with the object, so turn them back
  const shadowFx = (s) => {
    if (!s.shadow) return null;
    const r = -((s.rotation || 0) * Math.PI) / 180;
    const x = s.shadow.x * Math.cos(r) - s.shadow.y * Math.sin(r), y = s.shadow.x * Math.sin(r) + s.shadow.y * Math.cos(r);
    return { shadow: { x: PS.round(x, 2), y: PS.round(y, 2), blur: PS.round(s.shadow.blur || 0, 2), color: s.shadow.color || '#808080', opacity: PS.round(s.shadow.opacity, 3) } };
  };

  // Publisher names some fonts by their style ("Adobe Garamond Pro Bold"); the browser may only know
  // the family ("Adobe Garamond Pro"). Use the family with that style when the full name isn't found.
  const STYLE_SUFFIX = /^(.*?)\s+((?:Semi|Demi|Extra|Ultra)?(?:Bold|Black|Heavy)(?:\s+Italic)?|Italic|Oblique)$/i;
  function fixFontNames(text) {
    for (const p of (text && text.paras) || []) for (const r of p.runs || []) {
      if (!r.font || fontInstalled(r.font)) continue;
      const m = r.font.match(STYLE_SUFFIX);
      if (!m || !fontInstalled(m[1])) continue;
      r.font = m[1];
      if (/bold|black|heavy/i.test(m[2])) r.bold = true;
      if (/italic|oblique/i.test(m[2])) r.italic = true;
    }
  }

  async function fromPub(shapes, images, doc, notes) {
    const out = [];
    for (const s of shapes || []) {
      try {
        if (s.text) fixFontNames(s.text);
        const before = out.length;
        const geo = { x: s.left, y: s.top, w: Math.max(1, s.width), h: Math.max(1, s.height), rotation: s.rotation || 0 };
        const fill = s.fill && s.fill.visible ? s.fill.color : null;
        const line = s.line && s.line.visible ? s.line : null;
        if (s.kind === 'text') {
          if (s.text && s.text.chain) notes.chains.push({ obj: null, chain: s.text.chain, paras: s.text.paras, at: out.length });
          out.push(PS.makeText(Object.assign(geo, {
            html: PS.sanitizeHtml(PS.paragraphsToHtml(s.text.paras)),
            font: baseFontOf(s.text),
            padding: s.text.margins || [2.88, 2.88, 2.88, 2.88],
            valign: s.text.valign || 'top', columns: s.text.columns || 1, columnGap: s.text.columnGap || 14.4,
            fill, stroke: line ? line.color : null, strokeWidth: line ? line.weight : 0, dash: line ? line.dash : 'solid',
            fillGradient: s.fill && s.fill.visible && s.fill.gradient ? s.fill.gradient : null,
            lineHeight: lineHeightOf(s.text),
            opacity: 1,
          })));
          const last = notes.chains[notes.chains.length - 1];
          if (last && last.obj === null && last.at === out.length - 1) { last.obj = out[out.length - 1]; last.list = out; }
          if (s.table) {   // a Publisher table cell: becomes a cell of a real PageStudio table
            const cell = out[out.length - 1], tk = notes.tables || (notes.tables = {});
            const tid = tk[s.table.key] || (tk[s.table.key] = PS.uid('g'));
            Object.assign(cell, { tableId: tid, tableCell: { r: s.table.r, c: s.table.c, rows: s.table.rows, cols: s.table.cols }, borders: s.table.borders || {}, stroke: null, strokeWidth: 0 });
            if (s.table.r === 0 && s.fill && s.fill.visible) cell.tableHead = true;
          }
        } else if (s.kind === 'shape') {
          let tileProps = {};
          if (s.fillTile && images[s.fillTile.image]) {   // texture fill: tile at the picture's own size
            const tid = PS.uid('a'), tUrl = images[s.fillTile.image], tdims = await App.measureImage(tUrl);
            doc.assets[tid] = { name: 'Texture', mime: 'image/png', dataUrl: tUrl, w: tdims ? tdims.w : 64, h: tdims ? tdims.h : 64 };
            const k = 72 / (s.fillTile.dpi || 96);
            tileProps = { fillImage: tid, fillTile: { w: (tdims ? tdims.w : 64) * k, h: (tdims ? tdims.h : 64) * k } };
          }
          out.push(PS.makeShape(s.shape, Object.assign(geo, tileProps, {
            fill, stroke: line ? line.color : null, strokeWidth: line ? line.weight : 0, dash: line ? line.dash : 'solid',
            path: s.path || undefined, wordArt: s.wordArt || undefined, radius: s.radius || 12, opacity: s.fill && s.fill.transparency && !s.fill.gradient ? 1 - s.fill.transparency : 1,
            fillGradient: s.fill && s.fill.visible && s.fill.gradient ? s.fill.gradient : null,
            html: s.text ? PS.sanitizeHtml(PS.paragraphsToHtml(s.text.paras)) : '',
            font: s.text ? baseFontOf(s.text) : Object.assign({}, PS.defaultFont),
            padding: (s.text && s.text.margins) || [7.2, 7.2, 7.2, 7.2], valign: (s.text && s.text.valign) || 'middle', lineHeight: s.text ? lineHeightOf(s.text) : 'normal',
          })));
        } else if (s.kind === 'line') {
          out.push(PS.makeLine({
            x1: s.x1, y1: s.y1, x2: s.x2, y2: s.y2,
            stroke: (s.line && s.line.color) || '#000000', strokeWidth: (s.line && s.line.weight) || 1,
            dash: (s.line && s.line.dash) || 'solid', arrowStart: !!(s.line && s.line.beginArrow), arrowEnd: !!(s.line && s.line.endArrow),
          }));
        } else if (s.kind === 'picture') {
          let dataUrl = images[s.image];
          if (!dataUrl) { dataUrl = placeholderPicture(geo.w, geo.h); notes.placeholders++; }
          else if (s.crop && s.crop.some(c => c)) dataUrl = await cropPicture(dataUrl, s.crop);
          const id = PS.uid('a');
          const dims = await App.measureImage(dataUrl);
          doc.assets[id] = { name: s.name || s.image || 'Picture', mime: 'image/png', dataUrl, w: dims ? dims.w : 100, h: dims ? dims.h : 100 };
          out.push(PS.makeImage(id, Object.assign(geo, {
            fit: 'stretch', stroke: line ? line.color : null, strokeWidth: line ? line.weight : 0,
            flipH: !!s.flipH, flipV: !!s.flipV, frame: s.frame || null, adjust: s.adjust || undefined,
          })));
          if (s.note) notes.asPictures++;
        }
        const made = out.length > before ? out[out.length - 1] : null;
        if (made && s.groupId) made.groupId = s.groupId;
        else if (made && made.tableId) made.groupId = made.tableId;
        if (made && s.shadow && made.type !== 'line') made.effects = Object.assign({}, made.effects || {}, shadowFx(s));
        // An object whose own layout flags are present but lack the wrap bits doesn't push text aside (e.g. a logo under a heading)
        if (made && s.borderArt) { made.borderArt = s.borderArt; if (s.borderArt.type === 'pub' && made.stroke) made.stroke = 'transparent'; }   // the pattern replaces the plain line; its width still insets the text
        if (made && s.layoutFlags != null && (s.layoutFlags & 3) !== 3 && made.type !== 'text') made.wrap = 'none';
        if (made && s.text && (s.text.wrapAround === false || (s.text.wrapAround == null && s.text.noWrap))) made.wrapText = false;
      } catch (e) {
        console.error('import shape failed', s, e);
        notes.failed++;
      }
    }
    return out;
  }

  PubBridge.importPub = async (pubPath) => {
    const prog = withProgress('Opening ' + PS.docSummaryName(pubPath) + '…');
    try {
      const r = await window.api.pubImport(pubPath);
      if (r.error) {
        prog.close();
        window.api.message({ type: 'error', message: r.error, detail: r.detail || '' });
        return;
      }
      prog.update('Building pages…');
      const { doc, notes, d } = await PubBridge.buildDoc(r);
      prog.close();
      App.loadDoc(doc, { pubPath });
      const parts = PubBridge.importNotes(doc, notes, d);
      App.toast('Opened ' + PS.docSummaryName(pubPath) + (parts.length ? ' — ' + parts.join('; ') : ''), { ms: 7000 });
    } catch (e) {
      prog.close();
      window.api.message({ type: 'error', message: 'Could not open the Publisher file.', detail: String(e.message || e) });
    }
  };

  /**
   * Publisher's single line spacing is tighter than a browser's for many fonts (display fonts especially), so a
   * heading that just fits its box in Publisher would spill over here. A box whose text doesn't fit gets its line
   * spacing brought down — never below 1.0 — until the text fits, the way it looked in Publisher. Boxes that still
   * don't fit at 1.0 really overflowed in Publisher too, and are left as they were.
   */
  function fitSingleSpacing(doc) {
    const host = document.createElement('div');
    host.style.cssText = 'position:absolute;left:-99999px;top:0;visibility:hidden;';
    document.body.append(host);
    const ratio = (o, list) => {
      host.innerHTML = '';
      const tmpList = list ? list.map(x => (x.id === o.id ? o : x)) : null;
      const el = PS.renderObject(o, { doc, editable: false, list: tmpList });
      host.append(el);
      const c = el.querySelector('.ps-text-content');
      return c ? PS.textOverflowRatio(c, o) : 0;
    };
    try {
      for (const list of [doc.master.objects, ...doc.pages.map(p => p.objects)]) {
        for (const o of list) {
          if (!(o.type === 'text' || (o.type === 'shape' && o.html)) || o.linkNext || o.linkPrev || !o.html) continue;
          const orig = o.lineHeight;
          if (ratio(o, list) <= 1.002) continue;
          const start = typeof orig === 'number' ? orig : 1.25;
          o.lineHeight = 1.0;
          if (ratio(o, list) > 1.002) { o.lineHeight = orig; continue; }
          let lo = 1.0, hi = start;
          for (let k = 0; k < 7; k++) {
            const mid = (lo + hi) / 2;
            o.lineHeight = mid;
            if (ratio(o, list) <= 1.002) lo = mid; else hi = mid;
          }
          o.lineHeight = Math.floor(lo * 100) / 100;
        }
      }
    } catch (e) { console.error('fit spacing', e); }
    host.remove();
  }

  // ---------------------------------------------------------------- after-import touch-ups that need measuring
  function measureHost() {
    const host = document.createElement('div');
    host.style.cssText = 'position:absolute;left:-99999px;top:0;visibility:hidden;';
    document.body.append(host);
    const render = (o, list) => {
      host.innerHTML = '';
      const tmpList = list ? list.map(x => (x.id === o.id ? o : x)) : null;
      const el = PS.renderObject(o, { doc: measureHost.doc, editable: false, list: tmpList });
      host.append(el);
      return { el, c: el.querySelector('.ps-text-content') };
    };
    return { host, render, done: () => host.remove() };
  }
  const textBoxes = (doc, fn) => {
    for (const list of [doc.master.objects, ...doc.pages.map(p => p.objects)]) {
      for (const o of list) {
        if (!(o.type === 'text' || (o.type === 'shape' && o.html)) || o.linkNext || o.linkPrev || !o.html) continue;
        fn(o, list);
      }
    }
  };

  /** Is this font installed? (A missing font draws the same as the fallback) */
  const fontKnown = new Map();
  function fontInstalled(family) {
    if (!family) return true;
    if (fontKnown.has(family)) return fontKnown.get(family);
    const cv = document.createElement('canvas').getContext('2d');
    const sample = 'MWmwil1|0OQ@#%& Hamburgefonstiv';
    let found = false;
    const alias = PS.fontAlias ? PS.fontAlias(family) : null;
    const names = `"${family.replace(/"/g, '')}"` + (alias ? `, "${alias.replace(/"/g, '')}"` : '');
    for (const g of ['monospace', 'serif', 'sans-serif']) {
      cv.font = `40px ${g}`; const a = cv.measureText(sample).width;
      cv.font = `40px ${names}, ${g}`; const b = cv.measureText(sample).width;
      if (Math.abs(a - b) > 0.5) { found = true; break; }
    }
    fontKnown.set(family, found);
    return found;
  }

  /**
   * A heading in a font this computer doesn't have is drawn in a stand-in that's often wider,
   * so a one-line heading wraps. Squeeze such short lines back onto one line.
   */
  function fitMissingFonts(doc, M) {
    textBoxes(doc, (o, list) => {
      if (o.rotation || o.textDirection === 'vertical') return;
      const tpl = document.createElement('template');
      tpl.innerHTML = o.html;
      const paras = [...tpl.content.children].filter(e => e.tagName === 'P');
      if (!paras.length) return;
      const families = (p) => {
        const out = new Set();
        for (const e of [p, ...p.querySelectorAll('*')]) { const f = e.style && e.style.fontFamily; if (f) out.add(f.split(',')[0].replace(/["']/g, '').trim()); }
        if (!out.size && o.font && o.font.family) out.add(o.font.family);
        return [...out];
      };
      const targets = paras.map((p, i) => ({ p, i })).filter(({ p }) => {
        const t = p.textContent;
        return t.trim() && t.length <= 80 && !p.querySelector('br') && !/\t/.test(t) && families(p).some(f => !fontInstalled(f));
      });
      if (!targets.length) return;
      const { c } = M.render(o, list);
      if (!c) return;
      const ps = [...c.querySelectorAll(':scope > p, :scope > * > p')].filter(p => !p.closest('.ps-wrap'));
      const k = c.getBoundingClientRect().width / Math.max(1, c.clientWidth || 1) || 1;
      let changed = false;
      for (const { p, i } of targets) {
        const rp = ps[i];
        if (!rp) continue;
        // How many lines it takes and how wide it would be on one
        const rg = document.createRange(); rg.selectNodeContents(rp);
        const tops = new Set([...rg.getClientRects()].filter(r => r.width > 0.5).map(r => Math.round(r.top)));
        if (tops.size < 2) continue;
        const saveWs = rp.style.whiteSpace; rp.style.whiteSpace = 'nowrap';
        const wide = rg.getBoundingClientRect().width / k;
        rp.style.whiteSpace = saveWs;
        const avail = rp.clientWidth || c.clientWidth;
        if (!(wide > avail) || wide > avail * 1.15) continue;
        const need = avail / wide * 0.995;        // fraction of the width that fits
        // Up to 3% tighter letters, then a slightly smaller size
        const chars = Math.max(1, p.textContent.length);
        const sizeOf = (e) => { const v = e.style.fontSize; return v && /pt$/.test(v) ? parseFloat(v) : null; };
        const base = sizeOf(p) || [...p.querySelectorAll('*')].map(sizeOf).find(v => v) || (o.font && o.font.size) || 12;
        const lsEm = Math.max(-0.03, -(wide - avail * 0.995) / chars / (base * PS.PX_PER_PT));
        const afterLs = wide + lsEm * base * PS.PX_PER_PT * chars;
        const scale = afterLs > avail * 0.995 ? (avail * 0.995) / afterLs : 1;
        if (lsEm < -0.001) p.style.letterSpacing = `${lsEm.toFixed(3)}em`;
        if (scale < 1) {
          const r1 = (v) => Math.floor(v * scale * 10) / 10;
          for (const e of [p, ...p.querySelectorAll('*')]) { const v = sizeOf(e); if (v) e.style.fontSize = `${r1(v)}pt`; }
          if (!sizeOf(p) && ![...p.querySelectorAll('*')].some(sizeOf)) p.style.fontSize = `${r1(base)}pt`;
        }
        void need;
        changed = true;
      }
      if (changed) o.html = tpl.innerHTML;
    });
  }

  /**
   * Tabbed lists (a name, tabs, then a second column). Publisher and PageStudio don't always agree
   * on whether text that ends right at a tab stop skips it, so one line can end up a whole stop
   * further over than the rest. Find the column most lines line up on and take out the extra tab.
   */
  function alignTabColumns(doc, M) {
    textBoxes(doc, (o, list) => {
      if (!/\t/.test(o.html) || o.rotation || o.textDirection === 'vertical') return;
      const T = o.tabSize || 18;
      const measure = () => {
        const { el, c } = M.render(o, list);
        if (!c) return null;
        const k = el.getBoundingClientRect().width / Math.max(1, o.w);   // px per pt
        if (!(k > 0)) return null;
        const pad = o.padding || [0, 0, 0, 0];
        const cols = Math.max(1, o.columns || 1), gap = cols > 1 ? (o.columnGap || 0) : 0;
        const colW = (o.w - pad[1] - pad[3] - gap * (cols - 1)) / cols;
        const left0 = el.getBoundingClientRect().left + pad[3] * k;
        // Walk the characters in order
        const toks = [];
        const w = document.createTreeWalker(c, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
        let n, para = null, tabNo = 0;
        while ((n = w.nextNode())) {
          if (n.nodeType === 1) {
            if (n.classList.contains('ps-wrap')) continue;
            if (n.tagName === 'BR') toks.push({ br: true });
            continue;
          }
          if (n.parentElement && n.parentElement.closest('.ps-wrap')) continue;
          const p = n.parentElement && n.parentElement.closest('p, li, div.ps-text-content > *');
          if (p !== para) { toks.push({ br: true }); para = p; }
          const t = n.nodeValue;
          for (let i = 0; i < t.length; i++) {
            const ch = t[i];
            toks.push({ node: n, i, ch, tab: ch === '\t' ? tabNo++ : -1 });
          }
        }
        const runs = [];
        for (let i = 0; i < toks.length; i++) {
          const tk = toks[i];
          if (tk.br || tk.tab < 0) continue;
          const tabs = [];
          let j = i;
          for (; j < toks.length; j++) {
            const x = toks[j];
            if (x.br) break;
            if (x.tab >= 0) tabs.push(x.tab);
            else if (!/[  ]/.test(x.ch)) break;
          }
          if (j < toks.length && !toks[j].br) {
            const r = document.createRange(); r.setStart(toks[j].node, toks[j].i); r.setEnd(toks[j].node, toks[j].i + 1);
            const rc = [...r.getClientRects()].find(q => q.height > 0);
            if (rc) {
              const xpt = (rc.left - left0) / k;
              const col = Math.max(0, Math.min(cols - 1, Math.floor((xpt + gap / 2) / (colW + gap))));
              runs.push({ tabs, x: xpt - col * (colW + gap) });
            }
          }
          i = j - 1;
        }
        return runs;
      };
      let runs = measure();
      if (!runs || runs.length < 5) return;
      // The column most lines line up on
      const near = (a, b) => Math.abs(a - b) <= 1.5;
      let best = null, bestN = 0;
      for (const r of runs) { const nn = runs.filter(q => near(q.x, r.x)).length; if (nn > bestN) { bestN = nn; best = r.x; } }
      if (bestN < 4 || bestN < runs.length * 0.5) return;
      const target = runs.filter(q => near(q.x, best)).reduce((a, q) => a + q.x, 0) / bestN;
      const removeTab = (html, nth) => {
        const tpl = document.createElement('template');
        tpl.innerHTML = html;
        const tw = document.createTreeWalker(tpl.content, NodeFilter.SHOW_TEXT);
        let tn, seen = 0;
        while ((tn = tw.nextNode())) {
          const t = tn.nodeValue;
          for (let i = 0; i < t.length; i++) {
            if (t[i] !== '\t') continue;
            if (seen++ === nth) { tn.nodeValue = t.slice(0, i) + t.slice(i + 1); return tpl.innerHTML; }
          }
        }
        return null;
      };
      let fixed = 0;
      for (let ri = 0; ri < runs.length && fixed < 60; ri++) {
        const r = runs[ri];
        const over = r.x - target;
        if (over < T * 0.5 || over > T * 3.5 || r.tabs.length < 2) continue;
        const html0 = o.html;
        let pick = null;
        for (const t of r.tabs) {
          const h = removeTab(html0, t);
          if (!h) continue;
          o.html = h;
          const again = measure();
          o.html = html0;
          if (!again || again.length !== runs.length) continue;
          const d = Math.abs(again[ri].x - target);
          if (d <= 3 && (!pick || d < pick.d)) pick = { h, d, runs: again };
          if (pick && d < 0.5) break;
        }
        if (pick) {
          o.html = pick.h;
          runs = pick.runs;
          fixed++;
          ri--;   // look at the same line again in case it had two extra tabs
        }
      }
    });
  }

  /** Turn what the .pub reader found ({ data, images }) into a publication. Shared with PageStudio Viewer. */
  PubBridge.buildDoc = async (r) => {
      const d = r.data;
      try { if (window.App && App.fontsReady) await App.fontsReady; } catch { /* fine */ }
      const doc = PS.newDoc(d.pageWidth, d.pageHeight);
      doc.page.margins = d.margins ? Object.assign({ top: 36, right: 36, bottom: 36, left: 36 }, d.margins) : { top: 36, right: 36, bottom: 36, left: 36 };
      if (d.grid && (d.grid.cols > 1 || d.grid.rows > 1)) doc.page.grid = d.grid;
      if (d.sheet) doc.page.sheet = d.sheet;
      if (d.mailMerge && d.mailMerge.path) doc.mailMerge = { path: d.mailMerge.path, table: d.mailMerge.table || null, exclude: [], sort: null };
      if (d.masterGuides && ((d.masterGuides.x || []).length || (d.masterGuides.y || []).length)) doc.master.guides = d.masterGuides;
      const notes = { asPictures: 0, missing: 0, failed: 0, placeholders: 0, chains: [] };
      doc.master.objects = await fromPub(d.master, r.images, doc, notes);
      doc.scratch.objects = await fromPub(d.scratch, r.images, doc, notes);
      doc.pages = [];
      for (const p of d.pages || []) {
        const page = PS.newPage();
        page.objects = await fromPub(p.objects, r.images, doc, notes);
        page.useMaster = p.useMaster !== false;
        if (p.guides && ((p.guides.x || []).length || (p.guides.y || []).length)) page.guides = p.guides;
        page.background = p.background && p.background.toLowerCase() !== '#ffffff' ? p.background : null;
        doc.pages.push(page);
      }
      if (!doc.pages.length) doc.pages.push(PS.newPage());
      flowLinkedText(notes.chains);
      {
        const M = measureHost();
        measureHost.doc = doc;
        try { fitMissingFonts(doc, M); } catch (e) { console.error('missing fonts', e); }
        try { alignTabColumns(doc, M); } catch (e) { console.error('tab columns', e); }
        M.done();
      }
      fitSingleSpacing(doc);
      // Anything sitting completely off a page belongs on the shared scratch area
      for (const page of doc.pages) {
        for (let i = page.objects.length - 1; i >= 0; i--) {
          if (PS.isOffPage(page.objects[i], doc.page)) doc.scratch.objects.push(page.objects.splice(i, 1)[0]);
        }
      }
      return { doc, notes, d };
  };
  /** Short notes about anything that didn't come across exactly. */
  PubBridge.importNotes = (doc, notes, d) => {
      const parts = [];
      if (notes.asPictures) parts.push(`${notes.asPictures} item${notes.asPictures > 1 ? 's' : ''} (tables, WordArt and similar) came in as pictures`);
      if (notes.placeholders) parts.push(`${notes.placeholders} clip-art picture${notes.placeholders > 1 ? 's' : ''} couldn’t be shown and ${notes.placeholders > 1 ? 'are' : 'is'} marked with a gray box`);
      if (d.skipped || notes.failed) parts.push(`${(d.skipped || 0) + notes.failed} item${(d.skipped || 0) + notes.failed > 1 ? 's' : ''} couldn’t be read`);
      if (doc.scratch.objects.length) parts.push(`${doc.scratch.objects.length} item${doc.scratch.objects.length > 1 ? 's are' : ' is'} on the scratch area`);
      return parts;
  };
})();
