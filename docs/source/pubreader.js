// PageStudio — native reader for Microsoft Publisher (.pub) files, Publisher 2002 and later
// (which covers Publisher 2003 through 2019/2021/365).
// The .pub format is undocumented; the structure here follows the reverse-engineering done by
// the LibreOffice project's libmspub, re-implemented in JavaScript.
/*! PageStudio .pub reader (based on libmspub's reverse-engineering). This Source Code Form is subject to the terms of the
 *  Mozilla Public License, v. 2.0. If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *  Source: https://gc16chestnut.github.io/pagestudio-releases/source/pubreader.js */
//
// Output matches what the Publisher bridge produces, so the rest of PageStudio can use it:
// { pageWidth, pageHeight, master:[], scratch:[], pages:[{objects, background, useMaster}], skipped }
// with images returned separately as { name: { mime, data(Buffer), kind } }.
'use strict';

const zlib = require('zlib');
const { readCFB } = require('./cfb');

const EMU = 914400;
const emuToPt = (v) => (v / EMU) * 72;

// ------------------------------------------------------------------ byte stream
class Stream {
  constructor(buf) { this.b = buf; this.p = 0; }
  get len() { return this.b.length; }
  tell() { return this.p; }
  seek(p) { this.p = p; }
  eof() { return this.p >= this.b.length; }
  u8() { if (this.p + 1 > this.b.length) { this.p = this.b.length + 1; return 0; } return this.b[this.p++]; }
  u16() { if (this.p + 2 > this.b.length) { this.p = this.b.length + 1; return 0; } const v = this.b.readUInt16LE(this.p); this.p += 2; return v; }
  u32() { if (this.p + 4 > this.b.length) { this.p = this.b.length + 1; return 0; } const v = this.b.readUInt32LE(this.p); this.p += 4; return v; }
  i32() { if (this.p + 4 > this.b.length) { this.p = this.b.length + 1; return 0; } const v = this.b.readInt32LE(this.p); this.p += 4; return v; }
  bytes(n) { const s = this.b.subarray(this.p, Math.min(this.b.length, this.p + n)); this.p += n; return s; }
  still(until) { return this.p < this.b.length && this.p < until; }
}

// ------------------------------------------------------------------ Contents-stream blocks
const GENERAL_CONTAINER = 0x88, STRING_CONTAINER = 0xc0, DUMMY = 0x78, TRAILER_DIRECTORY = 0x90, SHAPE_SEQNUM = 0x70;

function blockDataLength(type) {
  switch (type) {
    case DUMMY: case 0x5: case 0x8: case 0xa: return 0;
    case 0x10: case 0x12: case 0x18: case 0x1a: case 0x07: return 2;
    case 0x20: case 0x22: case 0x58: case 0x68: case 0x70: case 0xb8: return 4;
    case 0x28: return 8;
    case 0x38: return 16;
    case 0x48: return 24;
    case STRING_CONTAINER: case 0x80: case 0x82: case GENERAL_CONTAINER: case 0x8a: case 0x90: case 0x98: case 0xa0: return -1;
    default: return 0;
  }
}
function parseBlock(s, skipHier) {
  const info = { start: s.tell(), id: s.u8(), type: s.u8(), dataOffset: 0, dataLength: 0, data: 0, stringData: null };
  info.dataOffset = s.tell();
  const len = blockDataLength(info.type);
  if (len < 0) {
    info.dataLength = s.u32();
    if (info.type === STRING_CONTAINER) info.stringData = s.bytes(Math.max(0, info.dataLength - 4));
    else if (skipHier) s.seek(info.dataOffset + info.dataLength);
  } else {
    info.dataLength = len;
    if (len === 2) info.data = s.u16();
    else if (len === 4) info.data = s.u32();
    else if (len > 0) s.seek(info.dataOffset + len);
  }
  return info;
}
const skipBlock = (s, info) => s.seek(info.dataOffset + info.dataLength);

// ------------------------------------------------------------------ Escher (Office Art) records
const ESCHER = {
  DGG: 0xF000, BSTORE: 0xF001, DG: 0xF002, SPGR: 0xF003, SP: 0xF004, BSE: 0xF007,
  FSPGR: 0xF009, FSP: 0xF00A, FOPT: 0xF00B, CHILD_ANCHOR: 0xF00F, CLIENT_ANCHOR: 0xF010, CLIENT_DATA: 0xF011,
  TERTIARY_FOPT: 0xF122,
  BLIP_EMF: 0xF01A, BLIP_WMF: 0xF01B, BLIP_PICT: 0xF01C, BLIP_JPEG: 0xF01D, BLIP_PNG: 0xF01E, BLIP_DIB: 0xF01F,
  BLIP_TIFF: 0xF029, BLIP_JPEGCMYK: 0xF02A,
};
const tailLen = (type) => (type === ESCHER.DGG || type === ESCHER.DG ? 4 : 0);
const extraHeader = (type) => (type === ESCHER.CLIENT_ANCHOR || type === ESCHER.CLIENT_DATA ? 4 : 0);

function escherRec(s) {
  const initial = s.u16(), type = s.u16(), len = s.u32();
  return { initial, type, len, off: s.tell() };
}
function findEscher(s, parentEnd, types) {
  const set = Array.isArray(types) ? types : [types];
  while (s.still(parentEnd)) {
    const r = escherRec(s);
    if (set.includes(r.type)) return r;
    s.seek(r.off + r.len + tailLen(r.type));
  }
  return null;
}
function escherValues(s, rec) {
  const out = new Map();
  s.seek(rec.off + extraHeader(rec.type));
  const end = rec.off + rec.len;
  while (s.still(end)) {
    const id = s.u16();
    if (id === 0 && !s.still(end)) break;
    out.set(id, s.u32());
  }
  return out;
}
function foptValues(s, rec) {
  const scalars = new Map(), complex = new Map();
  s.seek(rec.off);
  const n = rec.initial >> 4;
  const end = rec.off + rec.len;
  const complexIds = [];
  for (let i = 0; i < n && s.still(end); i++) {
    const id = s.u16(), v = s.u32();
    scalars.set(id, v);
    if (id & 0x8000) complexIds.push(id);
  }
  for (const id of complexIds) {
    if (!s.still(end)) break;
    let length = scalars.get(id);
    if (!length) continue;
    if (id === 0xC145 || id === 0xC146) length += 6;   // IMsoArray: stated size excludes the 6-byte header
    const start = s.tell();
    s.bytes(length);
    complex.set(id, s.b.subarray(start, Math.min(s.b.length, start + length)));
  }
  return { scalars, complex };
}

// Escher custom geometry -> list of drawing commands in the shape's own coordinate space
function parsePath(v, vb, sb) {
  const n = vb.readUInt16LE(0), cb = vb.readUInt16LE(4);
  const pts = [];
  const sz = cb === 0xFFF0 ? 4 : cb;
  for (let i = 0; i < n && 6 + (i + 1) * sz <= vb.length; i++) {
    if (sz === 4) pts.push([vb.readInt16LE(6 + i * 4), vb.readInt16LE(8 + i * 4)]);
    else if (sz === 8) pts.push([vb.readInt32LE(6 + i * 8), vb.readInt32LE(10 + i * 8)]);
  }
  const m = sb.readUInt16LE(0);
  const segs = [];
  for (let i = 0; i < m && 6 + (i + 1) * 2 <= sb.length; i++) segs.push(sb.readUInt16LE(6 + i * 2));
  const gl = (v.get(0x140) | 0), gt = (v.get(0x141) | 0);
  const gr = v.has(0x142) ? (v.get(0x142) | 0) : 21600, gb = v.has(0x143) ? (v.get(0x143) | 0) : 21600;
  const cmds = []; let pi = 0, open = false;
  const P = () => pts[Math.min(pi++, pts.length - 1)] || [0, 0];
  for (const sg of segs) {
    const type = sg >> 13, count = sg & 0x1FFF;
    if (type === 2) { const p = P(); cmds.push(['M', p[0], p[1]]); open = true; }
    else if (type === 0) { for (let k = 0; k < count; k++) { const p = P(); cmds.push(['L', p[0], p[1]]); } }
    else if (type === 1) { for (let k = 0; k < count; k++) { const a = P(), b = P(), c = P(); cmds.push(['C', a[0], a[1], b[0], b[1], c[0], c[1]]); } }
    else if (type === 3) cmds.push(['Z']);
    else if (type === 4) break;
    else if (type === 5 || type === 6) { /* escapes: auto-line/curve, no-fill, no-line, … ignored for now */ }
  }
  return { w: gr - gl || 1, h: gb - gt || 1, ox: gl, oy: gt, cmds, nPts: pts.length };
}

// Field ids
const F = {
  XS: 0x2001, YS: 0x2002, XE: 0x2003, YE: 0x2004,
  PXID: 0x4104, SHAPE_ID: 0x6801,
  FILL_TYPE: 0x0180, FILL_COLOR: 0x0181, FILL_OPACITY: 0x0182, FILL_BACK_COLOR: 0x0183, FILL_STYLE_BOOL: 0x01BF,
  FILL_SHADE_COMPLEX: 0xC197,
  LINE_COLOR: 0x01C0, LINE_WIDTH: 0x01CB, LINE_DASHING: 0x01CE, LINE_STYLE_BOOL: 0x01FF, GEOM_BOOL: 0x017F,
  LINE_TOP_COLOR: 0x0580, LINE_TOP_WIDTH: 0x058B, LINE_TOP_BOOL: 0x05BF,
  LINE_RIGHT_COLOR: 0x05C0, LINE_RIGHT_WIDTH: 0x05CB, LINE_RIGHT_BOOL: 0x05FF,
  LINE_BOTTOM_COLOR: 0x0600, LINE_BOTTOM_WIDTH: 0x060B, LINE_BOTTOM_BOOL: 0x063F,
  LINE_LEFT_COLOR: 0x0540, LINE_LEFT_WIDTH: 0x054B, LINE_LEFT_BOOL: 0x057F,
  BEGIN_ARROW: 0x01D0, END_ARROW: 0x01D1,
  ADJUST1: 0x0147,
  ROTATION: 0x0004,
  TEXT_LEFT: 0x0081, TEXT_TOP: 0x0082, TEXT_RIGHT: 0x0083, TEXT_BOTTOM: 0x0084,
  NUM_COLUMNS: 0x008C, COLUMN_SPACING: 0x008D,
  CROP_TOP: 0x0100, CROP_BOTTOM: 0x0101, CROP_LEFT: 0x0102, CROP_RIGHT: 0x0103,
};
const FLAG_USE_LINE = 1 << 19, FLAG_LINE = 1 << 3, FLAG_GEOM_USE_LINE_OK = 1 << 12, FLAG_GEOM_LINE_OK = 1 << 28;
const SF_GROUP = 1, SF_FLIP_H = 1 << 6, SF_FLIP_V = 1 << 7;
const lineExists = (flags, geom) => flags != null &&
  !((flags & FLAG_USE_LINE) && !(flags & FLAG_LINE)) &&
  (geom == null || !(geom & FLAG_GEOM_USE_LINE_OK) || (geom & FLAG_GEOM_LINE_OK));
const fixed16 = (v) => (v | 0) / 65536;

// Escher shape types we map to PageStudio shapes
const SHAPE_KIND = { 1: 'rect', 2: 'roundrect', 3: 'ellipse', 4: 'diamond', 5: 'triangle', 9: 'hexagon', 10: 'octagon', 11: 'plus', 12: 'star5', 13: 'arrowRight', 56: 'pentagon', 66: 'arrowLeft', 74: 'heart' };
const LINE_TYPES = new Set([20, 32]);
const TEXT_TYPES = new Set([202, 1, 75]);

// ------------------------------------------------------------------ colors
function realColor(c, palette) {
  if (((c >>> 24) & 0xff) === 0x08) {
    const i = c & 0xffffff;
    return i < palette.length ? palette[i] : [0, 0, 0];
  }
  return [c & 0xff, (c >>> 8) & 0xff, (c >>> 16) & 0xff];
}
function finalColor(base, modified, palette) {
  if (((modified >>> 24) & 0xff) === 0x10) {
    const c = realColor(base, palette);
    const kind = (modified >>> 8) & 0xff;
    const intensity = ((modified >>> 16) & 0xff) / 255;
    if (kind === 1) return c.map(v => Math.round(v * intensity));
    if (kind === 2) return c.map(v => Math.round(v + (255 - v) * (1 - intensity)));
    return [0, 0, 0];
  }
  return realColor(modified, palette);
}
const hex = (rgb) => '#' + rgb.map(v => Math.max(0, Math.min(255, v | 0)).toString(16).padStart(2, '0')).join('');

