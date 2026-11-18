// Mapbox Vector Tile decoder (spec 2.1). Pure functions, no DOM: usable from Node for testing.
// Returns { layerName: { extent, features: [{ type, props, rings }] } } where rings is an
// array of flat [x0, y0, x1, y1, ...] arrays in tile units. type: 1 point, 2 line, 3 polygon.

const td = new TextDecoder();

class Reader {
  constructor(buf, pos = 0, end = buf.length) { this.b = buf; this.i = pos; this.end = end; this.dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength); }
  varint() {
    let v = 0, mul = 1, c;
    do { c = this.b[this.i++]; v += (c & 0x7f) * mul; mul *= 128; } while (c & 0x80);
    return v;
  }
  svarint() { const v = this.varint(); return v % 2 ? -(v + 1) / 2 : v / 2; }
  bytes() { const n = this.varint(), s = this.i; this.i += n; return [s, this.i]; }
  string() { const [s, e] = this.bytes(); return td.decode(this.b.subarray(s, e)); }
  skip(wt) {
    if (wt === 0) this.varint();
    else if (wt === 1) this.i += 8;
    else if (wt === 2) this.i += this.varint();
    else if (wt === 5) this.i += 4;
    else throw new Error('bad wire type');
  }
  packed() {
    const [s, e] = this.bytes();
    const out = [];
    const r = new Reader(this.b, s, e);
    while (r.i < e) {
      out.push(r.varint());
    }
    return out;
  }
}

function readValue(r, end) {
  let v = null;
  while (r.i < end) {
    const k = r.varint(), f = k >> 3;
    if (f === 1) v = r.string();
    else if (f === 2) { v = r.dv.getFloat32(r.i, true); r.i += 4; }
    else if (f === 3) { v = r.dv.getFloat64(r.i, true); r.i += 8; }
    else if (f === 4 || f === 5) v = r.varint();
    else if (f === 6) v = r.svarint();
    else if (f === 7) v = r.varint() === 1;
    else r.skip(k & 7);
  }
  return v;
}

const zigzag = (v) => (v % 2 ? -(v + 1) / 2 : v / 2);

function decodeGeometry(cmds) {
  const rings = [];
  let x = 0, y = 0, cur = null;
  for (let i = 0; i < cmds.length;) {
    const c = cmds[i++], id = c & 7, n = c >> 3;
    if (id === 7) continue; // close path: rings are closed by the renderer
    if (id !== 1 && id !== 2) break;
    for (let k = 0; k < n; k++) {
      x += zigzag(cmds[i++]);
      y += zigzag(cmds[i++]);
      if (id === 1) { cur = [x, y]; rings.push(cur); } else cur.push(x, y);
    }
  }
  return rings;
}

function readLayer(r, end) {
  let name = '', extent = 4096;
  const keys = [], values = [], raw = [];
  while (r.i < end) {
    const k = r.varint(), f = k >> 3;
    if (f === 1) name = r.string();
    else if (f === 2) raw.push(r.bytes());
    else if (f === 3) keys.push(r.string());
    else if (f === 4) { const [s, e] = r.bytes(); values.push(readValue(new Reader(r.b, s, e), e)); }
    else if (f === 5) extent = r.varint();
    else r.skip(k & 7);
  }
  const features = raw.map(([s, e]) => {
    const fr = new Reader(r.b, s, e);
    let type = 0, tags = [], geom = [];
    while (fr.i < e) {
      const k = fr.varint(), f = k >> 3;
      if (f === 2) tags = fr.packed();
      else if (f === 3) type = fr.varint();
      else if (f === 4) geom = fr.packed();
      else fr.skip(k & 7);
    }
    const props = {};
    for (let i = 0; i + 1 < tags.length; i += 2) props[keys[tags[i]]] = values[tags[i + 1]];
    return { type, props, rings: decodeGeometry(geom) };
  });
  return { name, extent, features };
}

/** Decode a whole tile from a Uint8Array. */
export function decodeTile(buf) {
  const r = new Reader(buf);
  const layers = {};
  while (r.i < r.end) {
    const k = r.varint();
    if (k >> 3 === 3) { const [s, e] = r.bytes(); const l = readLayer(new Reader(buf, s, e), e); layers[l.name] = l; }
    else r.skip(k & 7);
  }
  return layers;
}
