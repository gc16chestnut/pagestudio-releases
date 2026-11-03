// Page Studio — picture and shape effects, picture adjustments and gradient fills.
// Loaded by the editor and by the print/PDF window, so what you see is what prints.
//
// o.effects = { shadow, glow, softEdge, reflection, bevel, rotate3d }   (any object but lines)
// o.adjust  = { brightness, contrast, sharpness, saturation, temperature, transparency, recolor }   (pictures)
// o.fillGradient = { type: 'linear' | 'radial', angle, stops: [[0..1, '#hex', opacity]] }   (shapes, text boxes)
'use strict';
(function () {
  const FX = (window.PSFX = {});
  const n = (v, d = 0) => (typeof v === 'number' && isFinite(v) ? v : d);
  const sid = (o, k) => 'fx' + k + String(o.id).replace(/[^a-z0-9]/gi, '');
  const hexRgb = (hex) => {
    const m = String(hex || '#000').replace('#', '');
    const v = m.length === 3 ? m.split('').map(c => c + c).join('') : m.padEnd(6, '0');
    return [parseInt(v.slice(0, 2), 16) || 0, parseInt(v.slice(2, 4), 16) || 0, parseInt(v.slice(4, 6), 16) || 0];
  };
  const rgba = (hex, a) => { const [r, g, b] = hexRgb(hex); return `rgba(${r}, ${g}, ${b}, ${a})`; };
  FX.hexRgb = hexRgb;

  // ------------------------------------------------------------------ picture adjustments (SVG filter on the picture)
  const isAdjusted = (a) => a && (n(a.brightness) || n(a.contrast) || n(a.sharpness) || (a.saturation != null && a.saturation !== 100) ||
    (a.temperature && a.temperature !== 6500) || a.recolor);
  FX.isAdjusted = isAdjusted;

  /** Colour temperature (K) as RGB multipliers relative to daylight (6500 K). */
  function tempGain(k) {
    const t = PS.clamp(k || 6500, 1500, 15000) / 100;
    const f = (t) => {
      let r, g, b;
      if (t <= 66) { r = 255; g = 99.47 * Math.log(t) - 161.12; b = t <= 19 ? 0 : 138.52 * Math.log(t - 10) - 305.04; }
      else { r = 329.7 * Math.pow(t - 60, -0.1332); g = 288.12 * Math.pow(t - 60, -0.0755); b = 255; }
      return [r, g, b].map(v => PS.clamp(v, 0, 255));
    };
    const c = f(t), d = f(65);
    return c.map((v, i) => v / d[i]);
  }

  /** SVG <filter> markup for a picture's adjustments, or '' when there are none. */
  FX.adjustFilterSvg = (o, id) => {
    const a = o.adjust;
    if (!isAdjusted(a)) return '';
    const parts = [];
    const b = n(a.brightness) / 100, c = n(a.contrast) / 100;
    // Recolor first works on the picture's own colors
    if (a.recolor) {
      const rc = a.recolor;
      if (rc.kind === 'gray' || rc.kind === 'bw' || rc.kind === 'dark' || rc.kind === 'light') {
        parts.push('<feColorMatrix type="saturate" values="0"/>');
      }
      if (rc.kind === 'duo') {
        // Publisher's Recolor: grey = Rec.709 luminance, then black -> the chosen colour, white -> white (validated against Publisher's own export, mean error ~1.5/255)
        const [r0, g0, b0] = hexRgb(rc.color || '#003300').map(v => v / 255);
        const row = (c) => `${PS.round((1 - c) * 0.2126, 4)} ${PS.round((1 - c) * 0.7152, 4)} ${PS.round((1 - c) * 0.0722, 4)} 0 ${PS.round(c, 4)}`;
        parts.push(`<feColorMatrix type="matrix" values="${row(r0)}  ${row(g0)}  ${row(b0)}  0 0 0 1 0"/>`);
      }
      if (rc.kind === 'duo' && rc.washout) parts.push('<feComponentTransfer><feFuncR type="linear" slope="0.35" intercept="0.65"/><feFuncG type="linear" slope="0.35" intercept="0.65"/><feFuncB type="linear" slope="0.35" intercept="0.65"/></feComponentTransfer>');
      if (rc.kind === 'sepia') parts.push('<feColorMatrix type="matrix" values="0.393 0.769 0.189 0 0  0.349 0.686 0.168 0 0  0.272 0.534 0.131 0 0  0 0 0 1 0"/>');
      if (rc.kind === 'washout') parts.push('<feComponentTransfer><feFuncR type="linear" slope="0.35" intercept="0.62"/><feFuncG type="linear" slope="0.35" intercept="0.62"/><feFuncB type="linear" slope="0.35" intercept="0.62"/></feComponentTransfer>');
      if (rc.kind === 'bw') {
        const th = PS.clamp(n(rc.level, 50), 1, 99) / 100;
        const steps = 20, tv = Array.from({ length: steps }, (_, i) => ((i + 0.5) / steps >= th ? 1 : 0)).join(' ');
        parts.push(`<feComponentTransfer><feFuncR type="discrete" tableValues="${tv}"/><feFuncG type="discrete" tableValues="${tv}"/><feFuncB type="discrete" tableValues="${tv}"/></feComponentTransfer>`);
      }
      if (rc.kind === 'dark' || rc.kind === 'light') {
        // Duotone: shadows go to the color (dark) or the color goes to white (light)
        const [r, g, bb] = hexRgb(rc.color || '#4f3420').map(v => v / 255);
        const tab = (v) => (rc.kind === 'dark' ? `0 ${PS.round(v, 3)} ${PS.round(Math.min(1, v + 0.5), 3)}` : `${PS.round(v, 3)} ${PS.round(v + (1 - v) * 0.6, 3)} 1`);
        parts.push(`<feComponentTransfer><feFuncR type="table" tableValues="${tab(r)}"/><feFuncG type="table" tableValues="${tab(g)}"/><feFuncB type="table" tableValues="${tab(bb)}"/></feComponentTransfer>`);
      }
    }
    if (a.saturation != null && a.saturation !== 100) parts.push(`<feColorMatrix type="saturate" values="${PS.round(a.saturation / 100, 3)}"/>`);
    if (a.temperature && a.temperature !== 6500) {
      const [r, g, bl] = tempGain(a.temperature);
      parts.push(`<feColorMatrix type="matrix" values="${PS.round(r, 3)} 0 0 0 0  0 ${PS.round(g, 3)} 0 0 0  0 0 ${PS.round(bl, 3)} 0 0  0 0 0 1 0"/>`);
    }
    if (b || c) {
      // Contrast around middle grey, then brightness, like Office's Brightness/Contrast
      const slope = c >= 0 ? 1 + c * 2 : 1 + c;
      const intercept = 0.5 - 0.5 * slope + b * 0.6;
      const f = `type="linear" slope="${PS.round(slope, 3)}" intercept="${PS.round(intercept, 3)}"`;
      parts.push(`<feComponentTransfer><feFuncR ${f}/><feFuncG ${f}/><feFuncB ${f}/></feComponentTransfer>`);
    }
    const s = n(a.sharpness) / 100;
    if (s > 0) {
      const k = PS.round(s * 1.5, 3), ctr = PS.round(1 + 4 * k, 3);
      parts.push(`<feConvolveMatrix order="3" preserveAlpha="true" kernelMatrix="0 ${-k} 0 ${-k} ${ctr} ${-k} 0 ${-k} 0"/>`);
    } else if (s < 0) {
      parts.push(`<feGaussianBlur stdDeviation="${PS.round(-s * 3, 2)}"/>`);
    }
    return `<filter id="${id}" color-interpolation-filters="sRGB" x="0" y="0" width="100%" height="100%">${parts.join('')}</filter>`;
  };

  // ------------------------------------------------------------------ shape and picture effects
  const hasEffects = (e) => e && (e.shadow || e.glow || n(e.softEdge) > 0 || e.reflection || e.bevel || e.rotate3d);
  FX.hasEffects = hasEffects;

  const BEVELS = {
    circle: { blur: 2.2, scale: 4, exp: 18 }, relaxed: { blur: 3.5, scale: 3, exp: 14 }, cross: { blur: 1.2, scale: 5, exp: 25 },
    cool: { blur: 1.6, scale: 6, exp: 30 }, angle: { blur: 0.8, scale: 6, exp: 22 }, soft: { blur: 5, scale: 2.5, exp: 10 },
    divot: { blur: 2.5, scale: -4, exp: 16 }, riblet: { blur: 1, scale: 3, exp: 30 }, hard: { blur: 0.6, scale: 8, exp: 28 }, art: { blur: 3, scale: 5, exp: 20 },
  };
  FX.BEVELS = BEVELS;
  const bevelSvg = (id, bv) => {
    const p = BEVELS[bv.kind] || BEVELS.circle;
    const size = n(bv.size, 6) / 6;
    return `<filter id="${id}" x="-5%" y="-5%" width="110%" height="110%">
      <feGaussianBlur in="SourceAlpha" stdDeviation="${PS.round(p.blur * size, 2)}" result="b"/>
      <feSpecularLighting in="b" surfaceScale="${p.scale}" specularConstant="0.9" specularExponent="${p.exp}" lighting-color="#ffffff" result="s"><feDistantLight azimuth="225" elevation="40"/></feSpecularLighting>
      <feComposite in="s" in2="SourceAlpha" operator="in" result="so"/>
      <feDiffuseLighting in="b" surfaceScale="${p.scale}" diffuseConstant="1" lighting-color="#ffffff" result="d"><feDistantLight azimuth="225" elevation="50"/></feDiffuseLighting>
      <feComposite in="d" in2="SourceAlpha" operator="in" result="do"/>
      <feComposite in="SourceGraphic" in2="do" operator="arithmetic" k1="0.85" k2="0.25" k3="0" k4="0" result="lit"/>
      <feComposite in="lit" in2="so" operator="arithmetic" k1="0" k2="1" k3="0.8" k4="0"/>
    </filter>`;
  };

  /** CSS for a soft-edge mask (rectangles, rounded rectangles or ovals). */
  const softMask = (o, pt) => {
    if (o.frame === 'ellipse' || o.kind === 'ellipse') return `radial-gradient(closest-side, #000 calc(100% - ${pt * 1.33}pt), transparent 100%)`;
    return `linear-gradient(to right, transparent, #000 ${pt}pt, #000 calc(100% - ${pt}pt), transparent), linear-gradient(to bottom, transparent, #000 ${pt}pt, #000 calc(100% - ${pt}pt), transparent)`;
  };

  /** Add effects to an object's rendered element (called by PS.renderObject). */
  FX.apply = (el, o) => {
    if (!el || o.type === 'line') return el;
    const defs = [];
    const filters = [];
    // Picture adjustments go on the picture itself
    if (o.type === 'image') {
      const img = el.querySelector('img');
      const a = o.adjust;
      if (img && isAdjusted(a)) {
        const id = sid(o, 'a');
        defs.push(FX.adjustFilterSvg(o, id));
        img.style.filter = `url(#${id})`;
      }
      if (img && a && n(a.transparency) > 0) img.style.opacity = String(PS.round(1 - a.transparency / 100, 3));
    }
    const e = o.effects;
    if (hasEffects(e)) {
      if (e.bevel) { const id = sid(o, 'b'); defs.push(bevelSvg(id, e.bevel)); filters.push(`url(#${id})`); }
      if (e.glow) {
        const g = e.glow, size = n(g.size, 8);
        filters.push(`drop-shadow(0 0 ${PS.round(size * 0.5, 2)}pt ${rgba(g.color || '#c39a4a', n(g.opacity, 0.6))})`);
        filters.push(`drop-shadow(0 0 ${PS.round(size * 0.25, 2)}pt ${rgba(g.color || '#c39a4a', n(g.opacity, 0.6))})`);
      }
      if (e.shadow) {
        const s = e.shadow;
        if (s.inner) {
          // Inner shadow: an inset shadow over the content
          const ov = document.createElement('div');
          ov.className = 'ps-fx-inner';
          Object.assign(ov.style, { position: 'absolute', inset: '0', pointerEvents: 'none', borderRadius: o.frame === 'ellipse' || o.kind === 'ellipse' ? '50%' : (o.radius || 0) + 'pt',
            boxShadow: `inset ${n(s.x, 3)}pt ${n(s.y, 3)}pt ${n(s.blur, 6)}pt ${rgba(s.color || '#000000', n(s.opacity, 0.45))}` });
          el.append(ov);
        } else {
          filters.push(`drop-shadow(${n(s.x, 3)}pt ${n(s.y, 3)}pt ${n(s.blur, 4)}pt ${rgba(s.color || '#000000', n(s.opacity, 0.4))})`);
        }
      }
      if (n(e.softEdge) > 0) {
        const target = el.querySelector('.ps-img-wrap') || el.querySelector('svg') || el;
        const m = softMask(o, n(e.softEdge));
        target.style.maskImage = m; target.style.webkitMaskImage = m;
        target.style.maskComposite = 'intersect'; target.style.webkitMaskComposite = 'source-in';
      }
      if (e.reflection) {
        const r = e.reflection;
        el.style.webkitBoxReflect = `below ${n(r.distance, 0)}pt linear-gradient(to bottom, rgba(0, 0, 0, ${n(r.opacity, 0.5)}), transparent ${PS.clamp(n(r.size, 50), 5, 100)}%)`;
      }
      if (e.rotate3d) {
        const t = e.rotate3d;
        const base = el.style.transform || '';
        el.style.transform = `${base} perspective(${n(t.perspective, 900)}px) rotateX(${n(t.x)}deg) rotateY(${n(t.y)}deg) rotateZ(${n(t.z)}deg)`.trim();
      }
    }
    if (filters.length) el.style.filter = filters.join(' ');
    if (defs.length) {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('width', '0'); svg.setAttribute('height', '0');
      svg.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden';
      svg.innerHTML = `<defs>${defs.join('')}</defs>`;
      el.prepend(svg);
    }
    return el;
  };

  // ------------------------------------------------------------------ gradient and picture fills
  /** SVG paint for a shape: returns { defs, fill } where fill is a color or url(#id). */
  FX.shapePaint = (o, doc) => {
    if (o.fillImage && o.fillTile && doc && doc.assets && doc.assets[o.fillImage]) {
      const id = sid(o, 'p');
      return { defs: `<pattern id="${id}" patternUnits="userSpaceOnUse" width="${PS.round(o.fillTile.w, 2)}" height="${PS.round(o.fillTile.h, 2)}"><image href="${PS.assetUrl(doc, o.fillImage)}" width="${PS.round(o.fillTile.w, 2)}" height="${PS.round(o.fillTile.h, 2)}" preserveAspectRatio="none"/></pattern>`, fill: `url(#${id})` };
    }
    if (o.fillImage && doc && doc.assets && doc.assets[o.fillImage]) {
      const id = sid(o, 'p');
      return { defs: `<pattern id="${id}" patternContentUnits="objectBoundingBox" width="1" height="1"><image href="${PS.assetUrl(doc, o.fillImage)}" width="1" height="1" preserveAspectRatio="xMidYMid slice"/></pattern>`, fill: `url(#${id})` };
    }
    const g = o.fillGradient;
    if (!g || !g.stops || g.stops.length < 2) return { defs: '', fill: o.fill || 'none' };
    const id = sid(o, 'g');
    const stops = g.stops.map(([p, c, a]) => `<stop offset="${PS.round(p, 4)}" stop-color="${c}" stop-opacity="${a == null ? 1 : a}"/>`).join('');
    if (g.type === 'radial') return { defs: `<radialGradient id="${id}" cx="${n(g.cx, 0.5)}" cy="${n(g.cy, 0.5)}" r="0.7">${stops}</radialGradient>`, fill: `url(#${id})` };
    return { defs: `<linearGradient id="${id}" gradientTransform="rotate(${n(g.angle, 90)} 0.5 0.5)">${stops}</linearGradient>`, fill: `url(#${id})` };
  };
  /** CSS background for a gradient-filled text box. */
  FX.cssGradient = (g) => {
    if (!g || !g.stops || g.stops.length < 2) return null;
    const st = g.stops.map(([p, c, a]) => `${a == null || a >= 1 ? c : rgba(c, a)} ${PS.round(p * 100, 2)}%`).join(', ');
    return g.type === 'radial' ? `radial-gradient(circle at ${n(g.cx, 0.5) * 100}% ${n(g.cy, 0.5) * 100}%, ${st})` : `linear-gradient(${n(g.angle, 90) + 90}deg, ${st})`;
  };

  // ------------------------------------------------------------------ what Publisher can't keep
  /** Names of features in a document that a .pub file can't store as they are. */
  FX.unsupportedInPub = (doc) => {
    const found = new Set();
    const lists = [doc.master.objects, doc.scratch.objects, ...doc.pages.map(p => p.objects)];
    for (const list of lists) for (const o of list) {
      const e = o.effects || {};
      if (e.glow) found.add('glow');
      if (e.reflection) found.add('reflections');
      if (n(e.softEdge) > 0) found.add('soft edges');
      if (e.bevel) found.add('bevels');
      if (e.rotate3d) found.add('3-D rotation');
      if (e.shadow && o.type === 'image') found.add('picture shadows');
      if (o.type === 'image' && isAdjusted(o.adjust)) found.add('picture corrections and recoloring');
      if (o.type === 'image' && o.artistic) found.add('artistic effects');
      if (o.type === 'image' && o.cutAsset) found.add('removed backgrounds');
      if (o.type === 'image' && o.adjust && n(o.adjust.transparency) > 0) found.add('picture transparency');
      if (o.fillGradient) found.add('gradient fills');
      if (o.fillImage) found.add('picture fills');
      if (o.textFit === 'grow') found.add('“grow text box to fit”');
      if (o.textDirection === 'vertical') found.add('vertical text');
      if (o.html && /background-color/.test(o.html)) found.add('text highlighting');
      if (o.html && /text-shadow|-webkit-text-stroke|font-feature-settings|font-variant-ligatures|font-variant-numeric/.test(o.html)) found.add('WordArt text effects and typography');
    }
    return [...found];
  };
  /** Does this object need to go into a .pub file as a picture to keep its look? */
  FX.needsFlatten = (o) => {
    if (o.type === 'line') return false;
    const e = o.effects || {};
    if (e.glow || e.reflection || n(e.softEdge) > 0 || e.bevel || e.rotate3d) return true;
    if (o.type === 'image' && e.shadow) return true;
    if (o.type === 'shape' && (o.fillGradient || o.fillImage)) return true;
    return false;
  };
})();