// ------------------------------------------------------------------ main parse
function readPub(buffer) {
  const cfb = readCFB(buffer);
  const quillBuf = cfb.get('Quill/QuillSub/CONTENTS');
  const contentsBuf = cfb.get('Contents');
  const escherBuf = cfb.get('Escher/EscherStm');
  if (!quillBuf || !contentsBuf || !escherBuf || escherBuf.length === 0) {
    throw new Error('This Publisher file is from a very old version (Publisher 2000 or earlier), which PageStudio can’t read yet. Open and re-save it in a newer Publisher first.');
  }
  const delayBuf = cfb.get('Escher/EscherDelayStm') || Buffer.alloc(0);

  const st = {
    palette: [], textColors: [], fonts: [], defaultChar: [], defaultPara: [],
    texts: new Map(),          // textId -> paragraphs
    shapes: new Map(),         // seqNum -> info
    pages: new Map(),          // seqNum -> { shapes:[], bg, master, isMaster }
    pageOrder: [],
    width: 8.5, height: 11,
    topLevel: [],              // z-ordered elements: { seq } or { group:true, seq, children:[] }
    images: [],                // index (1-based) -> { mime, data, kind }
    bseImageIndex: [],         // pxId-1 -> image index
    warnings: [],
  };
  const shapeInfo = (seq) => { if (!st.shapes.has(seq)) st.shapes.set(seq, { seq }); return st.shapes.get(seq); };

  parseQuill(new Stream(quillBuf), st);
  parseContents(new Stream(contentsBuf), st, shapeInfo);
  if (escherBuf) parseEscher(new Stream(escherBuf), new Stream(delayBuf), st, shapeInfo);
  if (st.palette.length < 8) st.palette.unshift([0, 0, 0]);
  return assemble(st);
}

// ------------------------------------------------------------------ Quill (text) stream
function parseQuill(s, st) {
  const refs = [];
  let listOff = 0x18;
  const seen = new Set();
  while (listOff !== 0xffffffff && listOff < s.len) {
    s.seek(listOff + 2);
    const n = s.u16();
    const next = s.u32();
    for (let i = 0; i < n; i++) {
      s.u16();
      const name = s.bytes(4).toString('latin1');
      const id = s.u16();
      s.seek(s.tell() + 4);
      const name2 = s.bytes(4).toString('latin1');
      const offset = s.u32(), length = s.u32();
      refs.push({ name, id, name2, offset, length });
    }
    if (seen.has(next)) break;
    seen.add(next);
    listOff = next;
  }
  let textRef = null, textLengths = [], textIds = [], spans = [], paras = [], stshCount = 0;
  const tableCellEnds = new Map();
  for (const r of refs) {
    if (r.name === 'TEXT') textRef = r;
    else if (r.name === 'STRS') {
      s.seek(r.offset);
      const n = s.u32();
      s.seek(4 + r.offset + s.u32());
      for (let j = 0; j < n; j++) textLengths.push(s.u32());
    } else if (r.name === 'SYID') {
      s.seek(r.offset); s.u32();
      const n = s.u32();
      for (let j = 0; j < n; j++) textIds.push(s.u32());
    } else if (r.name === 'PL  ') {
      s.seek(r.offset);
      const n = s.u32();
      s.seek(s.tell() + 8);
      for (let i = 0; i < n && s.still(s.len); i++) {
        const begin = s.tell();
        const len = s.u32();
        while (s.still(begin + len)) {
          const b = parseBlock(s, true);
          if (b.id === 0x01) st.textColors.push(b.data);
        }
        s.seek(begin + len);
      }
    } else if (r.name === 'FDPC' || r.name === 'FDPP') {
      s.seek(r.offset);
      const n = s.u16();
      s.seek(s.tell() + 6);
      const textOffsets = [], chunkOffsets = [];
      for (let i = 0; i < n; i++) textOffsets.push(s.u32());
      for (let i = 0; i < n; i++) chunkOffsets.push(s.u16());
      for (let i = 0; i < n; i++) {
        s.seek(r.offset + chunkOffsets[i]);
        if (r.name === 'FDPC') spans.push({ last: textOffsets[i], style: charStyle(s) });
        else paras.push({ last: textOffsets[i], style: paraStyle(s) });
      }
    } else if (r.name === 'STSH') {
      if (stshCount++ === 1) {
        s.seek(r.offset);
        s.u32();
        const n = Math.min(s.u32(), 10000);
        s.seek(s.tell() + 12);
        const offsets = [];
        for (let i = 0; i < n; i++) offsets.push(s.u32());
        for (let i = 0; i < n; i++) {
          s.seek(r.offset + 20 + offsets[i]);
          s.u16();
          if (i % 2 === 0) st.defaultChar.push(charStyle(s)); else st.defaultPara.push(paraStyle(s));
        }
      }
    } else if (r.name === 'FONT') {
      s.seek(r.offset);
      s.u32();
      const n = s.u32();
      s.seek(s.tell() + 12 + 4 * n);
      for (let i = 0; i < n && s.still(s.len); i++) {
        const len = s.u16();
        if (len > 0) st.fonts.push(s.bytes(len * 2).toString('utf16le').replace(/\0+$/, ''));
        s.u32();
      }
    } else if (r.name === 'TCD ') {
      s.seek(r.offset);
      const n = s.u32() + 1;
      s.seek(r.offset + 0xC);
      const ends = [];
      for (let i = 0; i < n; i++) ends.push(s.u32() + (i !== n - 1 ? 2 : 0));
      tableCellEnds.set(r.id, ends);
    }
  }
  if (!textRef) return;
  // Walk the text, splitting into paragraphs and styled spans
  s.seek(textRef.offset);
  let bytesRead = 0, si = 0, pi = 0;
  for (let j = 0; j < textIds.length && j < textLengths.length; j++) {
    const readParas = [];
    let readSpans = [];
    let text = [];
    for (let k = 0; k < textLengths[j] && pi < paras.length && si < spans.length; k++) {
      text.push(s.u16());
      bytesRead += 2;
      if (bytesRead >= spans[si].last - textRef.offset) {
        if (text.length) readSpans.push({ chars: text, style: spans[si].style });
        si++;
        text = [];
      }
      if (pi < paras.length && bytesRead >= paras[pi].last - textRef.offset) {
        if (text.length && si < spans.length) readSpans.push({ chars: text, style: spans[si].style });
        text = [];
        if (readSpans.length) readParas.push({ spans: readSpans, style: paras[pi].style });
        pi++;
        readSpans = [];
      }
    }
    if (text.length && si < spans.length) readSpans.push({ chars: text, style: spans[si].style });
    if (readSpans.length && pi < paras.length) readParas.push({ spans: readSpans, style: paras[pi].style });
    st.texts.set(textIds[j], { paras: readParas, cellEnds: tableCellEnds.get(j) || null });
  }
}

function charStyle(s) {
  const style = {};
  const off = s.tell();
  const len = s.u32();
  while (s.still(off + len)) {
    const b = parseBlock(s, true);
    switch (b.id) {
      case 0x02: style.bold = true; break;
      case 0x03: style.italic = true; break;
      case 0x1E: style.underline = UNDERLINE[b.data & 0xff] || ((b.data & 0xff) ? 'single' : null); break;
      case 0x0C: style.size = b.data * 72 / EMU; break;
      case 0x2E: style.color = b.data; break;
      case 0x44: { // color index container
        s.seek(b.dataOffset + 4);
        while (s.still(b.dataOffset + b.dataLength)) {
          const sb = parseBlock(s, true);
          if (sb.id === 0x0) { style.color = sb.data; break; }
        }
        s.seek(b.dataOffset + b.dataLength);
        break;
      }
      case 0x24: { // font index container
        s.seek(b.dataOffset + 4);
        while (s.still(b.dataOffset + b.dataLength)) {
          const sb = parseBlock(s, true);
          if (sb.type === GENERAL_CONTAINER) {
            s.seek(sb.dataOffset + 4);
            if (s.still(sb.dataOffset + sb.dataLength)) style.font = parseBlock(s, true).data;
            break;
          }
        }
        s.seek(b.dataOffset + b.dataLength);
        break;
      }
      case 0x0F: style.superSub = b.data; break;
      case 0x13: style.smallCaps = true; break;
      case 0x14: style.allCaps = true; break;
      case 0x1F: style.tracking = b.data / 10; break;   // percent x10 (COM Font.Tracking; 1100 = 110%)
      case 0x20: style.scaling = b.data / 10; break;    // percent x10 (COM Font.Scaling; 1500 = 150%)
      default: break;
    }
  }
  return style;
}

function paraStyle(s) {
  const style = {};
  const off = s.tell();
  const len = s.u32();
  while (s.still(off + len)) {
    const b = parseBlock(s, true);
    switch (b.id) {
      case 0x04: style.align = b.data & 0xff; break;
      case 0x19: style.defaultCharStyle = b.data; break;
      case 0x34:
        if (b.data & 1) style.lineSpacingPt = (b.data - 1) / 8 * 72 / EMU;
        else if (b.data & 2) style.lineSpacingSp = (b.data - 2) / EMU * 72 / 96;
        break;
      case 0x12: style.spaceBefore = b.data; break;
      case 0x13: style.spaceAfter = b.data; break;
      case 0x0C: style.firstIndent = b.data | 0; break;
      case 0x0D: style.leftIndent = b.data; break;
      case 0x0E: style.rightIndent = b.data; break;
      case 0x57: { // bullets / numbering: three 32-bit props — 0 = kind (23 = bullet character, 0 = none), 1 = the character, 2 = unknown
        style.list = true;
        const raw = s.b.subarray(b.dataOffset, b.dataOffset + b.dataLength), L = {};
        for (let o2 = 4; o2 + 6 <= raw.length && raw[o2 + 1] === 0x22; o2 += 6) L['p' + raw[o2]] = raw.readUInt32LE(o2 + 2);
        style.listInfo = L; break;
      }
      case 0x58: style.listStart = b.data >>> 16; break;   // list start number in the high word (numbered lists)
      case 0x08: style.dropLines = b.data; break;
      case 0x2D: style.dropLetters = b.data; break;
      case 0x53: style.dropFont = b.data; break;
      case 0x32: { // tab stops
        const tabs = [];
        s.seek(b.dataOffset + 4);
        while (s.still(b.dataOffset + b.dataLength)) {
          const ta = parseBlock(s, true);
          if (ta.id === 0x28 && (ta.type === GENERAL_CONTAINER || ta.type === 0x8a)) {
            s.seek(ta.dataOffset + 4);
            while (s.still(ta.dataOffset + ta.dataLength)) {
              const te = parseBlock(s, true);
              if (te.type === GENERAL_CONTAINER) {
                s.seek(te.dataOffset + 4);
                const tabEntry = {};
                while (s.still(te.dataOffset + te.dataLength)) { const tb = parseBlock(s, true); tabEntry[tb.id] = tb.data; }
                if (tabEntry[0] != null) { tabs.push(tabEntry[0]); if (Object.keys(tabEntry).length > 1) (tabs.extra = tabs.extra || []).push(tabEntry); }
                s.seek(te.dataOffset + te.dataLength);
              }
            }
          }
          s.seek(ta.dataOffset + ta.dataLength);
        }
        s.seek(b.dataOffset + b.dataLength);
        if (tabs.length) style.tabs = tabs;
        break;
      }
      default: break;
    }
  }
  return style;
}

const UNDERLINE = { 1: 'single', 2: 'words', 3: 'double', 4: 'dotted', 6: 'thick', 7: 'dashed', 9: 'dashed', 0xa: 'dotted',
  0xb: 'wavy', 0x10: 'wavy', 0x11: 'dotted', 0x12: 'dashed', 0x13: 'dashed', 0x14: 'dotted', 0x15: 'dashed', 0x16: 'dashed' };

