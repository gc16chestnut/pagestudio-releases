// Page Studio — Handwriting: writes a text box's text in a person's own handwriting.
//
// How it works (the approach of "My Text in Your Handwriting", Haines et al., UCL 2016, done for boxed sample sheets):
//  • A handwriting profile holds real letters cut from the person's scanned sheets — several of each letter, letter
//    PAIRS written together, common whole words, and measurements of how they space words and drift off the line.
//  • Each letter is stored as a signed-distance image, so it stays crisp at any size and the pen can be made
//    thinner or thicker.
//  • Writing a word: the first letter is chosen from samples written before the next letter; every following letter
//    is taken from a sample of the actual pair (the "h" from a written "th"), placed at the distance the person
//    really left between those two letters, measured along the letter outlines. Joined pairs keep their joining stroke.
//  • Variety: samples are picked at random (never the same one twice running), baselines drift and wander the way
//    the person's lines do, and each line tilts a little. A seed makes it repeatable; "Do Again" picks a new seed,
//    and mail merge gives every recipient their own.
'use strict';
(function () {
  const HW = (window.HW = {});
  HW.FORMAT = 'pagestudio-handwriting';
  HW.VERSION = 1;
  HW.MAX_PROFILES = 5;
  HW.XH_RATIO = 0.5;              // handwriting x-height for a given font size (like a typical typeface)
  HW.ROWS = 18;                    // outline rows for spacing, from 2.4 x-heights above the baseline to 1.2 below
  HW.ROW_TOP = -2.4; HW.ROW_H = 0.2;
  HW.COLORS = [
    { id: 'black', label: 'Black', color: '#1e1e22' },
    { id: 'blue', label: 'Blue', color: '#1f3d96' },
    { id: 'red', label: 'Red', color: '#b5161e' },
    { id: 'green', label: 'Green', color: '#17683a' },
  ];
  HW.WEIGHTS = [
    { id: 'thin', label: 'Thin', shift: -0.03 },
    { id: 'normal', label: 'Normal', shift: 0 },
    { id: 'thick', label: 'Thick', shift: 0.05 },
  ];
  HW.STYLES = [
    { id: 'neat', label: 'Neater', k: 0.55 },
    { id: 'natural', label: 'Natural', k: 1 },
    { id: 'loose', label: 'Looser', k: 1.6 },
  ];
  HW.colorOf = (id) => (HW.COLORS.find(c => c.id === id) || (/^#/.test(id || '') ? { color: id } : HW.COLORS[1])).color;
  const weightOf = (id) => (HW.WEIGHTS.find(w => w.id === id) || HW.WEIGHTS[1]).shift;
  const styleOf = (id) => (HW.STYLES.find(s => s.id === id) || HW.STYLES[1]).k;

  // ------------------------------------------------------------------ random numbers (repeatable)
  HW.hash = (str) => {
    let h = 0x811c9dc5;
    str = String(str);
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return h >>> 0;
  };
  function rngFrom(seed) {
    let a = seed >>> 0;
    const next = () => {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    let spare = null;
    next.gauss = () => {
      if (spare != null) { const s = spare; spare = null; return s; }
      let u = 0, v = 0;
      while (u < 1e-9) u = next();
      v = next();
      const r = Math.sqrt(-2 * Math.log(u));
      spare = r * Math.sin(2 * Math.PI * v);
      return r * Math.cos(2 * Math.PI * v);
    };
    next.pick = (arr) => arr[Math.floor(next() * arr.length) % arr.length];
    return next;
  }
  HW.rng = rngFrom;
  /** A key for a mail-merge record, so each recipient's handwriting is different but always the same for them. */
  HW.recordKey = (rec) => {
    if (!rec) return '';
    const keys = Object.keys(rec).filter(k => !['page number', 'page count'].includes(k)).sort();
    return keys.length ? String(HW.hash(keys.map(k => k + '=' + rec[k]).join('\u0001'))) : '';
  };

  // ------------------------------------------------------------------ profiles
  HW.installed = new Map();          // id -> profile (set by the Options code from the app's handwriting folder)
  const decoded = new Map();         // id|updated -> decoded profile
  const decoding = new Map();

  /** The profile for an id: the one installed on this computer, else the copy saved inside the document. */
  HW.profileFor = (doc, id) => {
    if (!id) return null;
    const inst = HW.installed.get(id);
    const emb = doc && doc.hands && doc.hands[id];
    if (inst && emb) return (emb.updated || '') > (inst.updated || '') ? emb : inst;
    return inst || emb || null;
  };
  const keyOf = (p) => p.id + '|' + (p.updated || '');

  function loadImage(url) {
    return new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => rej(new Error('bad atlas')); im.src = url; });
  }
  const unpackRow = (a) => {
    const out = new Float32Array(HW.ROWS);
    for (let i = 0; i < HW.ROWS; i++) out[i] = (a && a[i] != null) ? a[i] / 1000 : NaN;
    return out;
  };

  /** Turn a stored profile into ready-to-draw letters. */
  HW.decode = (p) => {
    const k = keyOf(p);
    if (decoded.has(k)) return Promise.resolve(decoded.get(k));
    if (decoding.has(k)) return decoding.get(k);
    const job = (async () => {
      const atlases = [];
      for (const url of p.atlases || []) {
        const im = await loadImage(url);
        const c = document.createElement('canvas');
        c.width = im.naturalWidth; c.height = im.naturalHeight;
        const cx = c.getContext('2d', { willReadFrequently: true });
        cx.drawImage(im, 0, 0);
        const d = cx.getImageData(0, 0, c.width, c.height).data;
        const v = new Uint8Array(c.width * c.height);
        for (let i = 0, j = 0; j < v.length; i += 4, j++) v[j] = d[i];
        atlases.push({ w: c.width, h: c.height, v });
      }
      const D = HW.unpack(p, atlases);
      decoded.set(k, D);
      decoding.delete(k);
      return D;
    })();
    decoding.set(k, job);
    return job;
  };
  /** Build the lookup tables from a profile (atlases already decoded). Also used while a profile is being made. */
  HW.unpack = (p, atlases) => {
    const glyphs = (p.glyphs || []).map((r, i) => ({
      i, ch: r[0], src: r[1], prev: r[2] || null, next: r[3] || null,
      a: r[4], ax: r[5], ay: r[6], w: r[7], h: r[8], ox: r[9] / 100, oy: r[10] / 100,
      adv: r[11] / 1000, L: unpackRow(r[12]), R: unpackRow(r[13]), top: r[14] / 1000, bot: r[15] / 1000,
      flags: r[16] || 0, k: r[17] ? r[17] / 1000 : 1,
    }));
    const byChar = new Map(), units = new Map(), pairs = new Map(), sigs = new Map();
    for (const g of glyphs) {
      if (g.flags & 4) continue;                 // left out by the person
      if (g.src === 'U') { if (!units.has(g.ch)) units.set(g.ch, []); units.get(g.ch).push(g); continue; }
      if (g.src === 'G') { const t = sigKey(g.ch); if (!sigs.has(t)) sigs.set(t, []); sigs.get(t).push(g); continue; }
      if (!byChar.has(g.ch)) byChar.set(g.ch, []);
      byChar.get(g.ch).push(g);
    }
    for (const [pair, list] of Object.entries(p.pairs || {})) {
      const ok = list.map(s => ({ l: glyphs[s[0]], r: glyphs[s[1]], gap: s[2] / 1000, joined: !!s[3] }))
        .filter(s => s.l && s.r && !(s.l.flags & 4) && !(s.r.flags & 4));
      if (ok.length) pairs.set(pair, ok);
    }
    const st = Object.assign({ wordGap: [0.95], letterGap: [0.12], slope: [0, 0.6], wander: 0.05, baseJit: 0.04, sizeJit: 0.03, rot: 0.9 }, p.stats || {});
    if (!st.wordGap || !st.wordGap.length) st.wordGap = [0.95];
    if (!st.letterGap || !st.letterGap.length) st.letterGap = [0.12];
    // Signatures: the text that is replaced by the signature (as the person typed it in Options), longest first
    const sigTexts = [...sigs.keys()].sort((a, b) => b.length - a.length);
    return { p, S: p.S || 40, R: p.R || 4, atlases, glyphs, byChar, units, pairs, sigs, sigTexts, stats: st };
  };
  /** How signature text is matched: spaces and capitals don't matter, the words do. */
  const sigKey = (t) => String(t || '').replace(/\s+/g, ' ').trim().toLowerCase();
  HW.sigKey = sigKey;
  HW.isReady = (p) => !!(p && decoded.has(keyOf(p)));
  HW.decodedOf = (p) => (p ? decoded.get(keyOf(p)) || null : null);
  HW.forget = (p) => { if (p) decoded.delete(keyOf(p)); };

  /** Make sure every handwriting a document uses is ready to draw (call before printing). */
  HW.prepare = async (doc) => {
    const ids = HW.idsInDoc(doc);
    for (const id of ids) {
      const p = HW.profileFor(doc, id);
      if (p) { try { await HW.decode(p); } catch (e) { console.error(e); } }
    }
    return true;
  };
  HW.idsInDoc = (doc) => {
    const ids = new Set();
    const scan = (objs) => (objs || []).forEach(o => { if (o && o.hw && o.hw.hand) ids.add(o.hw.hand); });
    if (!doc) return ids;
    scan(doc.master && doc.master.objects); scan(doc.scratch && doc.scratch.objects);
    (doc.pages || []).forEach(pg => scan(pg.objects));
    return ids;
  };

  // ------------------------------------------------------------------ letters
  const LETTERLIKE = /[\p{L}\p{N}]/u;
  /** Letters without their accents (é → e) when the person didn't write the accented letter. */
  const plain = (ch) => ch.normalize('NFD').replace(/[̀-ͯ]/g, '');
  const ALIASES = { '‘': "'", '’': "'", '“': '"', '”': '"', '–': '-', '—': '-', '…': '.', ' ': ' ', '‐': '-', '‑': '-' };
  const normCh = (ch) => ALIASES[ch] || ch;

  function glyphsFor(D, ch) {
    let list = D.byChar.get(ch);
    if (list && list.length) return list;
    const p = plain(ch);
    if (p !== ch && (list = D.byChar.get(p)) && list.length) return list;
    // A capital that was never written falls back to the small letter written a bit bigger (and the other way)
    const other = ch === ch.toUpperCase() ? ch.toLowerCase() : ch.toUpperCase();
    if (other !== ch && (list = D.byChar.get(other)) && list.length) return list.map(g => Object.assign({}, g, { caseSwap: ch === ch.toUpperCase() ? 1.35 : 0.8 }));
    return null;
  }

  /**
   * Choose which written sample of a letter to use, preferring ones written next to the same neighbours.
   * recent: Map(glyphIndex -> how many letters ago it was used) to avoid repeats.
   */
  function chooseGlyph(D, ch, prev, next, rng, recent, initial) {
    const list = glyphsFor(D, ch);
    if (!list) return null;
    let total = 0;
    const w = list.map(g => {
      let k = 1;
      if (prev && g.prev === prev) k *= 4;
      if (next && g.next === next) k *= 3;
      if (initial && !g.prev && (g.src === 'W' || g.src === 'P' || g.src === 'L')) k *= 1.8;
      // A word doesn't start with a joining stroke from a letter that isn't there
      if (initial && (g.flags & 2)) k *= 0.12;
      // …and a letter written last in its box has its end stroke; one cut from a word doesn't
      if (next && !g.next) k *= 0.6;
      if (!initial && g.src === 'S') k *= 0.7;
      const r = recent.get(g.i);
      if (r != null) k *= r < 4 ? 0.06 : r < 12 ? 0.3 : 0.7;
      // A little randomness on top (like the Gumbel noise in the UCL method)
      k *= 0.55 + rng() * 0.9;
      total += k;
      return k;
    });
    let t = rng() * total;
    for (let i = 0; i < list.length; i++) { t -= w[i]; if (t <= 0) return list[i]; }
    return list[list.length - 1];
  }
  function choosePair(D, a, b, rng, recent) {
    const list = D.pairs.get(a + b);
    if (!list || !list.length) return null;
    let total = 0;
    const w = list.map(s => {
      let k = 1;
      const r = recent.get(s.r.i);
      if (r != null) k *= r < 4 ? 0.05 : r < 12 ? 0.3 : 0.7;
      k *= 0.55 + rng() * 0.9;
      total += k;
      return k;
    });
    let t = rng() * total;
    for (let i = 0; i < list.length; i++) { t -= w[i]; if (t <= 0) return list[i]; }
    return list[list.length - 1];
  }
  const sample = (arr, rng) => arr[Math.floor(rng() * arr.length) % arr.length];

  /**
   * The gap between two placed letters, measured along their outlines (in x-heights of the left letter).
   * Returns how far right letter B (origin at xb) must sit from A (origin xa) so the closest approach equals gap.
   */
  function placeAfter(A, sA, xA, B, sB, gap) {
    // Rows in absolute units, using the left letter's size (letters in a word are nearly always the same size)
    let best = Infinity, found = false;
    for (let r = 0; r < HW.ROWS; r++) {
      const ra = A.R[r], lb = B.L[r];
      if (Number.isNaN(ra) || Number.isNaN(lb)) continue;
      // xB + lb*sB - (xA + ra*sA) = gap*sA  → xB = xA + ra*sA + gap*sA - lb*sB
      const need = xA + ra * sA + gap * sA - lb * sB;
      if (!found || need > best) { best = need; found = true; }
    }
    if (found) return best;
    return xA + A.adv * sA + gap * sA;
  }

  // ------------------------------------------------------------------ text → lines of words
  function paragraphsOf(o, html, D) {
    const paras = PS.htmlToParagraphs(Object.assign({}, o, { html }));
    const base = (o.font && o.font.size) || 12;
    const shrink = o.shrinkScale && o.shrinkScale !== 1 ? o.shrinkScale : 1;
    return paras.map(p => {
      const chars = [];
      let inField = false;
      for (const r of p.runs) {
        let text = r.text;
        if (r.allCaps) text = text.toUpperCase();
        const size = (r.size || base) * shrink;
        for (const raw of Array.from(text)) {
          // A «merge field» not filled in yet is written as its name, marked with a dotted line (on screen only)
          if (raw === '\u00ab') { inField = true; continue; }
          if (raw === '\u00bb' && inField) { inField = false; continue; }
          const ch = normCh(raw);
          chars.push({ ch, size, script: r.script || null, underline: !!r.underline, strike: !!r.strike, bold: !!r.bold, field: inField });
        }
      }
      if (D && D.sigTexts && D.sigTexts.length) markSignatures(D, chars);
      return { align: p.align, spaceBefore: (p.spaceBefore || 0) * shrink, spaceAfter: (p.spaceAfter || 0) * shrink, leftIndent: p.leftIndent || 0, rightIndent: p.rightIndent || 0, firstIndent: p.firstIndent || 0, chars };
    });
  }
  /** Text that is one of the person's signatures (as typed in Options) is marked so it's drawn as the signature. */
  function markSignatures(D, chars) {
    const plain = chars.map(c => (c.ch.length === 1 ? c.ch : '?')).join('');
    const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    for (const key of D.sigTexts) {
      const re = new RegExp('(?<![\\p{L}\\p{N}])' + key.split(' ').map(esc).join('\\s+') + '(?![\\p{L}\\p{N}])', 'giu');
      let m;
      while ((m = re.exec(plain))) {
        const a = m.index, b = a + m[0].length;
        if (chars.slice(a, b).some(c => c.sig || c.sigCont)) continue;
        chars[a].sig = key;
        for (let k = a + 1; k < b; k++) chars[k].sigCont = true;
      }
    }
  }
  function wordsOf(chars) {
    // Split into words (letters and the punctuation stuck to them), spaces, tabs and line breaks
    const out = [];
    let cur = null;
    for (const c of chars) {
      if (c.sig) { if (cur) out.push(cur); cur = { chars: [c], sig: c.sig }; continue; }
      if (c.sigCont && cur && cur.sig) { cur.chars.push(c); continue; }
      if (cur && cur.sig) { out.push(cur); cur = null; }
      if (c.ch === ' ' || c.ch === '\t' || c.ch === '\u000b' || c.ch === '\n') {
        if (cur) { out.push(cur); cur = null; }
        out.push({ space: c.ch === ' ' ? 'space' : c.ch === '\t' ? 'tab' : 'break', size: c.size });
        continue;
      }
      if (!cur) cur = { chars: [] };
      cur.chars.push(c);
    }
    if (cur) out.push(cur);
    return out;
  }

  // ------------------------------------------------------------------ writing one word
  function layoutWord(D, word, rng, ctx) {
    const chars = word.chars;
    const items = [];       // { g, x, y, s, rot, ink } in pt, relative to the word's start, baseline 0
    const missing = [];
    const vk = ctx.vk;
    const st = D.stats;
    const text = chars.map(c => c.ch).join('');
    // A signature: drawn whole
    if (word.sig && D.sigs.has(word.sig)) {
      const list = D.sigs.get(word.sig);
      const fresh = list.filter(g => !ctx.recent.has(g.i));
      const g = sample(fresh.length ? fresh : list, rng);
      const c = chars[0];
      const s = c.size * HW.XH_RATIO;
      items.push({ g, x: 0, y: rng.gauss() * 0.03 * s, s, rot: rng.gauss() * 0.4 * Math.PI / 180, c, sig: true });
      ctx.recent.set(g.i, 0);
      return { items, width: g.adv * s, missing };
    }
    // Whole words the person wrote (the most natural of all), when the word matches exactly
    const m = text.match(/^(["'(]*)(.*?)([.,;:!?"')]*)$/);
    const core = m ? m[2] : text;
    let start = 0, x = 0, prev = null;
    const xhOf = (c) => c.size * HW.XH_RATIO * (c.script ? 0.62 : 1);
    const lift = (c) => (c.script === 'super' ? -c.size * HW.XH_RATIO * 0.75 : c.script === 'sub' ? c.size * HW.XH_RATIO * 0.3 : 0);
    const pushItem = (g, c, sx, xh, extra) => {
      const s = xh * (1 + rng.gauss() * st.sizeJit * vk) * (g.caseSwap || 1);
      const rot = rng.gauss() * (st.rot || 0.9) * vk * Math.PI / 180;
      const it = Object.assign({ g, x: sx, y: lift(c) + rng.gauss() * st.baseJit * xh * vk, s, rot, c }, extra || {});
      items.push(it);
      ctx.recent.forEach((v, k) => ctx.recent.set(k, v + 1));
      ctx.recent.set(g.i, 0);
      if (ctx.recent.size > 60) { for (const [k, v] of ctx.recent) if (v > 40) ctx.recent.delete(k); }
      return it;
    };
    if (core && D.units.has(core) && !chars.slice(m[1].length, m[1].length + core.length).some(c => c.script)) {
      const used = ctx.unitUse.get(core) || 0;
      const list = D.units.get(core);
      // Use the written word whenever there's a sample of it not used yet in this text. When every sample has been
      // used, about half the time (the same word written identically over and over would look stamped).
      const fresh = list.filter(g => !ctx.unitGlyphs.has(g.i));
      const p = fresh.length ? 0.96 : 0.5;
      if (rng() < p) {
        // Leading punctuation first
        for (let i = 0; i < m[1].length; i++) {
          const c = chars[i];
          const g = chooseGlyph(D, c.ch, prev && prev.c.ch, null, rng, ctx.recent, i === 0);
          if (!g) { missing.push(c.ch); continue; }
          const xh = xhOf(c);
          const sx = prev ? placeAfter(prev.g, prev.s, prev.x, g, xh, sampleGap(D, prev.c.ch, c.ch, rng, vk)) : 0;
          prev = pushItem(g, c, sx, xh);
        }
        const c0 = chars[m[1].length];
        const g = sample(fresh.length ? fresh : list.filter(q => q.i !== ctx.unitLast.get(core)).concat(list.length === 1 ? list : []), rng);
        ctx.unitGlyphs.add(g.i);
        ctx.unitLast.set(core, g.i);
        const xh = xhOf(c0);
        const sx = prev ? placeAfter(prev.g, prev.s, prev.x, g, xh, sampleGap(D, prev.c.ch, core[0], rng, vk)) : 0;
        const it = pushItem(g, c0, sx, xh, { unit: core });
        it.c = Object.assign({}, c0, { ch: core[core.length - 1] });
        prev = it;
        ctx.unitUse.set(core, used + 1);
        start = m[1].length + core.length;
      }
    }
    // Joined writing: a letter followed by a letter it joins to is taken from a written pair where the join was cut
    // off and given to the next letter; the next letter then comes from the same pair, so the join is the one really
    // written (otherwise the end stroke of one letter and the joining stroke of the next would both be drawn).
    let held = null;
    for (let i = start; i < chars.length; i++) {
      const c = chars[i];
      const xh = xhOf(c);
      const nx = i + 1 < chars.length ? chars[i + 1] : null;
      const nextCh = nx ? nx.ch : null;
      let g = null, gap = null;
      const joinsNext = nx && !c.script === !nx.script && joinedPair(D, c.ch, nx.ch);
      const fromHeld = held && held.r.ch === c.ch ? held : null;
      held = null;
      if (fromHeld) {
        gap = fromHeld.gap + rng.gauss() * 0.03 * vk;
        if (fromHeld.joined) gap = Math.min(gap, fromHeld.gap + 0.02);
        g = fromHeld.r;
      }
      if (joinsNext) {
        const sN = choosePair(D, c.ch, nx.ch, rng, ctx.recent);
        if (sN) { g = sN.l; held = sN; }
      }
      if (!g || (gap == null && prev && !c.script === !prev.c.script)) {
        const s = prev && !c.script === !prev.c.script ? choosePair(D, prev.c.ch, c.ch, rng, ctx.recent) : null;
        if (s) {
          if (!g) g = s.r;
          gap = s.gap + rng.gauss() * 0.035 * vk;
          // Keep what makes a joined pair joined
          if (s.joined) gap = Math.min(gap, s.gap + 0.02);
        }
      }
      if (!g) g = chooseGlyph(D, c.ch, prev ? prev.c.ch : null, nextCh, rng, ctx.recent, !prev);
      if (!g) {
        missing.push(c.ch);
        // Not in the samples: write it with a handwriting-style font so nothing disappears
        const sx = prev ? prev.x + prev.g.adv * prev.s + 0.15 * xh : 0;
        const it = { font: true, ch: c.ch, x: sx, y: lift(c), s: xh, c, adv: 0.62 * (c.ch === c.ch.toUpperCase() && LETTERLIKE.test(c.ch) ? 1.4 : 1) };
        it.g = { adv: it.adv, R: new Float32Array(HW.ROWS).fill(NaN), L: new Float32Array(HW.ROWS).fill(NaN), i: -1 };
        items.push(it);
        prev = it;
        continue;
      }
      if (gap == null) gap = prev ? sampleGap(D, prev.c.ch, c.ch, rng, vk) : 0;
      const sx = prev ? placeAfter(prev.g, prev.s, prev.x, g, xh, gap) : 0;
      prev = pushItem(g, c, sx, xh);
    }
    // Width of the word (the right edge of its last letter)
    let width = 0;
    for (const it of items) width = Math.max(width, it.x + (it.g.adv || 0) * it.s);
    return { items, width, missing };
  }
  /** Did this person join these two letters when writing them as a pair (most of the time)? */
  function joinedPair(D, a, b) {
    const list = D.pairs.get(a + b);
    if (!list || !list.length) return false;
    let j = 0;
    for (const s of list) if (s.joined) j++;
    return j * 2 >= list.length;
  }
  /** Spacing between two letters that weren't written as a pair: the person's usual spacing for similar letters. */
  function sampleGap(D, a, b, rng, vk) {
    if (/[.,;:!?'")\]]/.test(b)) return 0.06 + rng() * 0.06;
    if (/["'(\[]/.test(a)) return 0.04 + rng() * 0.05;
    // Pairs that start with the same letter, or end with the same letter, say most about this person's spacing
    const pool = [];
    for (const [k, list] of D.pairs) if (k[0] === a || k[1] === b) for (const s of list) pool.push(s.gap);
    const src = pool.length >= 3 ? pool : D.stats.letterGap;
    return sample(src, rng) + rng.gauss() * 0.04 * vk;
  }

  // ------------------------------------------------------------------ the whole text box
  /**
   * Lay out a text object's text in a handwriting. Result positions are in points from the box's top-left.
   * o: the text object (html, w, h, padding, font, lineHeight, valign); hw: { hand, seed, color, weight, style }
   */
  HW.layout = (D, o, html, hw, variant) => (hw && hw.fit ? fitLayout(D, o, html, hw, variant) : layoutOnce(D, o, html, hw, variant));
  /**
   * "Fit to box": the biggest writing that fits the text box, whatever the font size. Like Publisher's Best Fit:
   * the words wrap as usual and the size is found by trying sizes (each try is the same handwriting, just bigger
   * or smaller).
   */
  function fitLayout(D, o, html, hw, variant) {
    const pad = o.padding || [0, 0, 0, 0];
    // Tall capitals and loops above the first line count too (the writing is moved down to make room for them)
    const fits = (L) => L.bottom + Math.max(0, pad[0] - L.top) <= o.h - pad[2] + 0.2 && L.right <= o.w - pad[1] + 0.5;
    const at = (z) => layoutOnce(D, Object.assign({}, o, { shrinkScale: (o.shrinkScale || 1) * z }), html, hw, variant);
    let lo = 0.15, hi = 12, best = null;
    const L1 = at(1);
    if (fits(L1)) { best = L1; lo = 1; } else hi = 1;
    for (let k = 0; k < 9; k++) {
      const z = Math.sqrt(lo * hi);
      const L = at(z);
      if (fits(L)) { best = L; lo = z; } else hi = z;
      if (hi / lo < 1.03) break;
    }
    if (!best) best = at(lo);
    const down = Math.max(0, pad[0] - best.top);
    if (down && o.valign !== 'bottom' && o.valign !== 'middle') {
      for (const g of best.glyphs) g.y += down;
      for (const f of best.fonts) f.y += down;
      for (const st of best.strokes) st.pts.forEach(p => { p[1] += down; });
      best.top += down; best.bottom += down;
    }
    best.fitScale = lo;
    best.overflow = false;
    return best;
  }
  function layoutOnce(D, o, html, hw, variant) {
    const rng = rngFrom(HW.hash((hw.seed || 1) + ':' + (variant || '')));
    const vk = styleOf(hw.style);
    const st = D.stats;
    const pad = o.padding || [0, 0, 0, 0];
    const boxW = Math.max(10, o.w - pad[1] - pad[3]);
    const paras = paragraphsOf(o, html, D);
    const ctx = { recent: new Map(), unitUse: new Map(), unitGlyphs: new Set(), unitLast: new Map(), vk };
    const lines = [];
    const missing = new Set();
    let y = 0;
    const baseSize = (o.font && o.font.size) || 12;
    const lh = Math.max(1.12, o.lineHeight || 1.15);
    let firstLine = true;
    for (const para of paras) {
      if (!firstLine) y += para.spaceBefore;
      const tokens = wordsOf(para.chars);
      const words = [];
      // Each word is written once; wrapping only moves whole words
      for (const t of tokens) {
        if (t.space) { words.push(t); continue; }
        const lw = layoutWord(D, t, rng, ctx);
        lw.missing.forEach(ch => missing.add(ch));
        words.push(Object.assign(t, lw));
      }
      const paraSize = para.chars.length ? Math.max(...para.chars.map(c => c.size)) : baseSize * (o.shrinkScale || 1);
      // Handwriting needs a little more room between lines than type (tall loops and tails)
      const pitchOf = (size) => size * lh * 1.25 * (1 + rng.gauss() * 0.012 * vk);
      const avail = (first) => boxW - para.leftIndent - para.rightIndent - (first ? para.firstIndent : 0);
      let line = null;
      const newLine = (first) => {
        line = { words: [], width: 0, first, size: paraSize, align: para.align, indent: para.leftIndent + (first ? para.firstIndent : 0), avail: avail(first) };
        lines.push(line);
      };
      newLine(true);
      let pendingGap = 0;
      for (const w of words) {
        if (w.space) {
          if (w.space === 'break') { newLine(false); pendingGap = 0; continue; }
          const xh = (w.size || paraSize) * HW.XH_RATIO;
          pendingGap += w.space === 'tab' ? 3.5 * xh : xh * Math.max(0.55, sample(st.wordGap, rng) + rng.gauss() * 0.08 * vk);
          continue;
        }
        const gapNow = line.words.length ? pendingGap : 0;
        if (line.words.length && line.width + gapNow + w.width > line.avail + 0.5) {
          newLine(false);
          line.words.push({ w, x: 0 });
          line.width = w.width;
        } else {
          line.words.push({ w, x: line.width + gapNow });
          line.width += gapNow + w.width;
        }
        line.size = Math.max(line.size, ...w.items.map(it => it.c.size || paraSize));
        pendingGap = 0;
      }
      // Line positions: the tilt and wander of the person's lines
      for (const ln of lines) {
        if (ln.y != null) continue;
        const pitch = pitchOf(ln.size || paraSize);
        if (firstLine) { y += ln.size * 0.92; firstLine = false; }
        else y += pitch;
        ln.y = y;
        const xh = (ln.size || paraSize) * HW.XH_RATIO;
        const slopeDeg = (st.slope[0] || 0) + rng.gauss() * (st.slope[1] || 0.6) * vk;
        // A line can't wander into the next one
        const maxRise = pitch * 0.22;
        ln.slope = PS.clamp(Math.tan(slopeDeg * Math.PI / 180), -maxRise / Math.max(30, ln.width), maxRise / Math.max(30, ln.width));
        ln.wander = { a: (st.wander || 0.05) * xh * vk, p1: rng() * 6.28, p2: rng() * 6.28, l1: xh * (7 + rng() * 5), l2: xh * (2.5 + rng() * 2) };
        ln.margin = ln.align === 'left' || ln.align === 'justify' ? Math.abs(rng.gauss()) * 0.12 * xh * vk : 0;
      }
      y += para.spaceAfter;
    }
    // Place every letter
    const glyphs = [], strokes = [], fonts = [];
    let maxY = 0, minY = Infinity;
    for (const ln of lines) {
      let x0 = pad[3] + ln.indent + ln.margin;
      if (ln.align === 'center') x0 = pad[3] + ln.indent + (ln.avail - ln.width) / 2;
      else if (ln.align === 'right') x0 = pad[3] + ln.indent + ln.avail - ln.width - Math.abs(rng.gauss()) * 1.5;
      const baseAt = (x) => ln.y + ln.slope * (x - x0) + ln.wander.a * (Math.sin((x - x0) / ln.wander.l1 * 6.28 + ln.wander.p1) * 0.7 + Math.sin((x - x0) / ln.wander.l2 * 6.28 + ln.wander.p2) * 0.3);
      for (const { w, x } of ln.words) {
        const wx = x0 + x;
        let ulStart = null, ulEnd = null, ulSize = 12, stStart = null, stEnd = null;
        for (const it of w.items) {
          const gx = wx + it.x;
          const gy = baseAt(gx) + it.y;
          if (it.font) fonts.push({ ch: it.ch, x: gx, y: gy, size: it.s / HW.XH_RATIO });
          else glyphs.push({ g: it.g, x: gx, y: gy, s: it.s, rot: it.rot, alpha: 0.9 + rng() * 0.1 });
          const right = gx + (it.g.adv || 0) * it.s;
          if (it.c.underline || it.c.field) { ulStart = ulStart == null ? gx : ulStart; ulEnd = right; ulSize = it.c.size; }
          if (it.c.strike) { stStart = stStart == null ? gx : stStart; stEnd = right; }
          const top = gy + (it.g.top != null && !it.font ? it.g.top * it.s : -1.6 * it.s);
          const bot = gy + (it.g.bot != null && !it.font ? it.g.bot * it.s : 0.5 * it.s);
          minY = Math.min(minY, top); maxY = Math.max(maxY, bot);
        }
        const xh = ulSize * HW.XH_RATIO;
        if (ulStart != null) strokes.push(penLine(rng, ulStart - 0.1 * xh, ulEnd + 0.15 * xh, (x) => baseAt(x) + 0.32 * xh, xh, w.items.some(it => it.c.field) && !w.items.some(it => it.c.underline) ? 'field' : 'ink'));
        if (stStart != null) strokes.push(penLine(rng, stStart - 0.05 * xh, stEnd + 0.05 * xh, (x) => baseAt(x) - 0.5 * xh, xh, 'ink'));
      }
    }
    if (!lines.length) minY = 0;
    // Vertical alignment in the box
    const contentH = (lines.length ? (lines[lines.length - 1].y + (lines[lines.length - 1].size || baseSize) * 0.4) : 0);
    const availH = o.h - pad[0] - pad[2];
    let dy = pad[0];
    if (o.valign === 'middle') dy = pad[0] + Math.max(0, (availH - contentH) / 2);
    else if (o.valign === 'bottom') dy = pad[0] + Math.max(0, availH - contentH);
    for (const g of glyphs) g.y += dy;
    for (const f of fonts) f.y += dy;
    for (const s of strokes) s.pts.forEach(p => { p[1] += dy; });
    let right = 0;
    for (const g of glyphs) right = Math.max(right, g.x + (g.g.adv || 0) * g.s);
    for (const f of fonts) right = Math.max(right, f.x + f.size * 0.6);
    return { glyphs, strokes, fonts, missing: [...missing], overflow: maxY + dy > o.h + 0.5, top: minY + dy, bottom: maxY + dy, right, lines: lines.length };
  }
  /** A hand-drawn line (underlines, strike-through): slightly curved, never perfectly straight. */
  function penLine(rng, x1, x2, yAt, xh, kind) {
    const n = Math.max(4, Math.round((x2 - x1) / (xh * 0.8)));
    const bow = rng.gauss() * 0.06 * xh, tilt = rng.gauss() * 0.04 * xh;
    const pts = [];
    for (let i = 0; i <= n; i++) {
      const t = i / n, x = x1 + (x2 - x1) * t;
      pts.push([x, yAt(x) + Math.sin(t * Math.PI) * bow + (t - 0.5) * tilt + rng.gauss() * 0.01 * xh]);
    }
    return { pts, width: xh * 0.085, kind };
  }

  // ------------------------------------------------------------------ drawing
  /**
   * Draw a layout into a canvas. scale: canvas pixels per point. Region (pt) lets print draw only the inked part.
   * Returns the canvas.
   */
  HW.paint = (D, L, hw, scale, region, canvas) => {
    const rx = region.x, ry = region.y;
    const W = Math.max(1, Math.ceil(region.w * scale)), H = Math.max(1, Math.ceil(region.h * scale));
    const c = canvas || document.createElement('canvas');
    if (c.width !== W) c.width = W;
    if (c.height !== H) c.height = H;
    const cx = c.getContext('2d');
    const acc = new Float32Array(W * H);
    const S = D.S, R = D.R;
    const shift = weightOf(hw.weight) * S;     // in stored pixels (x-height = S)
    for (const p of L.glyphs) {
      const g = p.g, A = D.atlases[g.a];
      if (!A) continue;
      const gk = g.k || 1;                        // a signature may be stored smaller than the letters
      const m = (p.s / (S * gk)) * scale;         // canvas px per stored px
      if (m <= 0) continue;
      const cos = Math.cos(p.rot), sin = Math.sin(p.rot);
      const X0 = (p.x - rx) * scale, Y0 = (p.y - ry) * scale;
      // Corners of the stored letter on the canvas
      let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
      for (const [u, v] of [[0, 0], [g.w, 0], [0, g.h], [g.w, g.h]]) {
        const du = u - g.ox, dv = v - g.oy;
        const X = X0 + m * (cos * du - sin * dv), Y = Y0 + m * (sin * du + cos * dv);
        minx = Math.min(minx, X); maxx = Math.max(maxx, X); miny = Math.min(miny, Y); maxy = Math.max(maxy, Y);
      }
      const xa = Math.max(0, Math.floor(minx)), xb = Math.min(W - 1, Math.ceil(maxx));
      const ya = Math.max(0, Math.floor(miny)), yb = Math.min(H - 1, Math.ceil(maxy));
      if (xa > xb || ya > yb) continue;
      const v = A.v, aw = A.w;
      const inv = 1 / m, k = (R / 127);
      const alphaMul = p.alpha;
      for (let Y = ya; Y <= yb; Y++) {
        const yy = Y + 0.5 - Y0;
        for (let X = xa; X <= xb; X++) {
          const xx = X + 0.5 - X0;
          const u = (xx * cos + yy * sin) * inv + g.ox - 0.5;
          const w = (-xx * sin + yy * cos) * inv + g.oy - 0.5;
          if (u < -1 || w < -1 || u > g.w || w > g.h) continue;
          const iu = Math.floor(u), iw = Math.floor(w);
          const fu = u - iu, fw = w - iw;
          const s00 = sdfAt(v, aw, g, iu, iw), s10 = sdfAt(v, aw, g, iu + 1, iw);
          const s01 = sdfAt(v, aw, g, iu, iw + 1), s11 = sdfAt(v, aw, g, iu + 1, iw + 1);
          const sv = (s00 * (1 - fu) + s10 * fu) * (1 - fw) + (s01 * (1 - fu) + s11 * fu) * fw;
          const d = (sv - 128) * k + shift * gk;  // stored px; positive inside the ink
          let a = 0.5 + d * m;
          if (a <= 0) continue;
          if (a > 1) a = 1;
          a *= alphaMul;
          const idx = Y * W + X;
          if (a > acc[idx]) acc[idx] = a;
        }
      }
    }
    // Ink: a slight unevenness, like a ballpoint
    const col = hexRgb(HW.colorOf(hw.color));
    const img = cx.createImageData(W, H);
    const out = img.data;
    const nrng = rngFrom(HW.hash('ink' + (hw.seed || 1)));
    const cell = Math.max(6, Math.round(6 * scale));
    const gw = Math.ceil(W / cell) + 2, gh = Math.ceil(H / cell) + 2;
    const grid = new Float32Array(gw * gh);
    for (let i = 0; i < grid.length; i++) grid[i] = 0.9 + nrng() * 0.1;
    for (let Y = 0; Y < H; Y++) {
      const gy = Y / cell, iy = Math.floor(gy), fy = gy - iy;
      for (let X = 0; X < W; X++) {
        const a = acc[Y * W + X];
        if (!a) continue;
        const gx = X / cell, ix = Math.floor(gx), fx = gx - ix;
        const n = (grid[iy * gw + ix] * (1 - fx) + grid[iy * gw + ix + 1] * fx) * (1 - fy) + (grid[(iy + 1) * gw + ix] * (1 - fx) + grid[(iy + 1) * gw + ix + 1] * fx) * fy;
        const o = (Y * W + X) * 4;
        out[o] = col[0]; out[o + 1] = col[1]; out[o + 2] = col[2];
        out[o + 3] = Math.round(255 * Math.min(1, a * n));
      }
    }
    cx.putImageData(img, 0, 0);
    // Underlines and strike-throughs, drawn as pen lines
    cx.save();
    cx.translate(-rx * scale, -ry * scale);
    cx.lineCap = 'round'; cx.lineJoin = 'round';
    const wk = 1 + weightOf(hw.weight) * 6;
    for (const s of L.strokes) {
      cx.strokeStyle = s.kind === 'field' ? 'rgba(120,120,120,.55)' : HW.colorOf(hw.color);
      cx.lineWidth = s.width * scale * wk;
      if (s.kind === 'field') cx.setLineDash([3 * scale, 2 * scale]); else cx.setLineDash([]);
      cx.beginPath();
      s.pts.forEach(([x, y], i) => { if (i) cx.lineTo(x * scale, y * scale); else cx.moveTo(x * scale, y * scale); });
      cx.stroke();
    }
    // Characters the person never wrote: a handwriting-style font, so the text is still all there
    if (L.fonts.length) {
      cx.fillStyle = HW.colorOf(hw.color);
      for (const f of L.fonts) {
        cx.font = `${f.size * scale}px "Segoe Print", "Ink Free", "Bradley Hand", cursive`;
        cx.fillText(f.ch, f.x * scale, f.y * scale);
      }
    }
    cx.restore();
    return c;
  };
  function sdfAt(v, aw, g, u, w) {
    if (u < 0 || w < 0 || u >= g.w || w >= g.h) return 0;
    return v[(g.ay + w) * aw + g.ax + u];
  }
  function hexRgb(hex) {
    const m = String(hex || '#000').replace('#', '');
    const n = m.length === 3 ? m.split('').map(c => c + c).join('') : m;
    return [parseInt(n.slice(0, 2), 16) || 0, parseInt(n.slice(2, 4), 16) || 0, parseInt(n.slice(4, 6), 16) || 0];
  }

  // ------------------------------------------------------------------ in the page
  const layoutCache = new Map();
  const LCACHE_MAX = 300;
  /** The layout for an object (cached: the same text and settings always give the same handwriting). */
  HW.layoutFor = (doc, o, html, variant) => {
    const p = HW.profileFor(doc, o.hw.hand);
    const D = HW.decodedOf(p);
    if (!D) return null;
    const key = [keyOf(p), html, o.w, o.h, JSON.stringify(o.padding), JSON.stringify(o.font), o.lineHeight, o.valign, o.shrinkScale || 1,
      o.hw.seed, o.hw.style, o.hw.fit ? 'fit' : '', variant || ''].join('\u0001');
    let L = layoutCache.get(key);
    if (!L) {
      L = HW.layout(D, o, html, o.hw, variant);
      layoutCache.set(key, L);
      if (layoutCache.size > LCACHE_MAX) layoutCache.delete(layoutCache.keys().next().value);
    }
    return { D, L };
  };
  HW.outputScale = null;         // set by the print view: canvas pixels per point
  HW.screenScale = () => {
    const z = (window.App && App.zoom) || 1;
    return PS.clamp(PS.PX_PER_PT * z * (window.devicePixelRatio || 1), 1.2, 8);
  };
  const pending = new Set();
  const paintCache = new Map();
  let paintSeq = 0;
  /**
   * Called by PS.renderObject for a text box (or shape) with handwriting: hides the typed text and draws the
   * handwriting over it. While the box is being edited the typed text shows instead.
   */
  HW.decorate = (el, o, opts) => {
    const content = el.querySelector('.ps-text-content');
    if (!content) return;
    el.classList.add('ps-hw');
    if (opts.editable && opts.mergeSkip === o.id) { el.classList.add('ps-hw-editing'); return; }
    const doc = opts.doc;
    const p = HW.profileFor(doc, o.hw.hand);
    if (!p) { el.classList.add('ps-hw-missing'); el.title = 'This handwriting isn’t on this computer'; return; }
    content.style.opacity = '0';
    const holder = document.createElement('div');
    holder.className = 'ps-hw-ink';
    holder.style.cssText = 'position:absolute;inset:0;pointer-events:none;overflow:hidden;';
    el.appendChild(holder);
    const html = o.__hwHtml != null ? o.__hwHtml : o.html;
    const variant = o.__hwVariant || '';
    const draw = () => {
      const r = HW.layoutFor(doc, o, html, variant);
      if (!r) return false;
      const { D, L } = r;
      el.classList.toggle('ps-hw-overflow', !!L.overflow);
      if (L.missing.length) el.dataset.hwMissing = L.missing.join('');
      const print = HW.outputScale != null;
      const scale = print ? HW.outputScale : HW.screenScale();
      // Print draws only the part with ink (smaller pictures); the screen draws the whole box
      let region = { x: 0, y: 0, w: o.w, h: o.h };
      if (print && L.glyphs.length) {
        let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
        for (const g of L.glyphs) {
          const ext = Math.max(g.g.w, g.g.h) / D.S * g.s;
          x1 = Math.min(x1, g.x - ext * 0.3); x2 = Math.max(x2, g.x + ext * 1.1);
          y1 = Math.min(y1, g.y - ext); y2 = Math.max(y2, g.y + ext * 0.6);
        }
        for (const s of L.strokes) for (const [x, y] of s.pts) { x1 = Math.min(x1, x - 2); x2 = Math.max(x2, x + 2); y1 = Math.min(y1, y - 2); y2 = Math.max(y2, y + 2); }
        if (L.fonts.length) { x1 = 0; y1 = 0; x2 = o.w; y2 = o.h; }
        x1 = Math.max(0, x1); y1 = Math.max(0, y1); x2 = Math.min(o.w, x2); y2 = Math.min(o.h, y2);
        if (x2 > x1 && y2 > y1) region = { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
      }
      let cv;
      const pk = print ? null : [L.__id || (L.__id = ++paintSeq), scale, o.hw.color, o.hw.weight, o.hw.seed].join('|');
      const hit = pk && paintCache.get(pk);
      if (hit) {
        cv = document.createElement('canvas');
        cv.width = hit.width; cv.height = hit.height;
        cv.getContext('2d').drawImage(hit, 0, 0);
      } else {
        cv = HW.paint(D, L, o.hw, scale, region);
        if (pk) {
          const keep = document.createElement('canvas');
          keep.width = cv.width; keep.height = cv.height;
          keep.getContext('2d').drawImage(cv, 0, 0);
          paintCache.set(pk, keep);
          if (paintCache.size > 40) paintCache.delete(paintCache.keys().next().value);
        }
      }
      let node = cv;
      if (print) {
        // Pictures instead of canvases keep long merges from running out of memory
        const img = document.createElement('img');
        img.src = cv.toDataURL('image/png');
        node = img;
        cv.width = cv.height = 0;
      }
      Object.assign(node.style, { position: 'absolute', left: region.x + 'pt', top: region.y + 'pt', width: region.w + 'pt', height: region.h + 'pt' });
      node.dataset.hwScale = String(scale);
      holder.replaceChildren(node);
      return true;
    };
    if (!draw()) {
      // Not decoded yet (first use in this window): draw as soon as it is
      const k = keyOf(p);
      HW.decode(p).then(() => {
        if (!el.isConnected) { if (!pending.has(k)) { pending.add(k); setTimeout(() => { pending.delete(k); if (window.App && App.render) App.render(); }, 0); } return; }
        draw();
      }).catch(e => console.error(e));
    }
  };
  /** After zooming, redraw the handwriting sharp at the new size. */
  HW.refreshScreen = (root) => {
    const s = HW.screenScale();
    root = root || document;
    let stale = false;
    root.querySelectorAll('.ps-hw-ink canvas').forEach(c => { if (Math.abs((+c.dataset.hwScale || 0) - s) / s > 0.2) stale = true; });
    return stale;
  };
  HW.overflows = (doc, o) => {
    if (!o.hw) return false;
    const r = HW.layoutFor(doc, o, o.html, '');
    return !!(r && r.L.overflow);
  };
  /** Preview a few words in a profile (for menus and the Options page). Returns a canvas. */
  HW.preview = (D, text, { size = 18, width = 260, height = 44, color = 'blue', weight = 'normal', seed = 7, style = 'natural', scale = 2 } = {}) => {
    const o = { w: width, h: height, padding: [2, 4, 2, 4], font: { size }, lineHeight: 1.15, valign: 'middle', html: '<p>' + PS.escapeHtml(text) + '</p>' };
    const hw = { seed, color, weight, style };
    const L = HW.layout(D, o, o.html, hw, '');
    const c = HW.paint(D, L, hw, scale, { x: 0, y: 0, w: width, h: height });
    c.style.width = width + 'pt'; c.style.height = height + 'pt';
    return c;
  };
})();
