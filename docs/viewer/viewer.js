// PageStudio Viewer — shows PageStudio (.pgs) and Microsoft Publisher (.pub) publications on Android.
// Pages are drawn by the same code PageStudio for Windows uses (core.js, effects.js, pubbridge.js).
'use strict';
(function () {
  const V = (window.Viewer = {});
  const $ = (id) => document.getElementById(id);
  const N = window.Android || null;              // the Android app's bridge (absent in a desktop browser)
  const ic = (n) => PS.icon(n);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const h = (tag, attrs, ...kids) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'html') el.innerHTML = v; else if (k.startsWith('on')) el[k] = v; else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(kid));
    return el;
  };
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* full or blocked */ } },
  };

  // ------------------------------------------------------------------ web version (iPhone / any browser)
  // A web page can't reopen a file by name later, so the web version keeps a copy of recent files in the
  // browser's own storage on this phone (never uploaded anywhere).
  const webFiles = (() => {
    if (N || !window.indexedDB) return null;
    let dbp = null;
    const db = () => (dbp = dbp || new Promise((res, rej) => { const r = indexedDB.open('psv-files', 1); r.onupgradeneeded = () => r.result.createObjectStore('f'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }));
    const tx = async (mode, fn) => { const d = await db(); return new Promise((res, rej) => { const t = d.transaction('f', mode); const out = fn(t.objectStore('f')); t.oncomplete = () => res(out && out.result); t.onerror = () => rej(t.error); }); };
    return {
      put: (k, bytes) => tx('readwrite', st => st.put(bytes, k)).catch(() => {}),
      get: (k) => tx('readonly', st => st.get(k)).catch(() => null),
      del: (k) => tx('readwrite', st => st.delete(k)).catch(() => {}),
    };
  })();
  V.isWeb = !N;

  // The .pub import code asks the app for a couple of things
  window.App = window.App || {
    doc: null,
    measureImage: (dataUrl) => new Promise((res) => { const i = new Image(); i.onload = () => res({ w: i.naturalWidth, h: i.naturalHeight }); i.onerror = () => res(null); i.src = dataUrl; }),
  };

  const S = { doc: null, name: '', kind: '', fileId: null, entry: null, fitMode: 'width', zoom: 1, fit: 1, page: 0, fonts: [], notes: [] };

  // ================================================================== small UI pieces
  let toastTimer = null;
  function toast(msg, ms = 2600) {
    const t = $('toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, ms);
  }
  const busy = (on, text) => { $('busy').hidden = !on; if (text) $('busy-t').textContent = text; };
  const overlays = [];
  function closeTop() { const o = overlays.pop(); if (o) { o.close(true); return true; } return false; }
  function closeAll() { while (overlays.length) overlays.pop().close(true); }
  /** A bottom sheet (phones) / floating panel (tablets). */
  function sheet(title, body, cls = '') {
    const root = $('sheet-root');
    const scrim = h('div', { class: 'scrim' });
    const box = h('div', { class: 'bsheet ' + cls }, h('div', { class: 'grab' }), title ? h('h3', null, title) : null, h('div', { class: 'body' }, body));
    const o = { close(fromStack) { scrim.remove(); box.remove(); if (!fromStack) { const i = overlays.indexOf(o); if (i >= 0) overlays.splice(i, 1); } } };
    scrim.onclick = () => o.close();
    // Drag the sheet down to close it
    let y0 = null;
    box.addEventListener('touchstart', (e) => { if (box.querySelector('.body').scrollTop <= 0) y0 = e.touches[0].clientY; }, { passive: true });
    box.addEventListener('touchmove', (e) => { if (y0 != null) { const dy = e.touches[0].clientY - y0; if (dy > 0) box.style.transform = `translateY(${dy}px)` + (innerWidth >= 720 ? ' translateX(-50%)' : ''); } }, { passive: true });
    box.addEventListener('touchend', (e) => { if (y0 == null) return; const dy = e.changedTouches[0].clientY - y0; y0 = null; if (dy > 90) o.close(); else box.style.transform = ''; });
    root.append(scrim, box);
    overlays.push(o);
    return o;
  }
  function menu(items) {
    const box = h('div', { class: 'menu' });
    let o;
    for (const it of items) {
      if (it === 'sep') { box.append(h('div', { class: 'sepr' })); continue; }
      if (!it || it.hidden) continue;
      const b = h('button', { class: 'mi' }, h('span', { html: ic(it.icon || 'chevronRight') }), h('span', null, it.label), it.right ? h('span', { class: 'r' }, it.right) : null);
      b.onclick = () => { o.close(); it.run(); };
      box.append(b);
    }
    o = sheet(null, box);
    return o;
  }
  function dialog(title, text, buttons) {
    return new Promise((resolve) => {
      const scrim = h('div', { class: 'scrim' });
      const btns = h('div', { class: 'btns' });
      const box = h('div', { class: 'dlg' }, h('h3', null, title), typeof text === 'string' ? h('p', { class: 'note' }, text) : text, btns);
      const o = { close(fromStack) { scrim.remove(); box.remove(); if (!fromStack) { const i = overlays.indexOf(o); if (i >= 0) overlays.splice(i, 1); } resolve(null); } };
      for (const b of buttons) {
        const el = h('button', { class: b.primary ? 'primary' : '' }, b.label);
        el.onclick = () => { scrim.remove(); box.remove(); const i = overlays.indexOf(o); if (i >= 0) overlays.splice(i, 1); resolve(b.value); };
        btns.append(el);
      }
      scrim.onclick = () => o.close();
      $('sheet-root').append(scrim, box);
      overlays.push(o);
    });
  }

  // ================================================================== theme
  function applyTheme() {
    const t = store.get('psv.theme', 'system');
    document.documentElement.classList.toggle('dark', t === 'dark');
    document.documentElement.classList.toggle('light', t === 'light');
  }

  // ================================================================== recent files
  const recent = () => store.get('psv.recent', []);
  function remember(entry) {
    const list = recent().filter(r => r.key !== entry.key);
    const old = recent().find(r => r.key === entry.key);
    list.unshift(Object.assign({}, old || {}, entry, { when: Date.now() }));
    // Keep every pinned file plus the 20 most recent others
    const pinned = list.filter(r => r.pinned), others = list.filter(r => !r.pinned).slice(0, 20);
    store.set('psv.recent', [...pinned, ...others].sort((a, b) => (b.pinned - a.pinned) || (b.when - a.when)));
  }
  function ago(t) {
    const s = (Date.now() - t) / 1000;
    if (s < 60) return 'just now';
    if (s < 3600) return Math.round(s / 60) + ' min ago';
    if (s < 86400) return Math.round(s / 3600) + ' hr ago';
    const d = new Date(t);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
  }
  function drawHome() {
    const list = recent();
    const box = $('r-list');
    box.innerHTML = '';
    $('h-clear').hidden = !list.some(r => !r.pinned);
    if (!list.length) box.append(h('div', { class: 'empty' }, 'Publications you open will be listed here.'));
    for (const r of list) {
      const land = r.w && r.h && r.w > r.h;
      const star = h('button', { class: 'r-star' + (r.pinned ? ' on' : ''), 'aria-label': r.pinned ? 'Unpin' : 'Pin', html: ic(r.pinned ? 'starOn' : 'star') });
      const item = h('button', { class: 'r-item' },
        h('img', { class: 'r-ico', src: 'file-' + (r.kind === 'pub' ? 'pub' : 'pgs') + '.png', alt: '', draggable: false }),
        h('div', { class: 'r-text' }, h('div', { class: 'r-name' }, (r.name || 'Publication').replace(/\.(pgs|pub|pagestudio)$/i, '')),
          h('div', { class: 'r-meta' }, [ago(r.when), r.pages ? r.pages + (r.pages === 1 ? ' page' : ' pages') : null, r.source].filter(Boolean).join(' · '))),
        star);
      star.onclick = (e) => { e.stopPropagation(); const all = recent(); const x = all.find(y => y.key === r.key); if (x) x.pinned = !x.pinned; store.set('psv.recent', all.sort((a, b) => (b.pinned - a.pinned) || (b.when - a.when))); drawHome(); };
      item.onclick = () => openRecent(r);
      // Long press: remove from the list
      let lp = null;
      item.addEventListener('touchstart', () => { lp = setTimeout(async () => { lp = null; const v = await dialog('Remove from Recent?', `“${r.name}” will be taken off this list. The file itself isn’t touched.`, [{ label: 'Cancel', value: false }, { label: 'Remove', primary: true, value: true }]); if (v) { store.set('psv.recent', recent().filter(y => y.key !== r.key)); if (N && N.forget) N.forget(r.key); if (webFiles) webFiles.del(r.key); drawHome(); } }, 650); }, { passive: true });
      item.addEventListener('touchend', () => { if (lp) clearTimeout(lp); }, { passive: true });
      item.addEventListener('touchmove', () => { if (lp) clearTimeout(lp); lp = null; }, { passive: true });
      box.append(item);
    }
  }
  async function openRecent(r) {
    if (N && N.openRecent) { busy(true, 'Opening ' + r.name + '…'); N.openRecent(r.key, r.uri || ''); return; }
    const bytes = webFiles ? await webFiles.get(r.key) : null;
    if (!bytes) { toast('Open the file again with the Open button.'); return; }
    busy(true, 'Opening ' + r.name + '…');
    try { await openBytes(new Uint8Array(bytes), r.name, { key: r.key, source: r.source || 'This phone' }); }
    catch (e) { busy(false); dialog('Couldn’t open the file', String(e.message || e), [{ label: 'OK', primary: true, value: true }]); }
  }

  // ================================================================== opening files
  /** Called by the Android app when a file is ready: info = { id, key, name, uri, source, cached } */
  V.openFromNative = async (info) => {
    if (typeof info === 'string') info = JSON.parse(info);
    if (info.error) { busy(false); dialog('Couldn’t open the file', info.error, [{ label: 'OK', value: true, primary: true }]); return; }
    busy(true, 'Opening ' + (info.name || 'publication') + '…');
    if (info.savedCopy) setTimeout(() => toast(`Showing the copy saved ${ago(info.savedCopy)}. For the newest version, open it again from ${info.source || 'the app it came from'}.`, 6500), 1200);
    try {
      const res = await fetch('/file/' + encodeURIComponent(info.id));
      if (!res.ok) throw new Error('The file could not be read (' + res.status + ').');
      const buf = new Uint8Array(await res.arrayBuffer());
      await openBytes(buf, info.name || 'Publication', info);
    } catch (e) {
      busy(false);
      dialog('Couldn’t open the file', String(e.message || e), [{ label: 'OK', value: true, primary: true }]);
    }
  };
  V.nativeBusy = (on, text) => busy(!!on, text);

  function kindOf(buf, name) {
    if (buf[0] === 0xD0 && buf[1] === 0xCF && buf[2] === 0x11 && buf[3] === 0xE0) return 'pub';
    let i = 0; while (i < buf.length && i < 64 && (buf[i] === 0x20 || buf[i] === 0x0A || buf[i] === 0x0D || buf[i] === 0x09 || buf[i] === 0xEF || buf[i] === 0xBB || buf[i] === 0xBF)) i++;
    if (buf[i] === 0x7B) return 'pgs';
    if (/\.pub$/i.test(name)) return 'pub';
    if (/\.(pgs|pagestudio)$/i.test(name)) return 'pgs';
    return null;
  }

  // Clip art in Publisher files is often a Windows metafile (EMF/WMF); draw it as SVG
  function metafileToDataUrl(ext, bytes) {
    try {
      const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      const dv = new DataView(ab);
      let svg;
      if (ext === 'emf' && window.EMFJS) {
        EMFJS.loggingEnabled(false);
        const l = dv.getInt32(8, true), t = dv.getInt32(12, true), r = dv.getInt32(16, true), b = dv.getInt32(20, true);
        const w = Math.max(1, r - l), hh = Math.max(1, b - t);
        svg = new EMFJS.Renderer(ab).render({ width: w + 'px', height: hh + 'px', wExt: w, hExt: hh, xExt: w, yExt: hh, mapMode: 8 });
      } else if (ext === 'wmf' && window.WMFJS) {
        WMFJS.loggingEnabled(false);
        let w = 1000, hh = 1000, inch = 1440;
        if (dv.getUint32(0, true) === 0x9AC6CDD7) {
          const l = dv.getInt16(6, true), t = dv.getInt16(8, true), r = dv.getInt16(10, true), b = dv.getInt16(12, true);
          w = Math.max(1, Math.abs(r - l)); hh = Math.max(1, Math.abs(b - t)); inch = dv.getUint16(14, true) || 1440;
        }
        svg = new WMFJS.Renderer(ab).render({ width: Math.round(w / inch * 96) + 'px', height: Math.round(hh / inch * 96) + 'px', xExt: w, yExt: hh, mapMode: 8 });
      }
      if (!svg) return null;
      svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      const text = new XMLSerializer().serializeToString(svg);
      return 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(text)));
    } catch (e) { console.warn('metafile', e); return null; }
  }
  const b64 = (bytes) => { let s = ''; const CH = 0x8000; for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH)); return btoa(s); };

  async function openBytes(buf, name, info = {}) {
    const kind = kindOf(buf, name);
    if (!kind) throw new Error('This doesn’t look like a PageStudio (.pgs) or Publisher (.pub) file.');
    let doc, notes = [];
    if (kind === 'pgs') {
      busy(true, 'Reading ' + name + '…');
      const text = new TextDecoder('utf-8').decode(buf);
      doc = JSON.parse(text);
      if (!doc || doc.format !== 'pagestudio') throw new Error('This isn’t a PageStudio file.');
      PS.normalizeDoc(doc);
    } else {
      busy(true, 'Reading the Publisher file…');
      await new Promise(r => setTimeout(r, 30));
      const { data, images: raw } = PubReader.readPub(buf);
      const images = {};
      let lost = 0;
      for (const [nm, im] of Object.entries(raw)) {
        if (im.ext === 'emf' || im.ext === 'wmf') { const u = metafileToDataUrl(im.ext, im.data); if (u) images[nm] = u; else lost++; }
        else if (im.ext === 'tif') lost++;
        else images[nm] = `data:${im.mime};base64,${b64(im.data)}`;
      }
      busy(true, 'Building pages…');
      const r = await PubBridge.buildDoc({ data, images });
      doc = r.doc;
      notes = PubBridge.importNotes(doc, r.notes, r.d).filter(n => !/scratch area/.test(n));
      if (lost) notes.push(`${lost} picture${lost > 1 ? 's' : ''} in a format phones can’t show`);
    }
    showDoc(doc, name, kind, info, notes);
  }

  // ================================================================== showing a publication
  function showDoc(doc, name, kind, info, notes) {
    closeAll();
    stopFind();
    S.doc = doc; App.doc = doc; S.name = name; S.kind = kind; S.fileId = info.id || null; S.notes = notes || [];
    S.page = 0; S.zoom = 1;
    S.fitMode = store.get('psv.fit', 'width');
    document.body.classList.remove('home');
    $('home').hidden = true; $('scroller').hidden = false; $('pagechip').hidden = false;
    $('t-name').textContent = name.replace(/\.(pgs|pub|pagestudio)$/i, '');
    const pg = doc.page;
    $('t-sub').textContent = `${kind === 'pub' ? 'Publisher' : 'PageStudio'} · ${fmtIn(pg.width)} × ${fmtIn(pg.height)} in · ${doc.pages.length} page${doc.pages.length === 1 ? '' : 's'}`;
    // Handwriting written in PageStudio comes inside the file; get its letters ready while the pages draw
    if (window.HW && HW.idsInDoc(doc).size) HW.prepare(doc).catch(() => {});
    renderPages();
    $('scroller').scrollTop = 0; $('scroller').scrollLeft = 0;
    busy(false);
    if (info.key) remember({ key: info.key, uri: info.uri || '', name, kind, source: info.source || '', pages: doc.pages.length, w: pg.width, h: pg.height });
    checkFonts();
    if (S.notes.length) setTimeout(() => toast(S.notes.join('; '), 6000), 600);
    if (N && N.docShown) N.docShown(name);
    if (N && N.keepScreenOn && store.get('psv.keepOn', false)) N.keepScreenOn(true);
  }
  const fmtIn = (pt) => String(+(pt / 72).toFixed(2));

  function renderPages() {
    const doc = S.doc, pg = doc.page;
    const host = $('pages');
    host.innerHTML = '';
    const two = store.get('psv.spread', false) && innerWidth > innerHeight && pg.height >= pg.width * 0.9 && doc.pages.length > 1;
    host.classList.toggle('two', two);
    const make = (i) => {
      const wrap = h('div', { class: 'sheet-wrap', 'data-page': i });
      const sh = h('div', { class: 'sheet' });
      sh.style.width = pg.width + 'pt'; sh.style.height = pg.height + 'pt';
      try { sh.append(PS.renderPageEl({ doc, pageIndex: i, editable: false })); } catch (e) { console.error(e); sh.append(h('div', { style: 'padding:20px;color:#b00' }, 'This page couldn’t be drawn.')); }
      wrap.append(sh);
      if (doc.pages.length > 1) wrap.append(h('div', { class: 'sheet-label' }, `Page ${i + 1}`));
      return wrap;
    };
    if (two) {
      for (let i = 0; i < doc.pages.length; i += 2) {
        const row = h('div', { class: 'row' }, make(i));
        if (i + 1 < doc.pages.length) row.append(make(i + 1));
        host.append(row);
      }
    } else for (let i = 0; i < doc.pages.length; i++) host.append(make(i));
    applyZoom();
  }

  // ------------------------------------------------------------------ zoom
  function computeFit() {
    const pg = S.doc.page;
    const sc = $('scroller');
    const two = $('pages').classList.contains('two');
    const pwPx = pg.width * 96 / 72 * (two ? 2 : 1) + (two ? 16 : 0), phPx = pg.height * 96 / 72;
    const availW = Math.max(100, sc.clientWidth - 24), availH = Math.max(100, sc.clientHeight - 60);
    const fw = availW / pwPx;
    return S.fitMode === 'page' ? Math.min(fw, availH / phPx) : fw;
  }
  function applyZoom(keep) {
    if (!S.doc) return;
    S.fit = computeFit();
    $('pages').style.zoom = String(S.fit * S.zoom);
    updateChip();
    void keep;
  }
  function setZoom(z, cx, cy) {
    const sc = $('scroller');
    const r = sc.getBoundingClientRect();
    const fx = cx == null ? sc.clientWidth / 2 : cx - r.left, fy = cy == null ? sc.clientHeight / 2 : cy - r.top;
    const old = S.fit * S.zoom;
    const px = (sc.scrollLeft + fx) / old, py = (sc.scrollTop + fy) / old;   // point under the fingers, in page px
    S.zoom = Math.max(0.5, Math.min(8, z));
    applyZoom();
    const nz = S.fit * S.zoom;
    sc.scrollLeft = px * nz - fx; sc.scrollTop = py * nz - fy;
  }
  function updateChip() {
    if (!S.doc) return;
    const n = S.doc.pages.length;
    $('pc-text').textContent = n > 1 ? `Page ${S.page + 1} of ${n}` : `${Math.round(S.fit * S.zoom * 100)}%`;
    $('pc-prev').hidden = $('pc-next').hidden = n < 2;
    $('pc-fit').textContent = Math.abs(S.zoom - 1) > 0.02 ? 'Fit' : (S.fitMode === 'width' ? 'Whole page' : 'Fit width');
  }
  // Pinch to zoom (the pages are drawn sharp again when the fingers lift), double-tap to zoom in or out
  function setupGestures() {
    const sc = $('scroller'), pages = $('pages');
    let pinch = null, lastTap = 0, lastXY = null;
    const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    const mid = (t) => ({ x: (t[0].clientX + t[1].clientX) / 2, y: (t[0].clientY + t[1].clientY) / 2 });
    sc.addEventListener('touchstart', (e) => {
      if (e.touches.length === 2) {
        const m = mid(e.touches), r = sc.getBoundingClientRect();
        pinch = { d0: dist(e.touches), m0: m, s: 1, ox: sc.scrollLeft + m.x - r.left, oy: sc.scrollTop + m.y - r.top };
        pages.style.transformOrigin = `${pinch.ox / (S.fit * S.zoom)}px ${pinch.oy / (S.fit * S.zoom)}px`;
        e.preventDefault();
      } else if (e.touches.length === 1) {
        const t = e.touches[0], now = Date.now();
        if (now - lastTap < 300 && lastXY && Math.hypot(t.clientX - lastXY.x, t.clientY - lastXY.y) < 30) {
          e.preventDefault();
          setZoom(S.zoom > 1.05 ? 1 : 2.5, t.clientX, t.clientY);
          lastTap = 0;
        } else { lastTap = now; lastXY = { x: t.clientX, y: t.clientY }; }
      }
    }, { passive: false });
    sc.addEventListener('touchmove', (e) => {
      if (!pinch || e.touches.length !== 2) return;
      e.preventDefault();
      const s = Math.max(0.5 / S.zoom, Math.min(8 / S.zoom, dist(e.touches) / pinch.d0));
      const m = mid(e.touches);
      pinch.s = s; pinch.m = m;
      const z = S.fit * S.zoom;
      pages.style.transform = `translate(${(m.x - pinch.m0.x) / z}px, ${(m.y - pinch.m0.y) / z}px) scale(${s})`;
    }, { passive: false });
    const end = () => {
      if (!pinch) return;
      const p = pinch; pinch = null;
      pages.style.transform = ''; pages.style.transformOrigin = '';
      const m = p.m || p.m0;
      setZoomAround(S.zoom * p.s, p.ox, p.oy, m);
    };
    sc.addEventListener('touchend', (e) => { if (e.touches.length < 2) end(); });
    sc.addEventListener('touchcancel', end);
    // Ctrl + mouse wheel / trackpad pinch on Chromebooks and in a desktop browser
    sc.addEventListener('wheel', (e) => { if (e.ctrlKey) { e.preventDefault(); setZoom(S.zoom * Math.exp(-e.deltaY * 0.002), e.clientX, e.clientY); } }, { passive: false });
    sc.addEventListener('scroll', () => { trackPage(); chipActive(); }, { passive: true });
    // A single tap in full screen brings the bars back
    sc.addEventListener('click', () => { if (document.body.classList.contains('fullscreen')) setFullscreen(false); });
  }
  function setZoomAround(z, ox, oy, m) {
    const sc = $('scroller'), r = sc.getBoundingClientRect();
    const old = S.fit * S.zoom;
    S.zoom = Math.max(0.5, Math.min(8, z));
    applyZoom();
    const nz = S.fit * S.zoom;
    sc.scrollLeft = (ox / old) * nz - (m.x - r.left);
    sc.scrollTop = (oy / old) * nz - (m.y - r.top);
  }
  let chipTimer = null;
  function chipActive() { const c = $('pagechip'); c.classList.remove('dim'); clearTimeout(chipTimer); chipTimer = setTimeout(() => c.classList.add('dim'), 2500); }
  function trackPage() {
    if (!S.doc) return;
    const sc = $('scroller'), mid = sc.getBoundingClientRect().top + sc.clientHeight / 2;
    let best = 0, bd = Infinity;
    for (const el of $('pages').querySelectorAll('.sheet-wrap')) {
      const r = el.getBoundingClientRect();
      const d = mid < r.top ? r.top - mid : mid > r.bottom ? mid - r.bottom : 0;
      if (d < bd) { bd = d; best = +el.dataset.page; }
    }
    if (best !== S.page) { S.page = best; updateChip(); }
  }
  function goPage(i, flashObj) {
    if (!S.doc) return;
    i = Math.max(0, Math.min(S.doc.pages.length - 1, i));
    const el = $('pages').querySelector(`.sheet-wrap[data-page="${i}"]`);
    if (!el) return;
    const sc = $('scroller');
    const target = flashObj ? $('pages').querySelector(`.sheet-wrap[data-page="${i}"] .ps-obj[data-id="${CSS.escape(flashObj)}"]`) : null;
    const r = (target || el).getBoundingClientRect(), sr = sc.getBoundingClientRect();
    sc.scrollTo({ top: sc.scrollTop + r.top - sr.top - (target ? sc.clientHeight / 3 : 10), left: target ? sc.scrollLeft + r.left - sr.left - 20 : sc.scrollLeft, behavior: 'smooth' });
    S.page = i; updateChip();
    if (target) { target.classList.remove('flash'); void target.offsetWidth; target.classList.add('flash'); }
  }

  // ================================================================== fonts
  // Look-alike fonts that come with the viewer: same letter widths, so lines wrap the same way
  const ALIKE = { 'times new roman': 'Liberation Serif', times: 'Liberation Serif', arial: 'Liberation Sans', helvetica: 'Liberation Sans', 'arial mt': 'Liberation Sans', 'courier new': 'Liberation Mono', courier: 'Liberation Mono', calibri: 'Carlito', cambria: 'Caladea' };
  const GENERIC = /^(serif|sans-serif|monospace|cursive|fantasy|system-ui|inherit|initial)$/i;
  function docFonts(doc) {
    const used = new Map();
    const add = (f) => { f = String(f || '').split(',')[0].replace(/["']/g, '').trim(); if (f && !GENERIC.test(f)) used.set(f.toLowerCase(), f); };
    const scan = (objs) => (objs || []).forEach(o => {
      if (o.font && o.font.family) add(o.font.family);
      const html = (o.html || '').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
      for (const m of html.matchAll(/font-family:\s*((?:"[^"]*"|'[^']*'|[^;"'>])+)/gi)) add(m[1]);
      for (const m of html.matchAll(/face="([^"]+)"/gi)) add(m[1]);
    });
    scan(doc.master && doc.master.objects);
    doc.pages.forEach(p => scan(p.objects));
    return [...used.values()].sort((a, b) => a.localeCompare(b));
  }
  const cv = document.createElement('canvas').getContext('2d');
  function installed(f) {
    const sample = 'mmmmmmmmmmlliWWWQQ@#&abcxyz0123';
    for (const g of ['monospace', 'serif', 'sans-serif']) {
      cv.font = `48px ${g}`; const a = cv.measureText(sample).width;
      cv.font = `48px "${f.replace(/"/g, '')}", ${g}`; const b = cv.measureText(sample).width;
      if (Math.abs(a - b) > 0.5) return true;
    }
    return false;
  }
  async function checkFonts() {
    const fams = docFonts(S.doc);
    try { await Promise.all(Object.values(ALIKE).map(f => document.fonts.load(`16px "${f}"`))); await document.fonts.ready; } catch { /* ignore */ }
    S.fonts = fams.map(f => {
      const k = f.toLowerCase();
      if (ALIKE[k]) return { name: f, status: 'alike', note: ALIKE[k] };
      return { name: f, status: installed(f) ? 'ok' : 'missing' };
    });
    const missing = S.fonts.filter(f => f.status === 'missing');
    const w = $('fontwarn');
    if (!missing.length || store.get('psv.hideFontWarn', false)) { w.hidden = true; return; }
    const names = missing.slice(0, 3).map(f => f.name).join(', ') + (missing.length > 3 ? ` and ${missing.length - 3} more` : '');
    w.innerHTML = '';
    const det = h('button', { class: 'link' }, 'Details');
    const x = h('button', { class: 'ib', 'aria-label': 'Dismiss', html: ic('close') });
    det.onclick = showFonts;
    x.onclick = () => { w.hidden = true; };
    w.append(h('span', { html: ic('warning') }),
      h('div', { class: 'msg' }, h('b', null, `${missing.length === 1 ? 'A font' : missing.length + ' fonts'} in this publication ${missing.length === 1 ? 'isn’t' : 'aren’t'} on this device`), ` (${names}). Similar fonts are used instead, so some text may look a little different or wrap differently than on the PC.`),
      h('div', { class: 'fw-btns' }, det, x));
    w.hidden = false;
  }
  function showFonts() {
    const rows = S.fonts.map(f => h('div', { class: 'fontrow' }, h('span', { style: `font-family:"${f.name.replace(/"/g, '')}", sans-serif` }, f.name),
      h('span', { class: 'st ' + f.status }, f.status === 'ok' ? '✓ On this device' : f.status === 'alike' ? `≈ ${f.note} (same spacing)` : '⚠ Not on this device')));
    sheet('Fonts in this publication', h('div', null,
      h('p', { class: 'note' }, 'Phones and tablets don’t have most Windows fonts. PageStudio Viewer brings look-alikes for the common ones (Times New Roman, Arial, Calibri, Cambria, Courier New) with exactly the same letter widths, so those lines wrap just as they do on the PC. Fonts marked ⚠ are shown in a similar standard font.'),
      h('div', { class: 'fontlist' }, rows.length ? rows : h('div', { class: 'empty' }, 'No fonts found.')),
      (() => { const b = h('button', { class: 'btn primary', style: 'margin-top:14px' }, h('span', { html: ic('plus') }), 'Add the missing fonts…'); b.onclick = () => { closeTop(); showAddedFonts(); }; return b; })()));
  }

  // ------------------------------------------------------------------ fonts you add yourself
  // Font files (.ttf / .otf) picked on the device are kept inside the app and used for every publication.
  const FDB = { open() { return new Promise((res, rej) => { const r = indexedDB.open('psv-fonts', 1); r.onupgradeneeded = () => r.result.createObjectStore('fonts', { keyPath: 'id' }); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); } };
  async function fontsAll() { try { const db = await FDB.open(); return await new Promise((res) => { const q = db.transaction('fonts').objectStore('fonts').getAll(); q.onsuccess = () => res(q.result || []); q.onerror = () => res([]); }); } catch { return []; } }
  async function fontPut(rec) { const db = await FDB.open(); await new Promise((res, rej) => { const t = db.transaction('fonts', 'readwrite'); t.objectStore('fonts').put(rec); t.oncomplete = res; t.onerror = () => rej(t.error); }); }
  async function fontDel(id) { const db = await FDB.open(); await new Promise((res) => { const t = db.transaction('fonts', 'readwrite'); t.objectStore('fonts').delete(id); t.oncomplete = res; t.onerror = res; }); }
  /** Family and style names from a font file's name table. */
  function fontNames(ab) {
    const dv = new DataView(ab);
    let base = 0;
    if (dv.getUint32(0) === 0x74746366) base = dv.getUint32(12);            // 'ttcf' collection: first font
    const num = dv.getUint16(base + 4);
    let nameOff = -1;
    for (let i = 0; i < num; i++) { const r = base + 12 + i * 16; if (dv.getUint32(r) === 0x6E616D65) nameOff = dv.getUint32(r + 8); }
    if (nameOff < 0) throw new Error('no name table');
    const count = dv.getUint16(nameOff + 2), strOff = nameOff + dv.getUint16(nameOff + 4);
    const found = {};
    for (let i = 0; i < count; i++) {
      const r = nameOff + 6 + i * 12;
      const plat = dv.getUint16(r), enc = dv.getUint16(r + 2), lang = dv.getUint16(r + 4), id = dv.getUint16(r + 6), len = dv.getUint16(r + 8), off = dv.getUint16(r + 10);
      if (![1, 2, 4, 16, 17].includes(id)) continue;
      let str = '';
      if (plat === 3 || plat === 0) { for (let j = 0; j < len; j += 2) str += String.fromCharCode(dv.getUint16(strOff + off + j)); }
      else if (plat === 1 && enc === 0) { for (let j = 0; j < len; j++) str += String.fromCharCode(dv.getUint8(strOff + off + j)); }
      else continue;
      const score = (plat === 3 ? 2 : 1) + (lang === 0x409 || lang === 0 ? 1 : 0);
      if (!found[id] || found[id].score < score) found[id] = { str: str.trim(), score };
    }
    const g = (id) => (found[id] ? found[id].str : '');
    return { family: g(1), sub: g(2), typo: g(16), typoSub: g(17), full: g(4) };
  }
  const styleOf = (sub) => ({ weight: /bold|black|heavy/i.test(sub) ? 'bold' : 'normal', style: /italic|oblique/i.test(sub) ? 'italic' : 'normal' });
  async function registerFont(rec) {
    const fams = [];
    const add = (fam, sub) => { if (!fam) return; const st = styleOf(sub); fams.push(fam); try { const ff = new FontFace(fam, rec.data, st); document.fonts.add(ff); return ff.load(); } catch { return null; } };
    await Promise.all([add(rec.names.family, rec.names.sub), rec.names.typo && rec.names.typo !== rec.names.family ? add(rec.names.typo, rec.names.typoSub || rec.names.sub) : null, rec.names.full && rec.names.full !== rec.names.family ? add(rec.names.full, rec.names.sub) : null]);
    return fams;
  }
  async function loadAddedFonts() { for (const r of await fontsAll()) { try { await registerFont(r); } catch { /* skip a bad file */ } } }
  async function addFontFiles(files) {
    let ok = 0, bad = 0;
    for (const f of files) {
      try {
        const data = await f.arrayBuffer();
        const names = fontNames(data);
        if (!names.family) throw new Error('no family name');
        const rec = { id: (names.full || names.family + ' ' + names.sub).toLowerCase(), file: f.name, names, data, size: data.byteLength, added: Date.now() };
        await fontPut(rec);
        await registerFont(rec);
        ok++;
      } catch (e) { console.warn('font', f.name, e); bad++; }
    }
    toast(`${ok} font${ok === 1 ? '' : 's'} added` + (bad ? ` · ${bad === 1 ? '1 file wasn’t a font' : bad + ' files weren’t fonts'}` : ''));
    if (V._redrawFonts) V._redrawFonts();
    if (S.doc) { renderPages(); checkFonts(); }
  }
  async function showAddedFonts() {
    const list = await fontsAll();
    const box = h('div', { class: 'fontlist' });
    const draw = (items) => {
      box.innerHTML = '';
      if (!items.length) box.append(h('div', { class: 'empty' }, 'No fonts added yet.'));
      for (const r of items.sort((a, b) => (a.names.full || a.names.family).localeCompare(b.names.full || b.names.family))) {
        const del = h('button', { class: 'ib', 'aria-label': 'Remove', html: ic('trash') });
        del.onclick = async () => { await fontDel(r.id); draw((await fontsAll())); toast('Removed — it goes away fully the next time the app starts.'); };
        box.append(h('div', { class: 'fontrow' }, h('span', null, r.names.full || (r.names.family + ' ' + r.names.sub)), h('span', { class: 'st', style: 'color:var(--ink-3);font-weight:400' }, Math.round(r.size / 1024) + ' KB'), del));
      }
    };
    draw(list);
    V._redrawFonts = async () => { if (box.isConnected) draw(await fontsAll()); };
    const add = h('button', { class: 'btn primary', style: 'margin-top:14px' }, h('span', { html: ic('plus') }), 'Add font files…');
    add.onclick = () => $('font-file').click();
    sheet('Your fonts', h('div', null,
      h('p', { class: 'note' }, 'Add the font files your publications use (.ttf or .otf) and they’ll look exactly as they do on the PC. On the computer, copy them from C:\\Windows\\Fonts into OneDrive, then add them here from the OneDrive folder. Only add fonts you’re licensed to use on this device.'),
      add, box));
  }

  // ================================================================== find
  let findHits = [], findIdx = -1;
  function startFind() {
    $('findbar').hidden = false;
    const q = $('f-q'); q.value = ''; $('f-count').textContent = '';
    setTimeout(() => q.focus(), 50);
  }
  function stopFind() {
    $('findbar').hidden = true; findHits = []; findIdx = -1;
    if (window.CSS && CSS.highlights) { CSS.highlights.delete('find'); CSS.highlights.delete('findcur'); }
  }
  function runFind() {
    const q = $('f-q').value.trim().toLowerCase();
    findHits = []; findIdx = -1;
    if (window.CSS && CSS.highlights) { CSS.highlights.delete('find'); CSS.highlights.delete('findcur'); }
    if (!q) { $('f-count').textContent = ''; return; }
    for (const wrap of $('pages').querySelectorAll('.sheet-wrap')) {
      const page = +wrap.dataset.page;
      const tw = document.createTreeWalker(wrap.querySelector('.sheet'), NodeFilter.SHOW_TEXT);
      let n;
      while ((n = tw.nextNode())) {
        const t = n.data.toLowerCase();
        let i = t.indexOf(q);
        while (i >= 0) {
          const r = new Range(); r.setStart(n, i); r.setEnd(n, i + q.length);
          findHits.push({ r, page, obj: n.parentElement.closest('.ps-obj') });
          i = t.indexOf(q, i + q.length);
        }
      }
    }
    if (window.CSS && CSS.highlights && window.Highlight) CSS.highlights.set('find', new Highlight(...findHits.map(x => x.r)));
    $('f-count').textContent = findHits.length ? `0/${findHits.length}` : 'None';
    if (findHits.length) stepFind(1);
  }
  function stepFind(d) {
    if (!findHits.length) return;
    findIdx = (findIdx + d + findHits.length) % findHits.length;
    const hit = findHits[findIdx];
    $('f-count').textContent = `${findIdx + 1}/${findHits.length}`;
    if (window.CSS && CSS.highlights && window.Highlight) CSS.highlights.set('findcur', new Highlight(hit.r));
    const sc = $('scroller'), r = hit.r.getBoundingClientRect(), sr = sc.getBoundingClientRect();
    sc.scrollTo({ top: sc.scrollTop + r.top - sr.top - sc.clientHeight / 3, left: Math.max(0, sc.scrollLeft + r.left - sr.left - sc.clientWidth / 3), behavior: 'smooth' });
  }

  // ================================================================== pages sheet, info, menu
  function showPages() {
    const doc = S.doc, pg = doc.page;
    const grid = h('div', { class: 'thumbs' });
    const k = Math.min(120 / (pg.width * 96 / 72), 160 / (pg.height * 96 / 72));
    let o;
    doc.pages.forEach((p, i) => {
      const ts = h('div', { class: 'tsheet' });
      ts.style.width = pg.width + 'pt'; ts.style.height = pg.height + 'pt'; ts.style.zoom = String(k);
      try { ts.append(PS.renderPageEl({ doc, pageIndex: i, editable: false })); } catch { /* skip */ }
      const t = h('button', { class: 'thumb' + (i === S.page ? ' cur' : '') }, h('div', { class: 'tbox' }, ts), `Page ${i + 1}`);
      t.onclick = () => { o.close(); goPage(i); };
      grid.append(t);
    });
    o = sheet(`Pages (${doc.pages.length})`, grid);
  }
  function showInfo() {
    const doc = S.doc, pg = doc.page;
    const pics = (() => { let n = 0; const c = (objs) => (objs || []).forEach(o => { if (o.type === 'image') n++; }); c(doc.master.objects); doc.pages.forEach(p => c(p.objects)); return n; })();
    const objs = doc.pages.reduce((n, p) => n + p.objects.length, 0) + doc.master.objects.length;
    const missing = S.fonts.filter(f => f.status === 'missing').length;
    const kv = h('div', { class: 'kv' },
      h('div', { class: 'k' }, 'File'), h('div', null, S.name),
      h('div', { class: 'k' }, 'Kind'), h('div', null, S.kind === 'pub' ? 'Microsoft Publisher publication' : 'PageStudio publication'),
      h('div', { class: 'k' }, 'Page size'), h('div', null, `${fmtIn(pg.width)} × ${fmtIn(pg.height)} in (${pg.width > pg.height ? 'landscape' : 'portrait'})`),
      h('div', { class: 'k' }, 'Pages'), h('div', null, String(doc.pages.length)),
      h('div', { class: 'k' }, 'Items'), h('div', null, `${objs} (${pics} picture${pics === 1 ? '' : 's'})`),
      h('div', { class: 'k' }, 'Fonts'), h('div', null, `${S.fonts.length}${missing ? ` — ${missing} not on this device` : ''}`),
      doc.savedAt ? h('div', { class: 'k' }, 'Saved') : null, doc.savedAt ? h('div', null, new Date(doc.savedAt).toLocaleString()) : null,
      doc.app ? h('div', { class: 'k' }, 'Made with') : null, doc.app ? h('div', null, doc.app) : null);
    const body = h('div', null, kv);
    if (S.notes.length) body.append(h('p', { class: 'note', style: 'margin-top:14px' }, 'Notes: ' + S.notes.join('; ') + '.'));
    const fb = h('button', { class: 'btn', style: 'margin-top:14px' }, h('span', { html: ic('fontDlg') }), 'Fonts in this publication');
    fb.onclick = showFonts;
    body.append(fb);
    sheet('Publication info', body);
  }
  function showSettings() {
    const theme = store.get('psv.theme', 'system');
    const seg = h('div', { class: 'seg' }, ...[['system', 'Automatic'], ['light', 'Light'], ['dark', 'Dark']].map(([v, l]) => {
      const b = h('button', { class: v === theme ? 'on' : '' }, l);
      b.onclick = () => { store.set('psv.theme', v); applyTheme(); seg.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b)); };
      return b;
    }));
    const sw = (key, label, def, onchange) => {
      const s = h('button', { class: 'switch' + (store.get(key, def) ? ' on' : ''), 'aria-label': label });
      s.onclick = () => { const v = !store.get(key, def); store.set(key, v); s.classList.toggle('on', v); if (onchange) onchange(v); };
      return h('div', { class: 'optrow' }, h('span', null, label), s);
    };
    sheet('Settings', h('div', null,
      h('div', { class: 'note' }, 'Appearance'), seg,
      sw('psv.spread', 'Two pages side by side when the phone is sideways', false, () => S.doc && renderPages()),
      sw('psv.keepOn', 'Keep the screen on while a publication is open', false, (v) => N && N.keepScreenOn && N.keepScreenOn(!!v && !!S.doc)),
      sw('psv.hideFontWarn', 'Don’t show the missing-fonts notice', false, () => S.doc && checkFonts()),
      (() => { const b = h('button', { class: 'optrow', style: 'width:100%;text-align:left' }, h('span', null, 'Your fonts…'), h('span', { html: ic('chevronRight') })); b.onclick = showAddedFonts; return b; })()));
  }
  function showAbout() {
    const v = N && N.version ? N.version() : '1.0.0';
    sheet('About', h('div', null,
      h('p', { class: 'note' }, `PageStudio Viewer ${v} — made for Bible Baptist Church, Ashtabula, Ohio. It shows PageStudio (.pgs) and Microsoft Publisher (.pub) publications made with PageStudio for Windows; to change one, open it on the PC.`),
      h('p', { class: 'note' }, 'Look-alike fonts: Liberation (Red Hat) and Carlito / Caladea (Google), under the SIL Open Font License. Clip art drawing: rtf.js (MIT).')));
  }
  function showMore() {
    const doc = !!S.doc;
    menu([
      { icon: 'open', label: 'Open a publication…', run: pickFile },
      doc ? 'sep' : null,
      { icon: 'pagesNav', label: 'Pages', hidden: !doc, run: showPages },
      { icon: 'search', label: 'Find', hidden: !doc, run: startFind },
      { icon: S.fitMode === 'width' ? 'fitPage' : 'pageWidth', label: S.fitMode === 'width' ? 'Show whole page' : 'Fit page width', hidden: !doc, run: () => { S.fitMode = S.fitMode === 'width' ? 'page' : 'width'; store.set('psv.fit', S.fitMode); S.zoom = 1; applyZoom(); } },
      { icon: 'zoomSel', label: 'Full screen', hidden: !doc, run: () => setFullscreen(true) },
      doc ? 'sep' : null,
      { icon: 'print', label: 'Print…', hidden: !doc, run: printDoc },
      { icon: 'share', label: 'Share this file…', hidden: !doc || !N, run: () => N.shareFile() },
      { icon: 'newWindow', label: 'Open in another app…', hidden: !doc || !N || !N.openWith, run: () => N.openWith() },
      { icon: 'info', label: 'Publication info', hidden: !doc, run: showInfo },
      'sep',
      { icon: 'settings', label: 'Settings', run: showSettings },
      { icon: 'help', label: 'About PageStudio Viewer', run: showAbout },
    ].filter(x => x !== null));
  }

  // ================================================================== full screen
  function setFullscreen(on) {
    document.body.classList.toggle('fullscreen', on);
    if (N && N.setFullscreen) N.setFullscreen(!!on);
    if (on) toast('Tap the page to show the buttons again.');
    setTimeout(() => applyZoom(), 120);
  }

  // ================================================================== printing
  async function printDoc() {
    const missing = S.fonts.filter(f => f.status === 'missing');
    if (missing.length) {
      const go = await dialog('Print with substitute fonts?', `${missing.map(f => f.name).join(', ')} ${missing.length === 1 ? 'isn’t' : 'aren’t'} on this device, so similar fonts will be used. The printout may look a little different from the PC — for the exact look, print it from PageStudio on the computer.`,
        [{ label: 'Cancel', value: false }, { label: 'Print anyway', primary: true, value: true }]);
      if (!go) return;
    }
    const doc = S.doc, pg = doc.page;
    const root = $('print-root');
    root.innerHTML = '';
    let st = document.getElementById('print-size');
    if (!st) { st = h('style', { id: 'print-size' }); document.head.append(st); }
    st.textContent = `@page { size: ${pg.width}pt ${pg.height}pt; margin: 0; }`;
    doc.pages.forEach((p, i) => {
      const s = h('div', { class: 'psheet' });
      s.style.width = pg.width + 'pt'; s.style.height = pg.height + 'pt';
      s.append(PS.renderPageEl({ doc, pageIndex: i, editable: false }));
      root.append(s);
    });
    await Promise.all(Array.from(root.querySelectorAll('img')).map(im => im.decode().catch(() => {})));
    try { await document.fonts.ready; } catch { /* ignore */ }
    const job = S.name.replace(/\.(pgs|pub|pagestudio)$/i, '');
    if (N && N.print) N.print(job, pg.width > pg.height, pg.width, pg.height);
    else window.print();
  }
  V.printDone = () => { $('print-root').innerHTML = ''; };

  // ================================================================== opening, home, back
  /** Open a publication: choose where from — CX File Explorer (your network share), Android's picker
   *  (OneDrive, Google Drive, this device…) or another file manager. The last one used comes first. */
  function pickFile() {
    if (!N || !N.pickFile) { $('h-file').click(); return; }
    let apps = [];
    try { apps = N.pickSources ? JSON.parse(N.pickSources()) : []; } catch { apps = []; }
    const last = store.get('psv.lastSource', null);
    const items = [
      ...apps.map(a => ({ id: a.pkg, label: a.label, icon: a.icon, note: a.pkg === 'com.cxinventor.file.explorer' ? 'Your network share and this device' : 'Browse files' })),
      { id: '', label: 'Files, OneDrive & Google Drive', note: 'Android’s file picker' },
    ];
    items.sort((a, b) => (b.id === last) - (a.id === last));
    const box = h('div', { class: 'menu' });
    let o;
    for (const it of items) {
      const img = it.icon ? h('img', { src: it.icon, alt: '', class: 'src-icon' }) : h('span', { class: 'src-icon gen', html: ic('open') });
      const b = h('button', { class: 'mi src' }, img, h('span', { class: 'src-t' }, h('span', null, it.label), h('small', null, it.id === last ? 'Last used' : it.note)));
      b.onclick = () => { o.close(); store.set('psv.lastSource', it.id); if (N.pickFrom) N.pickFrom(it.id); else N.pickFile(); };
      box.append(b);
    }
    o = sheet('Open a publication from', box);
  }
  function goHome() {
    closeAll(); stopFind();
    if (document.body.classList.contains('fullscreen')) setFullscreen(false);
    S.doc = null; App.doc = null;
    $('pages').innerHTML = '';
    document.body.classList.add('home');
    $('home').hidden = false; $('scroller').hidden = true; $('pagechip').hidden = true; $('fontwarn').hidden = true;
    $('t-name').textContent = 'PageStudio Viewer'; $('t-sub').textContent = '';
    drawHome();
    if (N && N.docClosed) N.docClosed();
  }
  /** Android back button: returns true if the viewer used it. */
  V.back = () => {
    if (closeTop()) return true;
    if (document.body.classList.contains('fullscreen')) { setFullscreen(false); return true; }
    if (!$('findbar').hidden) { stopFind(); return true; }
    if (S.doc) { goHome(); return true; }
    return false;
  };

  // ================================================================== start
  function init() {
    applyTheme();
    $('b-find').innerHTML = ic('search');
    $('b-pages').innerHTML = ic('pagesNav');
    $('b-print').innerHTML = ic('print');
    $('b-more').innerHTML = '<svg class="ico" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>';
    $('f-prev').innerHTML = '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m6 15 6-6 6 6"/></svg>';
    $('f-next').innerHTML = '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m6 9 6 6 6-6"/></svg>';
    $('f-close').innerHTML = ic('close');
    $('pc-prev').innerHTML = '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m15 6-6 6 6 6"/></svg>';
    $('pc-next').innerHTML = '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m9 6 6 6-6 6"/></svg>';
    $('h-open').innerHTML = ic('open') + '<span>Open a publication</span>';
    $('h-tip').innerHTML = '<b>Your network share:</b> tap <b>Open a publication</b>, choose <b>CX File Explorer</b>, and pick the file from the server.<br><br><b>From other apps:</b> in OneDrive, CX File Explorer, Files or Gmail you can also tap a .pgs or .pub file and choose <b>PageStudio Viewer</b> (pick <b>Always</b> to make it the one that opens them).';
    $('b-home').onclick = () => { if (S.doc) goHome(); };
    $('b-find').onclick = startFind;
    $('b-pages').onclick = showPages;
    $('b-print').onclick = printDoc;
    $('b-more').onclick = showMore;
    $('h-open').onclick = pickFile;
    $('h-clear').onclick = async () => { const v = await dialog('Clear the Recent list?', 'Pinned publications stay. No files are deleted.', [{ label: 'Cancel', value: false }, { label: 'Clear', primary: true, value: true }]); if (v) { const keep = recent().filter(r => r.pinned); for (const r of recent()) if (!r.pinned) { if (N && N.forget) N.forget(r.key); if (webFiles) webFiles.del(r.key); } store.set('psv.recent', keep); drawHome(); } };
    $('h-file').onchange = async () => {
      const f = $('h-file').files[0]; if (!f) return;
      busy(true, 'Opening ' + f.name + '…');
      try {
        const bytes = new Uint8Array(await f.arrayBuffer());
        const key = 'local:' + f.name;
        await openBytes(bytes, f.name, { key, source: N ? 'This device' : 'This phone' });
        if (webFiles) {
          webFiles.put(key, bytes);
          // keep copies only of files still on the Recent list
          const keep = new Set(recent().map(r => r.key));
          try { const d = await new Promise((res) => { const r = indexedDB.open('psv-files', 1); r.onsuccess = () => res(r.result); }); const t = d.transaction('f', 'readwrite'); const st = t.objectStore('f'); const rq = st.getAllKeys(); rq.onsuccess = () => { for (const k of rq.result) if (!keep.has(k)) st.delete(k); }; } catch { /* fine */ }
        }
      }
      catch (e) { busy(false); dialog('Couldn’t open the file', String(e.message || e), [{ label: 'OK', primary: true, value: true }]); }
      $('h-file').value = '';
    };
    $('f-q').addEventListener('input', () => { clearTimeout(runFind.t); runFind.t = setTimeout(runFind, 250); });
    $('f-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); stepFind(e.shiftKey ? -1 : 1); } });
    $('f-next').onclick = () => stepFind(1);
    $('f-prev').onclick = () => stepFind(-1);
    $('f-close').onclick = stopFind;
    $('pc-prev').onclick = () => goPage(S.page - 1);
    $('pc-next').onclick = () => goPage(S.page + 1);
    $('pc-fit').onclick = () => { if (Math.abs(S.zoom - 1) > 0.02) S.zoom = 1; else { S.fitMode = S.fitMode === 'width' ? 'page' : 'width'; store.set('psv.fit', S.fitMode); } applyZoom(); };
    setupGestures();
    const ff = h('input', { type: 'file', id: 'font-file', accept: '.ttf,.otf,.ttc,font/ttf,font/otf,application/x-font-ttf,application/font-sfnt,application/octet-stream', multiple: true, hidden: true });
    ff.onchange = () => { const files = Array.from(ff.files || []); ff.value = ''; if (files.length) addFontFiles(files); };
    document.body.append(ff);
    loadAddedFonts();
    let rz = null;
    window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => { if (!S.doc) return; const two = store.get('psv.spread', false) && innerWidth > innerHeight; if (two !== $('pages').classList.contains('two')) renderPages(); else applyZoom(); }, 150); });
    window.addEventListener('afterprint', V.printDone);
    if (!N) {
      $('h-file').removeAttribute('accept');
      if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
    }
    drawHome();
    if (N && N.ready) N.ready();
  }
  init();
})();