// ------------------------------------------------------------------ Contents stream
function parseContents(s, st, shapeInfo) {
  s.seek(0x1a);
  const trailerOffset = s.u32();
  s.seek(trailerOffset);
  s.u32();
  const chunks = [];
  let seq = -1;
  for (let i = 0; i < 3 && s.still(s.len); i++) {
    const part = parseBlock(s, false);
    if (part.type !== TRAILER_DIRECTORY) continue;
    while (s.still(part.dataOffset + part.dataLength)) {
      const b = parseBlock(s, false);
      seq++;
      if (b.type === GENERAL_CONTAINER) {
        let type = 0, offset = 0, parent = 0, seenType = false, seenOff = false;
        while (s.still(b.dataOffset + b.dataLength)) {
          const sb = parseBlock(s, true);
          if (sb.id === 0x2) { type = sb.data; seenType = true; }
          else if (sb.id === 0x4) { offset = sb.data; seenOff = true; }
          else if (sb.id === 0x5) parent = sb.data;
        }
        if (seenType && seenOff) chunks.push({ type, offset, seq, parent });
        s.seek(b.dataOffset + b.dataLength);
      } else skipBlock(s, b);
    }
  }
  const of = (t) => chunks.filter(c => c.type === t);
  // BorderArt: every pattern used in the publication is stored in it (name, sizes, 8 WMF pieces)
  st.borderArts = [];
  for (const c of of(0x46)) {
    try {
      s.seek(c.offset);
      const length = s.u32();
      while (s.still(c.offset + length)) {
        const b = parseBlock(s, false);
        if (b.id !== 0x02 || blockDataLength(b.type) >= 0) { if (blockDataLength(b.type) < 0) s.seek(b.dataOffset + b.dataLength); continue; }
        const listEnd = b.dataOffset + b.dataLength;
        while (s.still(listEnd)) {
          const e = parseBlock(s, false);
          const eEnd = e.dataOffset + e.dataLength;
          if (blockDataLength(e.type) >= 0) continue;
          const art = { name: '', dims: [0, 0, 0], pieces: [], offs: [], imgs: [] };
          while (s.still(eEnd)) {
            const f = parseBlock(s, false);
            const cont = blockDataLength(f.type) < 0, fEnd = f.dataOffset + f.dataLength;
            if (f.id === 0x03 && f.stringData) art.name = Buffer.from(f.stringData).toString('utf16le').replace(/\0+$/, '');
            else if (f.id === 0x04 && !cont) art.dims[0] = f.data;
            else if (f.id === 0x05 && !cont) art.dims[1] = f.data;
            else if (f.id === 0x06 && !cont) art.dims[2] = f.data;
            else if (f.id === 0x08 && cont) { while (s.still(fEnd)) { const o = parseBlock(s, true); art.offs.push(o.data); } }
            else if (f.id === 0x0a && cont) {
              while (s.still(fEnd)) {
                const im = parseBlock(s, false), imEnd = im.dataOffset + im.dataLength;
                if (blockDataLength(im.type) >= 0) continue;
                while (s.still(imEnd)) {
                  const raw = parseBlock(s, false);
                  if (raw.type === 0x80) art.imgs.push(wmfPieceToSvg(s.b, raw.dataOffset + 4, raw.dataOffset + raw.dataLength));
                  if (blockDataLength(raw.type) < 0) s.seek(raw.dataOffset + raw.dataLength);
                }
                s.seek(imEnd);
              }
            }
            if (cont) s.seek(fEnd);
          }
          // the 8 positions name their piece by offset; equal offsets share one picture
          const uniq = Array.from(new Set(art.offs)).sort((x, y) => x - y);
          art.pieces = art.offs.length === 8 ? art.offs.map(o => art.imgs[uniq.indexOf(o)] || null) : art.imgs.slice(0, 8);
          delete art.imgs; delete art.offs;
          st.borderArts.push(art);
          s.seek(eEnd);
        }
        s.seek(listEnd);
      }
    } catch (e) { /* BorderArt is decoration: never fail the import over it */ }
  }
  // Palette
  for (const c of of(0x5C)) {
    s.seek(c.offset);
    const length = s.u32();
    while (s.still(c.offset + length)) {
      const b = parseBlock(s, false);
      if (b.type === 0xA0) {
        while (s.still(b.dataOffset + b.dataLength)) {
          const sb = parseBlock(s, false);
          if (sb.type === GENERAL_CONTAINER) {
            while (s.still(sb.dataOffset + sb.dataLength)) {
              const e = parseBlock(s, true);
              if (e.id === 0x01) st.palette.push([e.data & 0xff, (e.data >>> 8) & 0xff, (e.data >>> 16) & 0xff]);
            }
          } else if (sb.type === DUMMY) st.palette.push([0, 0, 0]);
          skipBlock(s, sb);
        }
      }
      skipBlock(s, b);
    }
  }
  // Shapes (text ids, tables, vertical alignment)
  for (const c of chunks.filter(c => [0x01, 0x20, 0x30, 0x31, 0x10].includes(c.type))) {
    s.seek(c.offset);
    const length = s.u32();
    const info = shapeInfo(c.seq);
    info.chunkType = c.type;
    info.chunkParent = c.parent;
    if (c.type === 0x10) {
      const t = {};
      while (s.still(c.offset + length)) {
        const b = parseBlock(s, true);
        if (b.id === 0x6B) t.cells = b.data;
        else if (b.id === 0x66) t.rows = b.data;
        else if (b.id === 0x67) t.cols = b.data;
        else if (b.id === 0x6D) t.rowcolOffset = b.dataOffset;
        else if (b.id === 0x27) info.textId = b.data;
        else if (b.id === 0x09 && b.type === 0x18) info.borderArtIdx = b.data;
      }
      if (t.rows && t.cols && t.rowcolOffset != null) {
        const widths = [], heights = [];
        s.seek(t.rowcolOffset);
        const alen = s.u32();
        while (s.still(t.rowcolOffset + alen)) {
          const b = parseBlock(s, true);
          if (b.id === 0) {
            s.seek(b.dataOffset + 4);
            while (s.still(b.dataOffset + b.dataLength)) {
              const sb = parseBlock(s, true);
              if (sb.id === 0x02) { if (widths.length < t.cols) widths.push(sb.data); else if (heights.length < t.rows) heights.push(sb.data); }
            }
            s.seek(b.dataOffset + b.dataLength);
          }
        }
        info.table = { rows: t.rows, cols: t.cols, widths, heights, cellsSeq: t.cells };
      }
    } else {
      while (s.still(c.offset + length)) {
        const b = parseBlock(s, true);
        if (b.id === 0x27) info.textId = b.data;
        else if (b.id === 0x09 && b.type === 0x18) info.borderArtIdx = b.data;   // which stored BorderArt pattern frames this shape
        else if (b.id === 0x35) info.valign = b.data;
        else if (b.id === 0xb7 && b.data) info.cropType = b.data;
        else if (b.id === 0x04 && b.type !== GENERAL_CONTAINER) info.layoutFlags = b.data;  // picture cropped to a shape (Escher shape type)
        else if (b.id === 0x28) info.chainIndex = b.data;     // position in a chain of linked text boxes
        else if (b.id === 0x36) info.chainPrev = b.data;
        else if (b.id === 0x37) info.chainNext = b.data;
      }
    }
  }
  // Table cell definitions
  for (const c of of(0x63)) {
    s.seek(c.offset);
    const len = s.u32();
    const cells = [];
    while (s.still(c.offset + len)) {
      const b = parseBlock(s, true);
      if (b.id === 0x02) {
        s.seek(b.dataOffset + 4);
        while (s.still(b.dataOffset + b.dataLength)) {
          const item = parseBlock(s, true);
          if (item.id === 0) {
            s.seek(item.dataOffset + 4);
            const cell = {};
            while (s.still(item.dataOffset + item.dataLength)) {
              const sb = parseBlock(s, true);
              if (sb.id === 1) cell.r0 = sb.data; else if (sb.id === 2) cell.r1 = sb.data;
              else if (sb.id === 3) cell.c0 = sb.data; else if (sb.id === 4) cell.c1 = sb.data;
              else if (sb.id === 7) cell.valign = sb.data;
              else if (sb.id >= 0xa && sb.id <= 0xd) (cell.margins = cell.margins || [])[sb.id - 0xa] = sb.data;
            }
            cells.push(cell);
            s.seek(item.dataOffset + item.dataLength);
          }
        }
        s.seek(b.dataOffset + b.dataLength);
      }
    }
    st.tableCells = st.tableCells || new Map();
    st.tableCells.set(c.seq, cells);
  }
  // Document: page size and page order
  for (const c of of(0x44)) {
    s.seek(c.offset);
    const begin = s.tell();
    const len = s.u32();
    while (s.still(begin + len)) {
      const b = parseBlock(s, false);
      if (b.id === 0x12) {
        while (s.still(b.dataOffset + b.dataLength)) {
          const sb = parseBlock(s, true);
          if (sb.id === 0x1) st.width = sb.data / EMU;
          else if (sb.id === 0x2) st.height = sb.data / EMU;
        }
      } else if (b.id === 0x2) {
        s.seek(b.dataOffset + 4);
        while (s.still(b.dataOffset + b.dataLength)) {
          const sb = parseBlock(s, true);
          if (sb.id === 0) st.pageOrder.push(sb.data);
        }
      } else skipBlock(s, b);
    }
  }
  // Mail merge: the recipient list the publication is connected to (path, table, connection string)
  const strOf = (b) => {
    if (b.dataLength <= 4) return '';
    return s.b.slice(b.dataOffset + 4, b.dataOffset + b.dataLength).toString('utf16le').replace(/\0[\s\S]*$/, '').trim();
  };
  for (const c of of(0x54)) {
    s.seek(c.offset);
    const len = s.u32();
    const m = {};
    while (s.still(c.offset + len)) {
      const b = parseBlock(s, true);
      if (b.type === STRING_CONTAINER) {
        if (b.id === 1) m.path = strOf(b); else if (b.id === 2) m.table = strOf(b); else if (b.id === 3) m.connect = strOf(b);
      }
      if (b.type === STRING_CONTAINER || b.type === GENERAL_CONTAINER || b.type === 0x80 || b.type === 0x82 || b.type === 0x8a || b.type === 0x90 || b.type === 0x98 || b.type === 0xa0) s.seek(b.dataOffset + b.dataLength);
    }
    if (m.path && !st.mailMerge) st.mailMerge = m;
  }
  // Printing several pages on one sheet (cards, labels, postcards)
  for (const c of of(0x8a)) {
    s.seek(c.offset);
    const len = s.u32();
    const walk = (end, depth, out) => {
      while (s.still(end)) {
        const b = parseBlock(s, true);
        out.push({ id: b.id, type: b.type, data: b.data, depth });
        if ((b.type === GENERAL_CONTAINER || b.type === 0x90 || b.type === 0x98 || b.type === 0xa0) && depth < 5) { s.seek(b.dataOffset + 4); walk(b.dataOffset + b.dataLength, depth + 1, out); }
        if (b.type >= 0x80) s.seek(b.dataOffset + b.dataLength);
      }
      return out;
    };
    const flat = walk(c.offset + len, 0, []);
    // block 4 holds a "multiple pages per sheet" flag (13) and the sheet (14: width, height, then margins and spacing)
    const i13 = flat.findIndex(x => x.id === 0x13 && x.depth === 1);
    const i14 = flat.findIndex(x => x.id === 0x14 && x.depth === 1);
    if (i13 >= 0 && flat[i13].data && i14 >= 0) {
      const sub = flat.slice(i14 + 1).filter(x => x.depth >= 2);
      const at = (id, depth) => { const x = sub.find(y => y.id === id && y.depth === depth); return x ? x.data : null; };
      const sw = at(1, 3), sh = at(2, 3);
      if (sw && sh) {
        st.sheet = { width: sw, height: sh, marginX: at(2, 4) || 0, marginY: at(3, 4) || 0, pitchX: at(8, 4) || 0, pitchY: at(9, 4) || 0 };
      }
    }
    break;
  }
  // Guides: positions of vertical lines (count in 6) then horizontal lines (count in 7), from the page's top-left
  st.guides = new Map();
  for (const c of of(0x4c)) {
    s.seek(c.offset);
    const len = s.u32();
    const g = { pos: [], nx: 0, ny: 0, colHalfGap: 0, rowHalfGap: 0 };
    while (s.still(c.offset + len)) {
      const b = parseBlock(s, true);
      if (b.id === 0x02 && b.type !== 0x20) {
        s.seek(b.dataOffset + 4);
        while (s.still(b.dataOffset + b.dataLength)) {
          const item = parseBlock(s, true);
          if (item.type === GENERAL_CONTAINER) {
            s.seek(item.dataOffset + 4);
            let pos = 0;
            while (s.still(item.dataOffset + item.dataLength)) { const sb = parseBlock(s, true); if (sb.id === 1) pos = sb.data | 0; }
            g.pos.push(pos);
            s.seek(item.dataOffset + item.dataLength);
          }
        }
        s.seek(b.dataOffset + b.dataLength);
      } else if (b.id === 0x04 && b.type === 0x20) g.colHalfGap = b.data;
      else if (b.id === 0x05 && b.type === 0x20) g.rowHalfGap = b.data;
      else if (b.id === 0x06) g.nx = b.data;
      else if (b.id === 0x07) g.ny = b.data;
      else if (b.type === GENERAL_CONTAINER || b.type === 0xa0) s.seek(b.dataOffset + b.dataLength);
    }
    if (g.nx + g.ny !== g.pos.length) { g.nx = Math.min(g.nx, g.pos.length); g.ny = g.pos.length - g.nx; }
    st.guides.set(c.seq, g);
  }
  // Pages
  for (const c of of(0x43)) {
    s.seek(c.offset);
    const length = s.u32();
    const page = { seq: c.seq, shapes: [], bg: null, master: null, isMaster: false, dummy: [0x10d, 0x110, 0x113, 0x117].includes(c.seq) };
    while (s.still(c.offset + length)) {
      const b = parseBlock(s, false);
      if (b.id === 0x0a) page.bg = b.data;
      else if (b.id === 0x02) {
        while (s.still(b.dataOffset + b.dataLength)) {
          const sb = parseBlock(s, true);
          if (sb.type === SHAPE_SEQNUM) { page.shapes.push(sb.data); shapeInfo(sb.data).page = c.seq; }
        }
      } else if (b.id === 0x0E) { if (b.stringData && b.stringData.some(x => x !== 0)) page.isMaster = true; }
      else if (b.id === 0x0D) page.master = b.data;
      else if (b.id === 0x03 && b.type === SHAPE_SEQNUM) page.layoutRef = b.data;   // margin and grid guides
      else if (b.id === 0x04 && b.type === SHAPE_SEQNUM) page.guidesRef = b.data;   // ruler guides
      else if (b.id === 0x05 && b.type === GENERAL_CONTAINER) {
        // Where this page sits on Publisher's big shared canvas (the scratch area has its own spot)
        s.seek(b.dataOffset + 4);
        const o = {};
        while (s.still(b.dataOffset + b.dataLength)) { const sb = parseBlock(s, true); if (sb.id === 1) o.x = sb.data; else if (sb.id === 2) o.y = sb.data; }
        s.seek(b.dataOffset + b.dataLength);
        if (o.x != null && o.y != null) page.origin = o;
      }
      else skipBlock(s, b);
    }
    st.pages.set(c.seq, page);
  }
}

// ------------------------------------------------------------------ Escher stream (shapes, pictures)
function parseEscher(s, delay, st, shapeInfo) {
  const dgg = findEscher(s, s.len, ESCHER.DGG);
  if (dgg) {
    const bstore = findEscher(s, dgg.off + dgg.len, ESCHER.BSTORE);
    if (bstore) {
      const end = bstore.off + bstore.len;
      while (s.still(end)) {
        const bse = escherRec(s);
        const next = bse.off + bse.len;
        let imgIndex = -1;
        if (bse.type === ESCHER.BSE && bse.len >= 36) {
          const size = s.b.readUInt32LE(bse.off + 20);
          const foDelay = s.b.readUInt32LE(bse.off + 28);
          const cbName = s.b[bse.off + 33];
          let img = null;
          if (bse.len > 36 + cbName) {
            // Picture stored right inside the BSE record
            const inner = new Stream(s.b);
            inner.seek(bse.off + 36 + cbName);
            img = readBlip(inner);
          } else if (size > 0 && foDelay !== 0xffffffff && foDelay < delay.len) {
            delay.seek(foDelay);
            img = readBlip(delay);
          }
          if (img) { st.images.push(img); imgIndex = st.images.length; }
        }
        st.bseImageIndex.push(imgIndex);
        s.seek(next);
      }
    }
    s.seek(dgg.off + dgg.len + tailLen(ESCHER.DGG));
  }
  let dg;
  while ((dg = findEscher(s, s.len, ESCHER.DG))) {
    const dgEnd = dg.off + dg.len;
    let spgr;
    while ((spgr = findEscher(s, dgEnd, ESCHER.SPGR))) {
      parseShapeGroup(s, spgr, { xs: 0, ys: 0, xe: 0, ye: 0 }, { xs: 0, ys: 0, xe: 0, ye: 0 }, st, shapeInfo, null, 0);
      s.seek(spgr.off + spgr.len);
    }
    s.seek(dgEnd + tailLen(ESCHER.DG));
  }
}

function readBlip(s) {
  const r = escherRec(s);
  const types = {
    [ESCHER.BLIP_PNG]: ['image/png', 'png', 0x6E0, 0x11],
    [ESCHER.BLIP_JPEG]: ['image/jpeg', 'jpg', [0x46A, 0x6E2], 0x11],
    [ESCHER.BLIP_JPEGCMYK]: ['image/jpeg', 'jpg', [0x46B, 0x6E3], 33],
    [ESCHER.BLIP_DIB]: ['image/bmp', 'bmp', 0x7A8, 0x11],
    [ESCHER.BLIP_TIFF]: ['image/tiff', 'tif', 0x6E4, 0x11],
    [ESCHER.BLIP_EMF]: ['image/emf', 'emf', 0x3D4, 0x34],
    [ESCHER.BLIP_WMF]: ['image/wmf', 'wmf', 0x216, 0x34],
  };
  const t = types[r.type];
  if (!t) return null;
  const inst = r.initial >> 4;
  const oneUid = Array.isArray(t[2]) ? t[2].includes(inst) : inst === t[2];
  const start = r.off + t[3] + (oneUid ? 0 : 0x10);
  const end = Math.min(s.len, r.off + r.len);
  if (start >= end) return null;
  let data = s.b.subarray(start, end);
  if (t[1] === 'emf' || t[1] === 'wmf') {
    // Metafiles are stored deflated after a 34-byte header that follows the UID(s)
    const hdr = r.off + 16 + (oneUid ? 0 : 16);
    const cbSave = s.b.readUInt32LE(hdr + 28);
    let raw = null;
    for (const at of [hdr + 34, start, hdr + 32, hdr + 36]) {
      try { raw = zlib.inflateSync(s.b.subarray(at, Math.min(end, at + (cbSave || end - at)))); break; } catch { /* try next */ }
    }
    if (!raw) return null;
    if (t[1] === 'wmf' && raw.readUInt32LE(0) !== 0x9AC6CDD7) {
      // Add a "placeable" header so Windows knows the picture's size
      const rc = { l: s.b.readInt32LE(hdr + 4), t: s.b.readInt32LE(hdr + 8), r: s.b.readInt32LE(hdr + 12), b: s.b.readInt32LE(hdr + 16) };
      const ptx = s.b.readInt32LE(hdr + 20);
      const widthIn = ptx / EMU;
      const units = Math.abs(rc.r - rc.l) || 1;
      const inch = Math.max(1, Math.min(65535, Math.round(widthIn > 0 ? units / widthIn : 1440)));
      const apm = Buffer.alloc(22);
      apm.writeUInt32LE(0x9AC6CDD7, 0);
      apm.writeUInt16LE(0, 4);
      apm.writeInt16LE(Math.max(-32768, Math.min(32767, rc.l)), 6);
      apm.writeInt16LE(Math.max(-32768, Math.min(32767, rc.t)), 8);
      apm.writeInt16LE(Math.max(-32768, Math.min(32767, rc.r)), 10);
      apm.writeInt16LE(Math.max(-32768, Math.min(32767, rc.b)), 12);
      apm.writeUInt16LE(inch, 14);
      apm.writeUInt32LE(0, 16);
      let sum = 0;
      for (let i = 0; i < 10; i++) sum ^= apm.readUInt16LE(i * 2);
      apm.writeUInt16LE(sum, 20);
      raw = Buffer.concat([apm, raw]);
    }
    data = raw;
  } else if (t[1] === 'bmp') {
    if (data.length < 0x32) return null;
    const bpp = data.readUInt16LE(0x0E);
    let colors = data.readUInt32LE(0x20);
    if (colors === 0 && bpp <= 8) colors = 1 << bpp;
    const head = Buffer.alloc(14);
    head.write('BM', 0, 'latin1');
    head.writeUInt32LE(data.length + 14, 2);
    head.writeUInt32LE(0x36 + 4 * colors, 10);
    data = Buffer.concat([head, data]);
  } else {
    data = Buffer.from(data);
  }
  return { mime: t[0], ext: t[1], data };
}

function parseShapeGroup(s, spgr, parentCS, parentAbs, st, shapeInfo, group, depth) {
  if (depth > 100) return;
  const end = spgr.off + spgr.len;
  let r;
  // pass coordinate systems by value into this level, mutated by the group leader
  const cs = Object.assign({}, parentCS), abs = Object.assign({}, parentAbs);
  while ((r = findEscher(s, end, [ESCHER.SPGR, ESCHER.SP]))) {
    if (r.type === ESCHER.SPGR) {
      const g = { group: true, seq: null, children: [] };
      (group ? group.children : st.topLevel).push(g);
      parseShapeGroup(s, r, cs, abs, st, shapeInfo, g, depth + 1);
    } else {
      parseEscherShape(s, r, cs, abs, st, shapeInfo, group);
    }
    s.seek(r.off + r.len + tailLen(r.type));
  }
}

// Publisher keeps each table cell's shading, and the table's grid lines, as drawing shapes of their own that
// have no shape id; their "anchor" record instead names the table (block 2) and the cell number (block 3).
// Grid-line shapes also carry block 1 (1 = across, 2 = down).
function tableCellShape(s, sp, end, st, shapeInfo) {
  s.seek(sp.off);
  const anchor = findEscher(s, end, ESCHER.CLIENT_ANCHOR);
  if (!anchor || anchor.len < 6) return;
  const a = new Stream(s.b.subarray(anchor.off, anchor.off + anchor.len));
  const total = a.u32();
  const tag = {};
  while (a.still(Math.min(total, anchor.len))) {
    const b = parseBlock(a, true);
    if (b.dataLength === 4 || b.dataLength === 2) tag[b.id] = b.data;
    else if (!b.dataLength && !b.id) break;
  }
  if (tag[2] == null) return;
  const table = shapeInfo(tag[2]);
  s.seek(sp.off);
  const fopt = findEscher(s, end, ESCHER.FOPT);
  if (!fopt) return;
  const { scalars: v } = foptValues(s, fopt);
  if (tag[1] != null) {
    // A grid line: remember its thickness for the table's borders
    if (v.has(F.LINE_WIDTH) && table.gridWidth == null) table.gridWidth = v.get(F.LINE_WIDTH);
    if (tag[1] === 1) table.gridAcross = true; else if (tag[1] === 2) table.gridDown = true;
    if (v.has(F.FILL_COLOR) && table.gridColor == null) table.gridColor = v.get(F.FILL_COLOR);
    return;
  }
  const fillType = v.has(F.FILL_TYPE) ? v.get(F.FILL_TYPE) : 0;
  const fillColor = v.get(F.FILL_COLOR);
  const styleBool = v.get(F.FILL_STYLE_BOOL);
  if (fillType !== 0 || fillColor == null || (styleBool != null && (styleBool & 0x10) === 0 && (styleBool & 0x100000))) return;
  (table.cellFills = table.cellFills || [])[tag[3] || 0] = { color: fillColor, opacity: v.has(F.FILL_OPACITY) ? v.get(F.FILL_OPACITY) / 0xFFFF : 1 };
}

function parseEscherShape(s, sp, cs, abs, st, shapeInfo, group) {
  const parentCS = Object.assign({}, cs);
  const end = sp.off + sp.len;
  let definesRelative = false;
  s.seek(sp.off);
  const fspgr = findEscher(s, end, ESCHER.FSPGR);
  if (fspgr) {
    s.seek(fspgr.off);
    let xs = s.i32(), ys = s.i32(), xe = s.i32(), ye = s.i32();
    if (xs > xe) [xs, xe] = [xe, xs];
    if (ys > ye) [ys, ye] = [ye, ys];
    Object.assign(cs, { xs, ys, xe, ye });
    definesRelative = true;
  }
  s.seek(sp.off);
  const fsp = findEscher(s, end, ESCHER.FSP);
  let type = 1, flags = 0;
  if (fsp) { type = fsp.initial >> 4; s.seek(fsp.off + 4); flags = s.u32(); }
  const isGroupLeader = !!(flags & SF_GROUP);
  s.seek(sp.off);
  const cdata = findEscher(s, end, ESCHER.CLIENT_DATA);
  if (!cdata) { tableCellShape(s, sp, end, st, shapeInfo); return; }
  const dv = escherValues(s, cdata);
  const seq = dv.get(F.SHAPE_ID);
  if (seq == null) return;
  const info = shapeInfo(seq);
  info.escherType = type;
  info.flipH = !!(flags & SF_FLIP_H);
  info.flipV = !!(flags & SF_FLIP_V);
  if (isGroupLeader) { if (group) group.seq = seq; }
  else (group ? group.children : st.topLevel).push({ seq });

  s.seek(sp.off);
  const anchor = findEscher(s, end, [ESCHER.CLIENT_ANCHOR, ESCHER.CHILD_ANCHOR]);
  if (!anchor && !isGroupLeader) return;
  let rotated90 = false;
  s.seek(sp.off);
  const tert = findEscher(s, end, ESCHER.TERTIARY_FOPT);
  const tv = tert ? escherValues(s, tert) : new Map();
  s.seek(sp.off);
  const fopt = findEscher(s, end, ESCHER.FOPT);
  if (fopt) {
    const { scalars: v, complex } = foptValues(s, fopt);
    const pxId = v.get(F.PXID);
    if (pxId != null && pxId > 0 && pxId <= st.bseImageIndex.length && st.bseImageIndex[pxId - 1] > 0) {
      info.image = st.bseImageIndex[pxId - 1];
    }
    // Fill
    const fillType = v.has(F.FILL_TYPE) ? v.get(F.FILL_TYPE) : 0;
    const fillColor = v.get(F.FILL_COLOR);
    const styleBool = v.get(F.FILL_STYLE_BOOL);
    const skipIfNotBg = styleBool != null && (styleBool & 0xF0) === 0;
    if (fillType === 0 && fillColor != null && !skipIfNotBg) {
      info.fill = fillColor;
      info.fillOpacity = v.has(F.FILL_OPACITY) ? v.get(F.FILL_OPACITY) / 0xFFFF : 1;
    } else if (fillType >= 4 && fillType <= 7) {
      // Gradient (shade): colors from fillShadeColors, or fillColor → fillBackColor
      if (fillColor != null) info.fill = fillColor;
      const grad = complex.get(F.FILL_SHADE_COMPLEX);
      if (grad && grad.length >= 14) info.fill = grad.readUInt32LE(6);
      info.fillOpacity = v.has(F.FILL_OPACITY) ? v.get(F.FILL_OPACITY) / 0xFFFF : 1;
      const back = v.has(F.FILL_BACK_COLOR) ? v.get(F.FILL_BACK_COLOR) : 0xFFFFFF;
      let stops = [];
      if (grad && grad.length >= 6) {
        const nEl = grad.readUInt16LE(0), cb = grad.readUInt16LE(4) || 8;
        for (let i = 0; i < nEl && 6 + i * cb + 8 <= grad.length; i++) stops.push({ c: grad.readUInt32LE(6 + i * cb), p: fixed16(grad.readInt32LE(10 + i * cb)) });
      }
      if (stops.length < 2) {
        const focus = v.has(0x018C) ? (v.get(0x018C) | 0) : 0;
        const a = fillColor != null ? fillColor : 0xFFFFFF;
        if (Math.abs(focus) === 50) stops = [{ c: a, p: 0 }, { c: back, p: 0.5 }, { c: a, p: 1 }];
        else if (Math.abs(focus) === 100) stops = [{ c: back, p: 0 }, { c: a, p: 1 }];
        else stops = [{ c: a, p: 0 }, { c: back, p: 1 }];
      }
      let ang = v.has(0x018B) ? fixed16(v.get(0x018B)) : 0;
      if (!v.has(0x018B) && fillType === 7) stops = stops.slice().reverse().map((x, i, a) => ({ c: x.c, p: 1 - stops[stops.length - 1 - i].p }));   // no angle given: Publisher paints back colour at the top
      info.gradient = { type: fillType === 5 || fillType === 6 ? 'radial' : 'linear', angle: ang, stops,
        backOpacity: v.has(0x0184) ? v.get(0x0184) / 0xFFFF : null, base: fillColor != null ? fillColor : 0xFFFFFF };
    } else if (fillType === 2 || fillType === 3) {
      const bgPx = v.get(0x4186);
      if (bgPx && bgPx <= st.bseImageIndex.length && st.bseImageIndex[bgPx - 1] > 0) info.fillImage = st.bseImageIndex[bgPx - 1];
      if (info.fillImage && fillType === 2) info.fillTiled = true;   // texture fill: the picture is a tile at its own size, not stretched
    }
    // Custom (freeform) geometry: vertices + segment list (0x0145 / 0x0146) in a geoLeft..geoBottom space
    if (complex.has(0xC145) && complex.has(0xC146)) info.path = parsePath(v, complex.get(0xC145), complex.get(0xC146));
    // WordArt: text on a preset curve (shape types 136-159), text in 0x00C0, font name in 0x00C5
    if (complex.has(0xC0C0)) {
      const u16 = (b) => b.toString('utf16le').replace(/\u0000+$/, '');
      info.wordArt = { text: u16(complex.get(0xC0C0)), font: complex.has(0xC0C5) ? u16(complex.get(0xC0C5)) : null, flags: v.get(0x00FF) != null ? v.get(0x00FF) >>> 0 : 0, size: v.has(0x00C3) ? v.get(0x00C3) / 65536 : null };
    }
    // Recolor Picture (Format Picture > Recolor): colour in the tertiary set 0x011A, switched on by 0x013F (high bit 0x40)
    if (tv.has(0x011A) && ((tv.get(0x013F) || 0) & 0x400000)) info.picRecolor = tv.get(0x011A);
    // Picture brightness / contrast (0x0109 / 0x0108, 16.16 fixed, defaults 0 and 1.0). 0.35 / 0.3 is Office's Washout preset.
    if (v.has(0x0108) || v.has(0x0109)) info.picAdjust = { contrast: v.has(0x0108) ? v.get(0x0108) / 65536 : 1, brightness: v.has(0x0109) ? (v.get(0x0109) | 0) / 65536 : 0 };
    if (!tv.has(0x01DD) && v.has(0x01C2) && ((v.get(0x01C2) >>> 24) & 0xff) !== 0xff) info.borderArtColor = v.get(0x01C2);   // no art colour of its own: the line's second colour (Missions Bookmark's teal)
    if (tv.has(0x01DD)) { info.borderArtColor = tv.get(0x01DD); if (tv.has(0x01DF) && ((tv.get(0x01DF) >>> 24) & 0xff) === 0x10) info.borderArtTint = tv.get(0x01DF); }   // BorderArt colour (black parts of the pattern are drawn in it)
    // Picture opacity (Format Picture > Transparency): 16.16 fixed, 1.0 = solid (0.26 = the faded map of America on the Prayer List)
    { const t = v.has(0x0120) ? v.get(0x0120) : tv.has(0x0120) ? tv.get(0x0120) : null; if (t != null && t > 0 && t < 0xFF00) info.picOpacity = t / 65536; }
    // Outline
    const lineFlags = v.get(F.LINE_STYLE_BOOL), geomFlags = v.get(F.GEOM_BOOL);
    if (lineExists(lineFlags, geomFlags)) {
      if (v.has(F.LINE_COLOR) || ((lineFlags & FLAG_USE_LINE) && (lineFlags & FLAG_LINE))) {
        info.line = { color: v.has(F.LINE_COLOR) ? v.get(F.LINE_COLOR) : 0, width: v.has(F.LINE_WIDTH) ? v.get(F.LINE_WIDTH) : 9525 };
      } else if (tert && lineExists(tv.get(F.LINE_STYLE_BOOL))) {
        const sides = [['TOP'], ['RIGHT'], ['BOTTOM'], ['LEFT']].map(([n]) => {
          const c = tv.get(F[`LINE_${n}_COLOR`]);
          return c != null && lineExists(tv.get(F[`LINE_${n}_BOOL`])) ? { color: c, width: tv.get(F[`LINE_${n}_WIDTH`]) || 9525 } : null;
        });
        const first = sides.find(Boolean);
        if (first) info.line = first;
      }
    }
    if (v.has(F.LINE_DASHING)) { const d = v.get(F.LINE_DASHING); info.dash = d === 0 ? 'solid' : (d === 2 || d === 5) ? 'dot' : 'dash'; }
    if (v.has(F.BEGIN_ARROW)) info.arrowStart = v.get(F.BEGIN_ARROW) > 0;
    if (v.has(F.END_ARROW)) info.arrowEnd = v.get(F.END_ARROW) > 0;
    if (v.has(F.ADJUST1)) info.adjust1 = v.get(F.ADJUST1) | 0;
    if (v.has(F.ROTATION)) {
      let rot = fixed16(v.get(F.ROTATION)) % 360;
      if (rot < 0) rot += 360;
      info.rotation = rot;
      rotated90 = (rot >= 45 && rot < 135) || (rot >= 225 && rot < 315);
    }
    // Shadow (shadow props 0x0200–0x023F; softness may be in the tertiary set)
    const shBool = v.has(0x023F) ? v.get(0x023F) : tv.get(0x023F);
    if (shBool != null && (shBool & 0x20002) === 0x20002) {
      const num = (id, d) => { const x = v.has(id) ? v.get(id) : tv.has(id) ? tv.get(id) : d; return x == null ? d : (x | 0); };
      info.shadow = {
        color: v.has(0x0201) ? v.get(0x0201) : 0x808080,
        opacity: num(0x0204, 0x10000) / 0x10000,
        x: num(0x0205, 25400) / 12700, y: num(0x0206, 25400) / 12700,
        blur: Math.max(0, num(0x021C, 0)) / 12700,
      };
    }
    info.margins = [v.get(F.TEXT_TOP), v.get(F.TEXT_RIGHT), v.get(F.TEXT_BOTTOM), v.get(F.TEXT_LEFT)].map(x => emuToPt(x == null ? 36576 : x));
    if (type === 201) info.tableLines = { tert: tv, width: v.get(F.LINE_WIDTH), color: v.get(F.LINE_COLOR) };
    const crop = [F.CROP_TOP, F.CROP_RIGHT, F.CROP_BOTTOM, F.CROP_LEFT].map(id => (v.has(id) ? fixed16(v.get(id)) : 0));
    if (crop.some(c => c)) info.crop = crop;
  }
  if (tv.has(F.NUM_COLUMNS)) info.columns = tv.get(F.NUM_COLUMNS);
  if (tv.has(F.COLUMN_SPACING)) info.columnGap = emuToPt(tv.get(F.COLUMN_SPACING));

  if (anchor) {
    let a;
    if (anchor.type === ESCHER.CLIENT_ANCHOR) {
      const av = escherValues(s, anchor);
      // Scratch-area shapes are measured from one of the page's corners (0 top-left, 1 top-right, 2 bottom-left, 3 bottom-right)
      info.corner = av.has(0x1805) ? av.get(0x1805) & 3 : 0;
      a = { xs: av.get(F.XS) | 0, ys: av.get(F.YS) | 0, xe: av.get(F.XE) | 0, ye: av.get(F.YE) | 0 };
    } else {
      s.seek(anchor.off);
      const csw = (parentCS.xe - parentCS.xs) || 1, csh = (parentCS.ye - parentCS.ys) || 1;
      const sx = (abs.xe - abs.xs) / csw, sy = (abs.ye - abs.ys) / csh;
      const x0 = s.i32(), y0 = s.i32(), x1 = s.i32(), y1 = s.i32();
      a = {
        xs: Math.round((x0 - parentCS.xs) * sx + abs.xs), ys: Math.round((y0 - parentCS.ys) * sy + abs.ys),
        xe: Math.round((x1 - parentCS.xs) * sx + abs.xs), ye: Math.round((y1 - parentCS.ys) * sy + abs.ys),
      };
    }
    if (rotated90) {
      const w = a.xe - a.xs, h = a.ye - a.ys, cx = a.xs + w / 2, cy = a.ys + h / 2;
      a = { xs: Math.round(cx - h / 2), ys: Math.round(cy - w / 2), xe: Math.round(cx + h / 2), ye: Math.round(cy + w / 2) };
    }
    info.coords = a;
    if (definesRelative) Object.assign(abs, a);
  }
}


// ------------------------------------------------------------------ BorderArt (Publisher stores each used pattern in the file: 8 small WMF pieces)
/** One WMF border piece as SVG shapes. Returns { org:[x,y], ext:[w,h], body } (ext may be negative: mirrored axis). */
function wmfPieceToSvg(buf, p, end0) {
  if (p + 18 > buf.length || buf.readUInt16LE(p) !== 1 || buf.readUInt16LE(p + 2) !== 9) return null;
  const end = Math.min(buf.length, end0 || buf.length, p + buf.readUInt32LE(p + 6) * 2);
  const col = (c) => '#' + [c & 255, (c >> 8) & 255, (c >> 16) & 255].map(v => v.toString(16).padStart(2, '0')).join('');
  const objs = [];
  let brush = ['#ffffff', true], pen = ['#000000', 1, true], org = [0, 0], ext = [1000, 1000], cur = [0, 0], mode = 1;
  const stack = [], out = [];
  const add = (o) => { const i = objs.indexOf(null); if (i >= 0) objs[i] = o; else objs.push(o); };
  const S = (o) => buf.readInt16LE(o);
  // Publisher draws these pens as hairlines (one device pixel) however small the piece; a hundredth of the piece is about that
  const stroke = () => (pen[2] ? ` stroke="${pen[0]}" stroke-width="${Math.max(pen[1], Math.round(Math.max(Math.abs(ext[0]), Math.abs(ext[1])) / 45 * 10) / 10, 1)}" stroke-linejoin="round"` : '');
  const style = () => `fill="${brush[1] ? brush[0] : 'none'}"${stroke()}`;
  const rule = () => `fill-rule="${mode === 1 ? 'evenodd' : 'nonzero'}"`;
  let q = p + 18;
  while (q + 6 <= end) {
    const rs = buf.readUInt32LE(q), rf = buf.readUInt16LE(q + 4), d = q + 6;
    if (rs < 3 || rf === 0 || q + rs * 2 > end) break;
    const pts = (n, o) => { const a = []; for (let i = 0; i < 2 * n; i++) a.push(S(o + 2 * i)); return a.join(' '); };
    if (rf === 0x20b) org = [S(d + 2), S(d)];
    else if (rf === 0x20c) ext = [S(d + 2), S(d)];
    else if (rf === 0x2fc) add(['b', col(buf.readUInt32LE(d + 2)), buf.readUInt16LE(d) !== 1]);
    else if (rf === 0x2fa) add(['p', col(buf.readUInt32LE(d + 6)), S(d + 2), (buf.readUInt16LE(d) & 15) !== 5]);
    else if (rf === 0x12d) { const o = objs[S(d)]; if (o) { if (o[0] === 'b') brush = [o[1], o[2]]; else pen = [o[1], o[2], o[3]]; } }
    else if (rf === 0x1f0) { const i = S(d); if (i >= 0 && i < objs.length) objs[i] = null; }
    else if (rf === 0x106) mode = S(d);
    else if (rf === 0x324) out.push(`<polygon points="${pts(S(d), d + 2)}" ${style()} ${rule()}/>`);
    else if (rf === 0x325) { if (pen[2]) out.push(`<polyline points="${pts(S(d), d + 2)}" fill="none"${stroke()}/>`); }
    else if (rf === 0x538) {
      const n = S(d); let o2 = d + 2 + 2 * n, dd = '';
      for (let i = 0; i < n; i++) { const c = S(d + 2 + 2 * i); dd += 'M' + pts(c, o2) + 'Z'; o2 += 4 * c; }
      out.push(`<path d="${dd}" ${style()} ${rule()}/>`);
    }
    else if (rf === 0x41b || rf === 0x61c) {
      const k = rf === 0x61c ? 4 : 0, bt = S(d + k), r = S(d + k + 2), t = S(d + k + 4), l = S(d + k + 6);
      out.push(`<rect x="${Math.min(l, r)}" y="${Math.min(t, bt)}" width="${Math.abs(r - l)}" height="${Math.abs(bt - t)}"${k ? ` rx="${S(d + 2) / 2}" ry="${S(d) / 2}"` : ''} ${style()}/>`);
    }
    else if (rf === 0x418) { const bt = S(d), r = S(d + 2), t = S(d + 4), l = S(d + 6); out.push(`<ellipse cx="${(l + r) / 2}" cy="${(t + bt) / 2}" rx="${Math.abs(r - l) / 2}" ry="${Math.abs(bt - t) / 2}" ${style()}/>`); }
    else if (rf === 0x214) cur = [S(d + 2), S(d)];
    else if (rf === 0x213) { const x = S(d + 2), y = S(d); if (pen[2]) out.push(`<line x1="${cur[0]}" y1="${cur[1]}" x2="${x}" y2="${y}"${stroke()}/>`); cur = [x, y]; }
    else if (rf === 0x817 || rf === 0x81a || rf === 0x830) {
      const ye = S(d), xe = S(d + 2), ys = S(d + 4), xs = S(d + 6), bt = S(d + 8), r = S(d + 10), t = S(d + 12), l = S(d + 14);
      const cx = (l + r) / 2, cy = (t + bt) / 2, rx = Math.abs(r - l) / 2 || 1, ry = Math.abs(bt - t) / 2 || 1;
      const a1 = Math.atan2((ys - cy) / ry, (xs - cx) / rx), a2 = Math.atan2((ye - cy) / ry, (xe - cx) / rx);
      const f = (v) => Math.round(v * 10) / 10;
      const sweep = (((a1 - a2) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
      const dd = `M${f(cx + rx * Math.cos(a1))} ${f(cy + ry * Math.sin(a1))}A${rx} ${ry} 0 ${sweep > Math.PI ? 1 : 0} 0 ${f(cx + rx * Math.cos(a2))} ${f(cy + ry * Math.sin(a2))}`;
      if (rf === 0x817) { if (pen[2]) out.push(`<path d="${dd}" fill="none"${stroke()}/>`); }
      else out.push(`<path d="${dd}${rf === 0x81a ? `L${cx} ${cy}` : ''}Z" ${style()}/>`);
    }
    else if (rf === 0x1e) stack.push([brush, pen, org.slice(), ext.slice(), mode]);
    else if (rf === 0x127) { const t = stack.pop(); if (t) [brush, pen, org, ext, mode] = t; }
    q += rs * 2;
  }
  return { org, ext, body: out.join('') };
}
/** The 8 pieces (top-left corner, top, top-right, right, bottom-right, bottom, bottom-left, left) as one 3x3 picture for a CSS border-image. */
function borderArtSvg(art) {
  const C = 100, stretchH = art.dims[1] >= 12000000 || !art.dims[0], stretchV = art.dims[2] >= 12000000 || !art.dims[0];
  const mh = stretchH ? C : Math.max(10, Math.round(C * art.dims[1] / art.dims[0])), mv = stretchV ? C : Math.max(10, Math.round(C * art.dims[2] / art.dims[0]));
  const cells = [[0, 0, C, C], [C, 0, mh, C], [C + mh, 0, C, C], [C + mh, C, C, mv], [C + mh, C + mv, C, C], [C, C + mv, mh, C], [0, C + mv, C, C], [0, C, C, mv]];
  let body = '';
  art.pieces.forEach((pc, k) => {
    if (!pc) return;
    const [x, y, w, h] = cells[k], ex = pc.ext[0] || 1, ey = pc.ext[1] || 1;
    const flip = ex < 0 || ey < 0 ? ` transform="scale(${ex < 0 ? -1 : 1} ${ey < 0 ? -1 : 1})"` : '';
    const vb = `${ex < 0 ? -pc.org[0] : pc.org[0]} ${ey < 0 ? -pc.org[1] : pc.org[1]} ${Math.abs(ex)} ${Math.abs(ey)}`;
    body += `<svg x="${x}" y="${y}" width="${w}" height="${h}" viewBox="${vb}" preserveAspectRatio="none" overflow="hidden">${flip ? `<g${flip}>${pc.body}</g>` : pc.body}</svg>`;
  });
  return { svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${2 * C + mh}" height="${2 * C + mv}" viewBox="0 0 ${2 * C + mh} ${2 * C + mv}" shape-rendering="geometricPrecision">${body}</svg>`, slice: C, repeatH: stretchH ? 'stretch' : 'round', repeatV: stretchV ? 'stretch' : 'round' };
}

// ------------------------------------------------------------------ build PageStudio objects
const PS_SYMBOL_RE = /^(webdings|wingdings( 2| 3)?|symbol)$/i;
function assemble(st) {
  const W = st.width, H = st.height;
  const pt = (emuX, axis) => ((axis === 'x' ? W : H) / 2 + emuX / EMU) * 72;
  const color = (c) => (c == null ? null : hex(finalColor(c, c, st.palette)));
  const images = {};
  const usedImages = new Set();
  let skipped = 0;

  const fontName = (i) => (i != null && i < st.fonts.length ? st.fonts[i] : st.fonts[0] || 'Times New Roman');
  const textColor = (i) => (i != null && i >= 0 && i < st.textColors.length ? hex(finalColor(st.textColors[i], st.textColors[i], st.palette)) : null);

  const hasWords = (info) => { if (info.textId == null) return false; const ps = paragraphsFor(info.textId); return !!(ps && ps.some(p => (p.runs || []).some(r => r.text && r.text.trim()))); };
  function paragraphsFor(textId) {
    const t = st.texts.get(textId);
    if (!t) return null;
    const r1 = (x) => Math.round(x * 10) / 10;
    return t.paras.map(p => {
      const ps = p.style || {};
      const dIdx = ps.defaultCharStyle != null ? ps.defaultCharStyle : 0;
      const defPara = st.defaultPara[dIdx] || {};
      const pv = (k) => (ps[k] != null ? ps[k] : defPara[k]);
      const align = pv('align');
      const defChar = st.defaultChar[dIdx] || {};
      const runs = [];
      let markSize = null;
      for (const sp of p.spans) {
        const raw = String.fromCharCode(...sp.chars.filter(c => c !== 0));
        const text = raw.replace(/\r/g, '').replace(/[\u0001-\u0008\u000c\u000e-\u001f]/g, '');
        const cs = sp.style || {};
        const size = Math.round(((cs.size != null ? cs.size : defChar.size) || 10) * 10) / 10;
        if (raw.includes('\r')) markSize = size;
        const ul = cs.underline !== undefined ? cs.underline : (defChar.underline || null);
        const ss = cs.superSub != null ? cs.superSub : defChar.superSub;
        const run = {
          text,
          font: fontName(cs.font != null ? cs.font : defChar.font),
          size,
          bold: !!cs.bold !== !!defChar.bold,
          italic: !!cs.italic !== !!defChar.italic,
          underline: ul || false,
          color: textColor(cs.color != null ? cs.color : defChar.color) || '#000000',
          allCaps: !!(cs.allCaps || defChar.allCaps),
        };
        if (cs.smallCaps || defChar.smallCaps) run.smallCaps = true;
        { // Character spacing: Publisher's Scaling stretches the glyphs, Tracking opens the letters. Approximated as extra letter-spacing so line breaks stay close.
          const sc = cs.scaling != null ? cs.scaling : defChar.scaling, tr = cs.tracking != null ? cs.tracking : defChar.tracking;
          let extra = 0;
          if (sc && Math.abs(sc - 100) > 0.5) extra += (sc / 100 - 1) * 0.38 * size;
          if (tr && Math.abs(tr - 100) > 0.5) extra += (tr / 100 - 1) * 0.25 * size;
          if (Math.abs(extra) > 0.02) run.tracking = Math.round(extra * 100) / 100;
        }
        if (ss === 1) run.script = 'super'; else if (ss === 2) run.script = 'sub';
        runs.push(run);
      }
      // Drop the paragraph mark-only run at the end
      while (runs.length > 1 && runs[runs.length - 1].text === '') runs.pop();
      const sb = pv('spaceBefore'), sa = pv('spaceAfter');
      const lsSp = pv('lineSpacingSp'), lsPt = pv('lineSpacingPt');
      const dl = pv('dropLines');
      const out = {
        align: align === 2 ? 'center' : align === 1 ? 'right' : (align === 6 || align === 3) ? 'justify' : 'left',
        spaceBefore: sb ? r1(emuToPt(sb)) : 0,
        spaceAfter: sa ? r1(emuToPt(sa)) : 0,
        lineSpacing: lsSp && Math.abs(lsSp - 1) > 0.01 ? Math.round(lsSp * 100) / 100 : null,
        runs,
      };
      if (lsPt) out.lineSpacingPt = r1(lsPt);
      const fi = pv('firstIndent'), li = pv('leftIndent'), ri = pv('rightIndent');
      if (fi) out.firstIndent = r1(emuToPt(fi));
      if (li) out.leftIndent = r1(emuToPt(li));
      if (ri) out.rightIndent = r1(emuToPt(ri));
      if (dl && dl > 1) {
        const df = pv('dropFont');
        out.dropCap = { lines: dl, letters: pv('dropLetters') || 1, font: df != null ? fontName(df) : null };
      }
      { const tb = pv('tabs'); if (tb && tb.length) out.tabs = tb.map(e => r1(emuToPt(e))); }
      if (markSize) out.markSize = markSize;
      { // Bullet character at the start of the paragraph, set in the symbol font when the code is in the private-use area (Wingdings etc.)
        const li2 = pv('listInfo');
        if (li2 && li2.p0 === 0 && li2.p1 === 0 && runs.length && runs.some(r => r.text)) {   // ListType 0 = numbered (COM: Bulletin 2009 item 2 -> "2.")
          const first = runs.find(r => r.text) || runs[0];
          runs.unshift(Object.assign({}, first, { text: (pv('listStart') || 1) + '.\t', underline: false, bold: false, italic: false }));
        } else if (li2 && li2.p0 === 23 && li2.p1 && runs.length && runs.some(r => r.text)) {
          const first = runs.find(r => r.text) || runs[0];
          // A code in 0x80-0xFF is a symbol-font code (Word-style bullets: 0xB7 and 0xA8 in Symbol, 0xA7 and 0xD8 in Wingdings). The file
          // doesn't say which font, so use the symbol font the document itself lists (Baptism 1 lists Symbol and shows 0xA8 as a diamond).
          const symFont = /^wingdings/i.test(first.font || '') ? first.font : (st.fonts.some(f => /^wingdings$/i.test(f)) && !st.fonts.some(f => /^symbol$/i.test(f)) ? 'Wingdings' : 'Symbol');
          const isSym = li2.p1 >= 0xF000 || (li2.p1 >= 0x80 && li2.p1 <= 0xFF && !PS_SYMBOL_RE.test(first.font || ''));
          const code = li2.p1 >= 0x80 && li2.p1 <= 0xFF ? 0xF000 + li2.p1 : li2.p1;
          runs.unshift(Object.assign({}, first, { text: String.fromCharCode(code) + '\t', underline: false, bold: false, italic: false, font: li2.p1 >= 0xF000 ? 'Wingdings' : (isSym ? symFont : first.font) }));
        }
      }
      return out;
    });
  }

  function imageName(idx) {
    const img = st.images[idx - 1];
    if (!img) return null;
    const name = `img${idx}.${img.ext}`;
    if (!usedImages.has(name)) { images[name] = img; usedImages.add(name); }
    return name;
  }

  const textUse = new Map();
  for (const i of st.shapes.values()) if (i && i.textId != null && i.coords && !i.table) textUse.set(i.textId, (textUse.get(i.textId) || 0) + 1);
  function toObjects(seq, out) {
    const info = st.shapes.get(seq);
    if (!info || !info.coords) { if (info && info.textId == null && !info.image) return; if (!info || !info.coords) { skipped++; return; } }
    const a = info.coords;
    const left = pt(Math.min(a.xs, a.xe), 'x'), top = pt(Math.min(a.ys, a.ye), 'y');
    const width = Math.abs(a.xe - a.xs) / EMU * 72, height = Math.abs(a.ye - a.ys) / EMU * 72;
    const base = { name: '', left, top, width, height, rotation: info.rotation || 0, layoutFlags: info.layoutFlags };
    if (info.borderArtIdx != null && st.borderArts[info.borderArtIdx] && st.borderArts[info.borderArtIdx].pieces.some(Boolean)) {
      const art = st.borderArts[info.borderArtIdx], pic = borderArtSvg(art);
      if (info.borderArtColor != null) { const bc = info.borderArtTint != null ? hex(finalColor(info.borderArtColor, info.borderArtTint, st.palette)) : color(info.borderArtColor); if (bc && bc !== '#000000') pic.svg = pic.svg.split('#000000').join(bc); }
      base.borderArt = { type: 'pub', name: art.name, svg: pic.svg, slice: pic.slice, repeatH: pic.repeatH, repeatV: pic.repeatV, size: Math.max(1, info.line && info.line.width ? info.line.width / 12700 : art.dims[0] / 12700) };
    }
    // Publisher's shape shadow is cast only by a shape's fill and outline (or a picture), never by the
    // text inside it, so a text box with no fill and no line shows no shadow there.
    if (info.shadow && (info.fill != null || info.gradient || info.fillImage || info.line || info.image))
      base.shadow = Object.assign({}, info.shadow, { color: color(info.shadow.color) });
    const fill = { visible: info.fill != null, color: color(info.fill), transparency: info.fillOpacity != null ? 1 - info.fillOpacity : 0 };
    if (info.gradient) {
      // Office angles turn the gradient counter-clockwise from "top to bottom"
      fill.gradient = { type: info.gradient.type, angle: (90 - info.gradient.angle + 360) % 360,
        stops: info.gradient.stops.map((x, i, arr) => [Math.max(0, Math.min(1, x.p)), (((x.c >>> 24) & 0xff) === 0x10 ? hex(finalColor(info.gradient.base, x.c, st.palette)) : color(x.c)),   // 0x10......: a darker/lighter tint of the fill colour (was read as a colour of its own: magenta)
        i === arr.length - 1 && info.gradient.backOpacity != null ? info.gradient.backOpacity : (info.fillOpacity != null ? info.fillOpacity : 1)]) };
    }
    const line = info.line ? { visible: true, color: color(info.line.color), weight: Math.round(emuToPt(info.line.width) * 100) / 100, dash: info.dash || 'solid', beginArrow: !!info.arrowStart, endArrow: !!info.arrowEnd } : { visible: false };

    // Tables → one text box per cell with a thin border
    if (info.table && info.textId != null) {
      const t = st.texts.get(info.textId);
      const cells = (st.tableCells && st.tableCells.get(info.table.cellsSeq)) || [];
      const allParas = paragraphsFor(info.textId) || [];
      const ends = (t && t.cellEnds) || [];
      // Map paragraphs to cells the way Publisher counts characters (as libmspub does)
      const cellParaRanges = [];
      let offset = 1, firstPara = 0;
      const rawParas = t ? t.paras : [];
      for (let pi2 = 0; pi2 < rawParas.length && cellParaRanges.length < ends.length; pi2++) {
        offset += rawParas[pi2].spans.reduce((n, s2) => n + s2.chars.length, 0);
        if (offset >= ends[cellParaRanges.length]) { cellParaRanges.push([firstPara, pi2]); firstPara = pi2 + 1; }
      }
      const colX = [0], rowY = [0];
      info.table.widths.forEach(w => colX.push(colX[colX.length - 1] + emuToPt(w)));
      info.table.heights.forEach(h => rowY.push(rowY[rowY.length - 1] + emuToPt(h)));
      cells.forEach((c, ci) => {
        const range = cellParaRanges[ci];
        const cellParas = range ? allParas.slice(range[0], range[1] + 1) : [];
        const r0 = c.r0 || 0, r1 = c.r1 != null ? c.r1 : r0, c0 = c.c0 || 0, c1 = c.c1 != null ? c.c1 : c0;
        const cx = colX[Math.min(c0, colX.length - 1)], cw = (colX[Math.min(c1 + 1, colX.length - 1)] || cx) - cx;
        const cy = rowY[Math.min(r0, rowY.length - 1)], chh = (rowY[Math.min(r1 + 1, rowY.length - 1)] || cy) - cy;
        const m = c.margins || [];
        const margins = [m[1], m[2], m[3], m[0]].map((x, k) => (x != null ? emuToPt(x) : [2.88, 3.6, 2.88, 3.6][k]));
        out.push({
          kind: 'text', name: 'Table cell', left: left + cx, top: top + cy, width: Math.max(4, cw), height: Math.max(4, chh), rotation: 0,
          fill: (info.cellFills && info.cellFills[ci]) ? { visible: true, color: color(info.cellFills[ci].color) || '#ffffff', transparency: Math.round((1 - info.cellFills[ci].opacity) * 100) / 100 } : { visible: false },
          line: { visible: false },
          text: { margins, valign: (c.valign & 0xff) === 1 ? 'middle' : (c.valign & 0xff) === 2 ? 'bottom' : 'top', columns: 1, paras: cellParas.length ? cellParas : [{ align: 'left', runs: [] }] },
        });
      });
      // Table borders: outside edges and the lines between rows / columns
      const tl = info.tableLines;
      if (tl) {
        const side = (base) => {
          const c = tl.tert.get(base);
          if (c == null) return null;
          // The table frame's own line width is usually 0; the grid uses the border width, or the grid lines' width
          // ...or, when the table's grid is stored as drawn line shapes (November calendar), their thickness
          const gridW = (info.gridAcross || info.gridDown) && info.gridWidth ? info.gridWidth : 0;   // 1.0.09: when the grid is stored as drawn line shapes, THEIR width is the border (verse registry 0.5 pt, missions notes 1 pt); the table's own 2 pt frame width and the zero outer widths are placeholders
          const wv = gridW ? gridW : (tl.tert.has(base + 0xb) ? tl.tert.get(base + 0xb) : (tl.width || 0));   // the table's own line width; none at all = no border (Bulletin 2009's table has neither and Publisher draws no lines; 10-18-20's has 0.5 pt and draws the row lines, not the column lines)
          if (!wv) return null;
          return { visible: true, color: color(info.gridColor != null ? info.gridColor : c) || '#000000', weight: (emuToPt(wv) > 8 ? 0.75 : Math.round(emuToPt(wv) * 100) / 100), dash: 'solid' };   // wider than 8 pt on a table is BorderArt's band width (not decoded yet): a hairline, not a black slab
        };
        const W2 = colX[colX.length - 1], H2 = rowY[rowY.length - 1];
        const seg = (ln, x1, y1, x2, y2) => { if (ln) out.push({ kind: 'line', name: 'Table border', left: Math.min(x1, x2), top: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1), rotation: 0, x1, y1, x2, y2, line: ln }); };
        const outerOk = !(info.gridAcross || info.gridDown) || (info.gridAcross && info.gridDown);   // row lines only (10-18-20): no outer frame
        if (outerOk) {
        seg(side(0x0580), left, top, left + W2, top);
        seg(side(0x0600), left, top + H2, left + W2, top + H2);
        seg(side(0x0540), left, top, left, top + H2);
        seg(side(0x05C0), left + W2, top, left + W2, top + H2);
        }
        const inH = side(0x0640), inV = side(0x0680) || (info.gridDown ? side(0x0640) : null);   // drawn down lines use the across lines' style
        for (let k = 1; k < rowY.length - 1; k++) seg(inH, left, top + rowY[k], left + W2, top + rowY[k]);
        for (let k = 1; k < colX.length - 1; k++) seg(inV, left + colX[k], top, left + colX[k], top + H2);
      }
      return;
    }

    let overFill = false;
    if (info.fillTiled && !info.image) {
      const tname = imageName(info.fillImage);
      if (tname) {
        const tb = images[tname] && images[tname].data;
        // tile size = pixels at the picture's own resolution (JFIF density / PNG pHYs; 96 dpi when it has none)
        let dpi = 96;
        if (tb) {
          if (tb[0] === 0xFF && tb[1] === 0xD8 && tb.toString('latin1', 6, 10) === 'JFIF' && tb[13] > 0 && tb[13] < 3) { const xd = tb.readUInt16BE(14); if (xd > 1) dpi = tb[13] === 1 ? xd : xd * 2.54; }
          else if (tb[0] === 0x89 && tb[1] === 0x50) { let o3 = 8; while (o3 + 12 <= tb.length) { const l = tb.readUInt32BE(o3), ty = tb.toString('latin1', o3 + 4, o3 + 8); if (ty === 'pHYs') { const ppm = tb.readUInt32BE(o3 + 8); if (ppm > 0) dpi = ppm * 0.0254; break; } if (ty === 'IDAT') break; o3 += 12 + l; } }
        }
        out.push(Object.assign({}, base, { kind: 'shape', shape: 'rect', fill, line, radius: 0, fillTile: { image: tname, dpi: Math.round(dpi * 10) / 10 } }));
        // A text box with a texture fill: the texture is the object above, its words follow as a clear text box on top
        // (the words were dropped before: Missions Bookmarks).
        if (!hasWords(info)) return;
        overFill = true;
      }
    }
    if (!overFill && (info.image || info.fillImage)) {
      const name = imageName(info.image || info.fillImage);
      if (!name) { skipped++; return; }
      const frame = info.cropType === 3 ? 'ellipse' : info.cropType === 2 ? 'roundrect' : null;
      const pa = info.picAdjust;
      let adjust = null;
      if (pa) {
        if (Math.abs(pa.contrast - 0.3) < 0.01 && Math.abs(pa.brightness - 0.35) < 0.01) adjust = { recolor: { kind: 'washout' } };
        else if (Math.abs(pa.contrast - 1) > 0.01 || Math.abs(pa.brightness) > 0.005) {
          const sl = pa.contrast; adjust = { contrast: Math.round(sl >= 1 ? (sl - 1) / 2 * 100 : (sl - 1) * 100), brightness: Math.round(pa.brightness / 0.6 * 100) };
        }
      }
      if (info.picRecolor != null) adjust = Object.assign(adjust || {}, { recolor: { kind: 'duo', color: color(info.picRecolor), washout: !!(adjust && adjust.recolor && adjust.recolor.kind === 'washout') } });   // Recolor + Washout can be combined (Cantata crown)
      if (info.picOpacity != null) adjust = Object.assign(adjust || {}, { transparency: Math.round((1 - info.picOpacity) * 100) });
      // A picture frame's own fill shows wherever the picture is see-through (clip-art WMFs): Meet The Press's purple and
      // black swirl is a black swirl on a purple frame. Drawn as a plain box just beneath the picture.
      if (info.fill != null && fill && fill.visible && fill.color && !info.fillImage && /\.(wmf|emf|png|gif)$/i.test(name))
        out.push(Object.assign({}, base, { kind: 'shape', shape: frame === 'ellipse' ? 'ellipse' : 'rect', fill, line: { visible: false }, radius: 0, name: 'Picture background' }));
      out.push(Object.assign(base, { kind: 'picture', image: name, crop: info.crop || null, flipH: info.flipH, flipV: info.flipV, line, frame }, adjust ? { adjust } : {}));
      return;
    }
    if (LINE_TYPES.has(info.escherType)) {
      let x1 = left, y1 = top, x2 = left + width, y2 = top + height;
      if (info.flipH) [x1, x2] = [x2, x1];
      if (info.flipV) [y1, y2] = [y2, y1];
      if (info.rotation) {
        // Lines carry no rotation of their own in PageStudio: turn the end points instead
        const cx = left + width / 2, cy = top + height / 2, r = info.rotation * Math.PI / 180, c = Math.cos(r), sn = Math.sin(r);
        const rot = (x, y) => [cx + (x - cx) * c - (y - cy) * sn, cy + (x - cx) * sn + (y - cy) * c];
        [x1, y1] = rot(x1, y1); [x2, y2] = rot(x2, y2);
        base.rotation = 0;
      }
      out.push(Object.assign(base, { kind: 'line', x1, y1, x2, y2, line: info.line ? line : { visible: true, color: '#000000', weight: 0.75, dash: 'solid' } }));
      return;
    }
    const paras = info.textId != null ? paragraphsFor(info.textId) : null;
    // In Publisher a shape is rotated first and then flipped. Flip Vertical mirrors the angle and turns the text over, so the
    // angle the text is actually drawn at is 180 minus the stored one: 180 + flipped stays upright (a name-and-address box),
    // 270 + flipped still reads bottom to top (checked against Publisher's own PDF of the Promotional Flier).
    if (paras && info.flipV && !info.image) base.rotation = (((180 - (base.rotation || 0)) % 360) + 360) % 360;
    // The first box of a chain carries no index of its own: it is linked when other boxes share its story (Most Surely
    // Believed tract: box 1 showed the whole story and every other box ran one box behind).
    const linked = info.chainPrev != null || info.chainNext != null || info.chainIndex != null || (info.textId != null && (textUse.get(info.textId) || 0) > 1 && !info.table);
    // Whether this box's text flows around pictures and shapes in front of it (both low bits set).
    // Boxes without them let objects sit on top of their text.
    const wrapAround = info.layoutFlags != null ? (info.layoutFlags & 3) === 3 : null;
    // Text sits inside the border: a border pattern's width is added to the text margins (Missions Bookmark: Publisher's text
    // started about 3 pt further in on every side and wrapped sooner).
    const artInset = base.borderArt && base.borderArt.size ? base.borderArt.size : 0;
    const baseMargins = info.margins || [2.88, 2.88, 2.88, 2.88];
    const textInfo = paras ? {
      wrapAround,
      chain: linked ? { id: info.textId, index: info.chainIndex || 0 } : null, margins: artInset ? baseMargins.map(m => m + artInset) : baseMargins, valign: info.valign === 1 ? 'middle' : info.valign === 2 ? 'bottom' : 'top', columns: info.columns || 1, columnGap: info.columnGap, paras } : null;
    if (info.wordArt && info.wordArt.text) {
      out.push(Object.assign(base, { kind: 'shape', shape: 'wordart', fill, line, radius: 0, wordArt: Object.assign({ preset: info.escherType }, info.wordArt) }));
      return;
    }
    const kind = SHAPE_KIND[info.escherType];
    if (kind && !(TEXT_TYPES.has(info.escherType) && info.escherType !== 1)) {
      if (kind === 'rect' && paras) {
        out.push(Object.assign(base, { kind: 'text', fill: overFill ? { visible: false, color: null, transparency: 0 } : fill, line: overFill ? { visible: false } : line, text: textInfo }));
      } else {
        const radius = kind === 'roundrect' ? (info.adjust1 != null ? info.adjust1 / 21600 : 0.1667) * Math.min(width, height) : 0;
        out.push(Object.assign(base, { kind: 'shape', shape: kind, fill, line, radius, text: textInfo }));
      }
      return;
    }
    if (paras || info.escherType === 202) {
      out.push(Object.assign(base, { kind: 'text', fill: overFill ? { visible: false, color: null, transparency: 0 } : fill, line: overFill ? { visible: false } : line, text: textInfo || { margins: [2.88, 2.88, 2.88, 2.88], valign: 'top', columns: 1, paras: [] } }));
      return;
    }
    // Custom/freeform shapes PageStudio can't redraw: keep their box with fill and outline
    if (info.path && info.path.cmds.length) {
      out.push(Object.assign(base, { kind: 'shape', shape: 'custom', fill, line, path: info.path, radius: 0 }));
      return;
    }
    if (info.fill != null || info.line) {
      out.push(Object.assign(base, { kind: 'shape', shape: 'rect', fill, line, note: 'custom shape' }));
      return;
    }
    skipped++;
  }

  let groupCounter = 0;
  function collect(el, out, groupId) {
    if (el.group) {
      // Publisher groups stay together in PageStudio (the outermost group wins)
      const gid = groupId || ('g' + (++groupCounter));
      const start = out.length;
      for (const c of el.children) collect(c, out, gid);
      // A rotated group turns everything in it about the group's centre (children are stored in the group's unrotated frame)
      const gi = el.seq != null ? st.shapes.get(el.seq) : null;
      if (gi && gi.rotation && gi.coords) {
        const gx = pt((gi.coords.xs + gi.coords.xe) / 2, 'x'), gy = pt((gi.coords.ys + gi.coords.ye) / 2, 'y');
        const r = gi.rotation * Math.PI / 180, cs = Math.cos(r), sn = Math.sin(r);
        const turn = (x, y) => [gx + (x - gx) * cs - (y - gy) * sn, gy + (x - gx) * sn + (y - gy) * cs];
        for (let i = start; i < out.length; i++) {
          const o = out[i];
          if (o.kind === 'line' && o.x1 != null) {
            [o.x1, o.y1] = turn(o.x1, o.y1); [o.x2, o.y2] = turn(o.x2, o.y2);
            o.left = Math.min(o.x1, o.x2); o.top = Math.min(o.y1, o.y2); o.width = Math.abs(o.x2 - o.x1); o.height = Math.abs(o.y2 - o.y1);
          } else {
            const [nx, ny] = turn(o.left + o.width / 2, o.top + o.height / 2);
            o.left = nx - o.width / 2; o.top = ny - o.height / 2;
            o.rotation = ((((o.rotation || 0) + gi.rotation) % 360) + 360) % 360;
          }
        }
      }
      if (!groupId && out.length - start < 2) for (let i = start; i < out.length; i++) delete out[i].groupId;
      return;
    }
    const start = out.length;
    toObjects(el.seq, out);
    if (groupId) for (let i = start; i < out.length; i++) out[i].groupId = groupId;
  }

  // Which page each top-level element belongs to
  const pageOf = (el) => {
    const seq = el.seq;
    const info = seq != null ? st.shapes.get(seq) : null;
    if (info && info.page != null) return info.page;
    if (el.group) for (const c of el.children) { const p = pageOf(c); if (p != null) return p; }
    // Not in any page's own list: the shape's chunk still names its page (Wednesday Prayer List's flag belongs to page 2 this
    // way; the old months parked in the 2016-18 calendars belong to a hidden special page and must not be drawn).
    if (info && info.chunkParent && st.pageOrder.includes(info.chunkParent)) { info.viaParent = true; return info.chunkParent; }
    return null;
  };

  const byPage = new Map();
  const unplaced = [];
  const viaPage = new Map();   // shapes whose page is known only from their chunk's parent
  const cornerOf = (el) => {
    const info = el.seq != null ? st.shapes.get(el.seq) : null;
    if (info && info.corner != null) return info.corner;
    if (el.group) for (const c of el.children) { const k = cornerOf(c); if (k != null) return k; }
    return 0;
  };
  const bgObjs = [];
  const bgSeqs = new Set(Array.from(st.pages.values()).map(p => p.bg).filter(x => x != null));
  for (const el of st.topLevel) {
    if (el.seq != null && bgSeqs.has(el.seq)) {
      // A page's background shape: a plain colour is the page's background colour; a gradient, texture or picture is kept as
      // the bottom object of that page (it used to land on top of everything: New Testament Covers, verse cards).
      const bi = st.shapes.get(el.seq) || {};
      if (bi.gradient || bi.fillImage || bi.image) {
        const outB = []; collect(el, outB);
        for (const pg of st.pages.values()) if (pg.bg === el.seq) bgObjs.push({ seq: pg.seq, objs: outB.map(o => Object.assign({}, o)) });
      }
      continue;
    }
    const p = pageOf(el);
    const out = [];
    collect(el, out);
    const corner = cornerOf(el);
    out.forEach(o => { o._corner = corner; });
    const viaInfo = el.seq != null ? st.shapes.get(el.seq) : null;
    const via = !!(viaInfo && viaInfo.viaParent);
    if (p == null) { out.forEach(o => { o._src = 'u'; }); unplaced.push(...out); }
    else if (via) { out.forEach(o => { o._src = 'u'; }); if (!viaPage.has(p)) viaPage.set(p, []); viaPage.get(p).push(...out); }
    else { if (!byPage.has(p)) byPage.set(p, []); byPage.get(p).push(...out); }
  }

  const pagesAll = Array.from(st.pages.values());
  // Files from Publisher 2002-2007 don't flag the master page; a page that other pages name as their master is one.
  for (const p of pagesAll) { if (p.master != null && p.master !== p.seq) { const mp = st.pages.get(p.master); if (mp) mp.isMaster = true; } }
  const masters = pagesAll.filter(p => p.isMaster);
  // The document's page list holds the master page(s), then the real pages, then four special
  // pages Publisher keeps for itself. The first special page is the scratch area.
  const orderAll = (st.pageOrder.length ? st.pageOrder : pagesAll.map(p => p.seq)).filter(seq => !(st.pages.get(seq) || {}).isMaster);
  const specialCount = orderAll.length >= 5 ? 4 : Math.max(0, orderAll.length - 1);
  const special = orderAll.slice(orderAll.length - specialCount);
  const scratchSeq = special[0];
  const normal = orderAll.slice(0, orderAll.length - specialCount).map(seq => st.pages.get(seq)).filter(Boolean);
  if (!normal.length) { const first = orderAll.map(q => st.pages.get(q)).find(Boolean); if (first) normal.push(first); }
  // Use the master page applied most often
  const counts = new Map();
  normal.forEach(p => { if (p.master != null) counts.set(p.master, (counts.get(p.master) || 0) + 1); });
  let masterSeq = null;
  for (const [k, n] of counts) if (masterSeq == null || n > counts.get(masterSeq)) masterSeq = k;
  if (masterSeq == null && masters.length) masterSeq = masters[0].seq;

  const bgOf = (page) => {
    if (!page || page.bg == null) return null;
    const info = st.shapes.get(page.bg);
    return info && info.fill != null ? color(info.fill) : null;
  };

  // Scratch-area positions are measured from a page corner rather than the page centre (so they stay
  // put beside the page if its size changes); move each item to its corner.
  const toCorner = (objs) => {
    for (const o of objs) {
      const k = o._corner || 0;
      const dx = (k & 1 ? W / 2 : -W / 2) * 72, dy = (k & 2 ? H / 2 : -H / 2) * 72;
      o.left += dx; o.top += dy;
      if (o.kind === 'line') { o.x1 += dx; o.x2 += dx; o.y1 += dy; o.y2 += dy; }
    }
    return objs;
  };
  for (const b of bgObjs) { if (!byPage.has(b.seq)) byPage.set(b.seq, []); byPage.get(b.seq).unshift(...b.objs); }
  let scratch = [...unplaced];
  let hiddenCount = 0;
  for (const [seq, objs] of viaPage) {
    const pg = normal.find(p => p.seq === seq);
    if (pg) {
      // positions are on the shared canvas, measured from page 1
      const o1 = normal[0].origin, dx = o1 && pg.origin ? (pg.origin.x - o1.x) / EMU * 72 : 0, dy = o1 && pg.origin ? (pg.origin.y - o1.y) / EMU * 72 : 0;
      for (const o of objs) { o.left -= dx; o.top -= dy; if (o.kind === 'line') { o.x1 -= dx; o.x2 -= dx; o.y1 -= dy; o.y2 -= dy; } delete o._src; }
      if (!byPage.has(seq)) byPage.set(seq, []);
      byPage.get(seq).push(...objs);
    } else if (seq === scratchSeq) scratch.push(...toCorner(objs));
    else hiddenCount += objs.length;   // Publisher's hidden special pages: never shown
  }
  for (const seq of special) {
    if (!byPage.has(seq) || normal.some(p => p.seq === seq)) continue;
    scratch.push(...toCorner(byPage.get(seq)));
  }
  void scratchSeq;
  const strip = (objs) => objs.forEach(o => { delete o._corner; });
  strip(scratch); for (const objs of byPage.values()) strip(objs);

  // Only shapes that belong to no page at all are candidates; the scratch page's own contents (the clutter beside bulletins)
  // stay on the scratch area even when their shared-canvas position falls inside a neighbouring page.
  // Publisher lays its pages and the scratch area on one shared canvas (page origins from page block 0x05). Anything that sits
  // in the scratch list but overlaps a page's rectangle is really drawn ON that page (checked with Publisher COM + its PNG:
  // Wednesday Prayer List's flag and crosses sit at Left -295 / -189 / -185 = page 2, which starts 792 pt left of page 1).
  if (normal.length && normal[0].origin) {
    const o1 = normal[0].origin, keep = [];
    for (const o of scratch) {
      let hit = null;
      if (o._src !== 'u') { keep.push(o); continue; }
      for (const p of normal) {
        if (!p.origin) continue;
        const dx = (p.origin.x - o1.x) / EMU * 72, dy = (p.origin.y - o1.y) / EMU * 72;
        const w = o.width || 0, h = o.height || 0;
        if (o.left < dx + W * 72 && o.left + w > dx && o.top < dy + H * 72 && o.top + h > dy) { hit = { p, dx, dy }; break; }
      }
      if (!hit) { keep.push(o); continue; }
      o.left -= hit.dx; o.top -= hit.dy;
      if (o.kind === 'line') { o.x1 -= hit.dx; o.x2 -= hit.dx; o.y1 -= hit.dy; o.y2 -= hit.dy; }
      if (!byPage.has(hit.p.seq)) byPage.set(hit.p.seq, []);
      byPage.get(hit.p.seq).push(o);
    }
    scratch = keep;
  }
  scratch.forEach(o => { delete o._src; });

  // Margin and grid guides come from the master page; ruler guides belong to each page
  const toPt = (e) => Math.round(e / EMU * 72 * 100) / 100;
  let margins = null, grid = null;
  const layoutPage = (masterSeq != null && st.pages.get(masterSeq)) || masters[0] || null;
  const lg = layoutPage && layoutPage.layoutRef != null ? st.guides.get(layoutPage.layoutRef) : null;
  if (lg && lg.nx >= 2 && lg.ny >= 2) {
    const xs = lg.pos.slice(0, lg.nx), ys = lg.pos.slice(lg.nx);
    margins = { left: toPt(xs[0]), right: toPt(W * EMU - xs[xs.length - 1]), top: toPt(ys[0]), bottom: toPt(H * EMU - ys[ys.length - 1]) };
    if (Object.values(margins).some(v => !(v >= 0 && v < Math.max(W, H) * 36))) margins = null;
    grid = { cols: Math.max(1, xs.length - 1), rows: Math.max(1, ys.length - 1), gutter: toPt(2 * lg.colHalfGap), rowGutter: toPt(2 * lg.rowHalfGap) };
  }
  const rulerGuides = (page) => {
    const g = page && page.guidesRef != null ? st.guides.get(page.guidesRef) : null;
    if (!g || !g.pos.length) return null;
    return { x: g.pos.slice(0, g.nx).map(toPt), y: g.pos.slice(g.nx).map(toPt) };
  };

  const sheet = st.sheet ? {
    width: toPt(st.sheet.width), height: toPt(st.sheet.height), marginX: toPt(st.sheet.marginX), marginY: toPt(st.sheet.marginY),
    gapX: Math.max(0, toPt(st.sheet.pitchX - W * EMU)), gapY: Math.max(0, toPt(st.sheet.pitchY - H * EMU)),
  } : null;
  const result = {
    source: 'PageStudio reader',
    mailMerge: st.mailMerge ? { path: st.mailMerge.path, table: st.mailMerge.table || null } : null,
    sheet,
    margins,
    grid,
    masterGuides: rulerGuides(layoutPage),
    pageWidth: W * 72,
    pageHeight: H * 72,
    master: masterSeq != null ? (byPage.get(masterSeq) || []) : [],
    scratch,
    pages: normal.map(p => ({ objects: byPage.get(p.seq) || [], background: bgOf(p) || bgOf(st.pages.get(p.master)), useMaster: p.master != null ? p.master === masterSeq : true, guides: rulerGuides(p) })),
    skipped,
  };
  if (!result.pages.length) result.pages.push({ objects: [], background: null, useMaster: true });
  return { data: result, images };
}

module.exports = { readPub, wmfPieceToSvg, borderArtSvg };
