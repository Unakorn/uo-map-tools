/* UO Map Image Editor core. Original indexed-plane implementation, November 2026.
 * Provenance: adapts the exact seed matching, binary write gate, selection operations,
 * Liang-Barsky clipping and Bresenham traversal from the user's earlier chrome editor:
 * 2026-11-11/how/outputs/selection-core.cjs and editor-core.cjs. Original files unchanged.
 * This module contains no terrain color blending, automatic tile transitions,
 * dithering, resampling or antialiasing. Its altitude-only gradient writes exact
 * integer shades inside a hard selection. Values remain discrete IDs or shades.
 */
(function (root, factory) {
  const node = typeof module === 'object' && module.exports && typeof require === 'function';
  const api = factory(node ? require('./altitude-smoothing.cjs') : root.MapPaintSmoothing, node ? require('./road-core.cjs') : root.MapPaintRoad, node ? require('./altitude-distortion.cjs') : root.MapPaintDistortion, node ? require('./flatten-core.cjs') : root.MapPaintFlatten);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MapPaintCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Smoothing, Road, Distortion, Flatten) {
  'use strict';
  const UNSET = 65535, PAGE = 4096, MAX_PIXELS = 33554432;
  // Exact target islands; every touching outside pixel, including corners,
  // must have the same single surrounding value. Map edges are not enclosures.
  function surroundedMatches(data,width,height,x,y){
    const seed=y*width+x,target=data[seed],seen=new Uint8Array(data.length),result=new Uint8Array(data.length),queue=new Uint32Array(data.length);
    function island(start){let head=0,tail=1,border=-1,valid=target!==UNSET;queue[0]=start;seen[start]=1;
      while(head<tail){const i=queue[head++],cx=i%width,cy=Math.floor(i/width);
        for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){if(!dx&&!dy)continue;const nx=cx+dx,ny=cy+dy;if(nx<0||ny<0||nx>=width||ny>=height){valid=false;continue;}const n=ny*width+nx,v=data[n];if(v===target){if((!dx||!dy)&&!seen[n]){seen[n]=1;queue[tail++]=n;}}else{if(v===UNSET||border!==-1&&border!==v)valid=false;if(border===-1)border=v;}}
      }return {count:tail,border,valid:valid&&border!==-1};
    }
    const initial=island(seed);if(!initial.valid)throw new Error('Match surroundings needs a patch enclosed by exactly one other color. Mixed borders, unset pixels and map edges do not match.');
    for(let j=0;j<initial.count;j++)result[queue[j]]=1;
    for(let i=0;i<data.length;i++)if(data[i]===target&&!seen[i]){const group=island(i);if(group.valid&&group.border===initial.border)for(let j=0;j<group.count;j++)result[queue[j]]=1;}
    return result;
  }
  const MAGIC = [85, 79, 80, 65, 73, 78, 84, 0]; // UOPAINT\0; reads v1/v2, writes v2
  const MAX_SELECTION_SNAPSHOTS = 256, MAX_SELECTION_SNAPSHOT_BYTES = 64 * 1024 * 1024;
  const MAX_PROJECT_BYTES = 32 + MAX_PIXELS * 4 + Math.ceil(MAX_PIXELS / 8) + 24 + MAX_SELECTION_SNAPSHOT_BYTES;
  const SNAPSHOT_STATE = new WeakMap(), SNAPSHOT_MAGIC = [83, 78, 65, 80]; // SNAP
  const BYTE_COUNTS = new Uint8Array(256);
  for (let i = 1; i < BYTE_COUNTS.length; i++) BYTE_COUNTS[i] = BYTE_COUNTS[i >> 1] + (i & 1);
  const LAYERS = ['terrain', 'altitude'];
  // Preview pixels and their source snapshots stay private. A UI cannot turn a
  // reviewed preview into a different edit by modifying an exposed typed array.
  const LANDFORM_PLANS = new WeakMap();
  const RAMP_SESSIONS = new WeakMap(), MAX_RAMP_PIXELS = 2097152, MAX_RAMP_POINTS = 100000;
  const SELECTION_STROKES = new WeakMap(), MAX_SELECTION_STROKE_PIXELS = 2097152,
    MAX_SELECTION_STROKE_POINTS = 100000, MAX_SELECTION_STROKE_WORK = 134217728;
  function integer(value, min, max, name) {
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new RangeError(`${name} must be an integer from ${min} to ${max}`);
    return value;
  }
  function dimensions(width, height) {
    integer(width, 1, 8192, 'width'); integer(height, 1, 8192, 'height');
    if (width * height > MAX_PIXELS) throw new RangeError(`At most ${MAX_PIXELS} pixels are supported`);
    return width * height;
  }
  function layerName(layer) { if (!LAYERS.includes(layer)) throw new RangeError('Layer must be terrain or altitude'); return layer; }
  function paletteOf(palette) {
    const entries = Array.isArray(palette) ? palette : palette && palette.materials;
    if (!Array.isArray(entries) || entries.length === 0) throw new TypeError('palette must be a nonempty materials array');
    const byId = new Map(), byRGB = new Map(), ambiguous = new Set();
    for (const item of entries) {
      const id = integer(item.id === undefined ? item.Id : item.id, 0, 65534, 'material id');
      if (byId.has(id)) throw new RangeError(`Duplicate material ID ${id}`);
      const color = item.color || item.Color;
      const rgb = [item.r, item.g, item.b].map((v, i) => integer(v === undefined && Array.isArray(color) ? color[i] : v, 0, 255, 'palette channel'));
      const key = (rgb[0] << 16) | (rgb[1] << 8) | rgb[2];
      const material = Object.freeze({ id, name: item.name || item.Name || String(id), tileId: item.tileId, r: rgb[0], g: rgb[1], b: rgb[2], rgb: key });
      byId.set(id, material);
      if (byRGB.has(key)) ambiguous.add(key); else byRGB.set(key, id);
    }
    return { byId, byRGB, ambiguous, entries: Array.from(byId.values()) };
  }
  // Adapted from editorClipLine: clip huge off-canvas segments before raster traversal.
  function clipLine(x0, y0, x1, y1, minX, minY, maxX, maxY) {
    const dx = x1 - x0, dy = y1 - y0; let first = 0, last = 1;
    for (const [p, q] of [[-dx, x0 - minX], [dx, maxX - x0], [-dy, y0 - minY], [dy, maxY - y0]]) {
      if (p === 0) { if (q < 0) return null; continue; }
      const ratio = q / p;
      if (p < 0) first = Math.max(first, ratio); else last = Math.min(last, ratio);
      if (first > last) return null;
    }
    return [Math.round(x0 + first * dx), Math.round(y0 + first * dy), Math.round(x0 + last * dx), Math.round(y0 + last * dy)];
  }
  // Iterative exact selection, four-connected unless diagonal is explicitly enabled.
  // Adapted from selectPixels. Scanline
  // seeds avoid a width*height Uint32 queue for a typical contiguous full-map region.
  function connected(plane, width, height, x, y, allowed, diagonal = false) {
    const count = width * height, visited = new Uint8Array(count), seed = y * width + x, value = plane[seed];
    if (allowed && !allowed[seed]) return visited;
    let stack = new Uint32Array(Math.min(count, 1024)), length = 0;
    const matches = i => !visited[i] && (!allowed || allowed[i] === 1) && plane[i] === value;
    const push = i => {
      if (length === stack.length) {
        const grown = new Uint32Array(Math.min(count, stack.length * 2));
        if (grown.length === stack.length) throw new RangeError('Flood work queue exceeded pixel count');
        grown.set(stack); stack = grown;
      }
      stack[length++] = i;
    };
    push(seed);
    while (length) {
      const point = stack[--length]; if (!matches(point)) continue;
      const row = Math.floor(point / width), rowStart = row * width;
      let left = point % width, right = left;
      while (left > 0 && matches(rowStart + left - 1)) left--;
      while (right + 1 < width && matches(rowStart + right + 1)) right++;
      visited.fill(1, rowStart + left, rowStart + right + 1);
      for (const neighborRow of [row - 1, row + 1]) {
        if (neighborRow < 0 || neighborRow >= height) continue;
        let inRun = false;
        const first = diagonal ? Math.max(0, left - 1) : left;
        const last = diagonal ? Math.min(width - 1, right + 1) : right;
        for (let col = first; col <= last; col++) {
          const index = neighborRow * width + col;
          if (matches(index)) { if (!inRun) push(index); inRun = true; } else inRun = false;
        }
      }
    }
    return visited;
  }
  // Exact separable squared Euclidean distance transform. Vertical binary-seed
  // passes feed a lower envelope of horizontal parabolas (Felzenszwalb/Huttenlocher).
  // Uint32 stores exact squared integer distances; full Float64 grids are avoided.
  // Coordinates <=8192 imply squared distances <=2*8191^2, safely below Uint32 max.
  function edgeDistanceSquared(grid, width, height) {
    const infinity = 0x3FFFFFFF;
    for (let x = 0; x < width; x++) {
      let nearest = -height - 1;
      for (let y = 0; y < height; y++) {
        const i = y * width + x;
        if (grid[i] === 0) nearest = y;
        else grid[i] = nearest < 0 ? infinity : (y - nearest) * (y - nearest);
      }
      nearest = height * 2 + 1;
      for (let y = height - 1; y >= 0; y--) {
        const i = y * width + x;
        if (grid[i] === 0) nearest = y;
        else if (nearest < height) grid[i] = Math.min(grid[i], (nearest - y) * (nearest - y));
      }
    }
    const sites = new Int32Array(width), boundaries = new Float64Array(width + 1), values = new Uint32Array(width);
    for (let y = 0; y < height; y++) {
      const row = y * width; values.set(grid.subarray(row, row + width));
      let last = 0; sites[0] = 0; boundaries[0] = -Infinity; boundaries[1] = Infinity;
      for (let q = 1; q < width; q++) {
        let p = sites[last], intersection = ((values[q] + q * q) - (values[p] + p * p)) / (2 * (q - p));
        while (intersection <= boundaries[last]) {
          p = sites[--last]; intersection = ((values[q] + q * q) - (values[p] + p * p)) / (2 * (q - p));
        }
        last++; sites[last] = q; boundaries[last] = intersection; boundaries[last + 1] = Infinity;
      }
      last = 0;
      for (let q = 0; q < width; q++) {
        while (boundaries[last + 1] < q) last++;
        const p = sites[last]; grid[row + q] = (q - p) * (q - p) + values[p];
      }
    }
    return grid;
  }
  function gradientShade(edgeSquared, clickSquared, edgeShade, centerShade) {
    const low = Math.min(edgeShade, centerShade), span = Math.abs(centerShade - edgeShade);
    if (!span) return low;
    // Express either direction as low + span*u, with u increasing from 0 to 1.
    const a = centerShade >= edgeShade ? edgeSquared : clickSquared;
    const b = centerShade >= edgeShade ? clickSquared : edgeSquared;
    let step = Math.round(span * Math.sqrt(a) / (Math.sqrt(a) + Math.sqrt(b)));
    // Correct floating half-unit ties using exact integer comparisons. For
    // q=n/(2*span), sqrt(a)/(sqrt(a)+sqrt(b)) >= q iff a*(2*span-n)^2 >= b*n^2.
    // Max dimensions8192 and span255 keep these integer products below2^53.
    const atLeast = numerator => a * (2 * span - numerator) ** 2 >= b * numerator ** 2;
    if (step > 0 && !atLeast(2 * step - 1)) step--;
    if (step < span && atLeast(2 * step + 1)) step++;
    return low + step;
  }
  function packMask(mask) {
    const flags = new Uint8Array(Math.ceil(mask.length / PAGE)); let bytes = 0;
    for (let page = 0; page < flags.length; page++) {
      const start = page * PAGE, end = Math.min(mask.length, start + PAGE), first = mask[start];
      flags[page] = first;
      for (let i = start + 1; i < end; i++) if (mask[i] !== first) { flags[page] = 2; bytes += Math.ceil((end - start) / 8); break; }
    }
    const bits = new Uint8Array(bytes); let at = 0;
    for (let page = 0; page < flags.length; page++) if (flags[page] === 2) {
      const start = page * PAGE, length = Math.min(PAGE, mask.length - start);
      for (let i = 0; i < length; i++) if (mask[start + i]) bits[at + (i >> 3)] |= 1 << (i & 7);
      at += Math.ceil(length / 8);
    }
    return { flags, bits };
  }
  function unpackMask(packed, count) {
    const mask = new Uint8Array(count); let at = 0;
    for (let page = 0; page < packed.flags.length; page++) {
      const start = page * PAGE, length = Math.min(PAGE, count - start);
      if (packed.flags[page] === 1) mask.fill(1, start, start + length);
      else if (packed.flags[page] === 2) {
        for (let i = 0; i < length; i++) mask[start + i] = (packed.bits[at + (i >> 3)] >> (i & 7)) & 1;
        at += Math.ceil(length / 8);
      }
    }
    return mask;
  }

  function samePackedMask(mask, packed) {
    let at = 0;
    for (let page = 0; page < packed.flags.length; page++) {
      const start = page * PAGE, length = Math.min(PAGE, mask.length - start), flag = packed.flags[page];
      for (let i = 0; i < length; i++)
        if (mask[start + i] !== (flag === 2 ? (packed.bits[at + (i >> 3)] >> (i & 7)) & 1 : flag)) return false;
      if (flag === 2) at += Math.ceil(length / 8);
    }
    return true;
  }
  function selectionChanged(doc) {
    const state = SNAPSHOT_STATE.get(doc); state.selectionRevision++; state.matches.clear();
  }
  function selectionStrokeState(session, owner) {
    const record = SELECTION_STROKES.get(session);
    if (!record || record.owner !== owner) throw new Error('This selection stroke belongs to a different document');
    if (record.finished) throw new Error(`This selection stroke has already been ${record.finished}`);
    owner._idle();
    if (owner.width !== record.width || owner.height !== record.height || owner.currentLayer !== record.layer ||
        owner.selection !== record.selectionRef || owner.selectionActive !== record.beforeActive || owner.selectionRevision !== record.revision)
      throw new Error('The selection stroke is stale; draw again after changing the selection, image layer or document');
    return record;
  }
  function selectionStrokeBase(record, index) {
    if (!record.beforeActive && record.operation === 'add') return false;
    const page = Math.floor(index / PAGE), flag = record.before.flags[page];
    return flag === 2 ? !!(record.before.bits[record.offsets[page] + ((index % PAGE) >> 3)] & (1 << (index & 7))) : flag === 1;
  }
  function selectionStrokeValue(record, index) {
    if (record.operation === 'subtract' && !record.beforeActive) return selectionStrokeBase(record, index);
    const touched = !!(record.touched[index >> 3] & (1 << (index & 7)));
    return touched ? record.operation === 'add' : selectionStrokeBase(record, index);
  }
  function appendSelectionStroke(record, x, y) {
    integer(x, -1000000000, 1000000000, 'Selection stroke x');
    integer(y, -1000000000, 1000000000, 'Selection stroke y');
    if (record.pointCount && x === record.lastX && y === record.lastY) return;
    if (record.pointCount >= MAX_SELECTION_STROKE_POINTS) throw new RangeError('This selection stroke is too long. Release it and start another stroke.');
    const clipped = clipLine(record.lastX, record.lastY, x, y, 0, 0, record.width - 1, record.height - 1);
    const added = [];
    let work = 0;
    if (clipped && (record.operation !== 'subtract' || record.beforeActive)) {
      let [x0, y0, x1, y1] = clipped;
      work = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) + 1;
      if (record.work + work > MAX_SELECTION_STROKE_WORK) throw new RangeError('This selection stroke is too complex. Release it and start another stroke.');
      const dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1, dy = -Math.abs(y1 - y0), sy = y0 < y1 ? 1 : -1;
      let error = dx + dy;
      for (;;) {
        const index = y0 * record.width + x0;
        if (!(record.touched[index >> 3] & (1 << (index & 7)))) added.push(index);
        if (x0 === x1 && y0 === y1) break;
        const twice = error * 2;
        if (twice >= dy) { error += dy; x0 += sx; }
        if (twice <= dx) { error += dx; y0 += sy; }
      }
    }
    if (record.count + added.length > MAX_SELECTION_STROKE_PIXELS) throw new RangeError('A selection stroke can cover at most 2,097,152 pixels. Release it and start another stroke.');
    // Prepare growth before mutating the retained preview. A rejected segment
    // leaves every prior point, bit, bound and history entry untouched.
    if (record.count + added.length > record.indices.length) {
      const size = Math.min(MAX_SELECTION_STROKE_PIXELS, Math.max(record.count + added.length, record.indices.length * 2));
      const next = new Uint32Array(size); next.set(record.indices.subarray(0, record.count)); record.indices = next;
    }
    let left = record.bounds ? record.bounds.left : record.width, top = record.bounds ? record.bounds.top : record.height;
    let right = record.bounds ? left + record.bounds.width - 1 : -1, bottom = record.bounds ? top + record.bounds.height - 1 : -1;
    for (const index of added) {
      record.touched[index >> 3] |= 1 << (index & 7); record.indices[record.count++] = index;
      const px = index % record.width, py = Math.floor(index / record.width);
      left = Math.min(left, px); right = Math.max(right, px); top = Math.min(top, py); bottom = Math.max(bottom, py);
    }
    record.bounds = record.count ? Object.freeze({ left, top, width: right - left + 1, height: bottom - top + 1 }) : null;
    record.work += work; record.pointCount++; record.lastX = x; record.lastY = y;
  }
  function utf8Name(name) {
    if (typeof name !== 'string') throw new TypeError('Selection name must be text');
    name = name.normalize('NFC').trim(); const characters = Array.from(name);
    if (!characters.length || characters.length > 80 || /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/u.test(name))
      throw new RangeError('Selection name must contain 1 to 80 characters without control characters');
    const bytes = [];
    for (const character of characters) {
      const code = character.codePointAt(0);
      if (code >= 0xD800 && code <= 0xDFFF) throw new RangeError('Selection name contains an invalid Unicode character');
      if (code < 0x80) bytes.push(code);
      else if (code < 0x800) bytes.push(0xC0 | (code >> 6), 0x80 | (code & 63));
      else if (code < 0x10000) bytes.push(0xE0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
      else bytes.push(0xF0 | (code >> 18), 0x80 | ((code >> 12) & 63), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
    }
    return { name, nameBytes: Uint8Array.from(bytes) };
  }
  function decodeSnapshotName(bytes) {
    if (!bytes.length || bytes.length > 320) throw new Error('Snapshot name length is invalid');
    let name = '';
    for (let i = 0; i < bytes.length;) {
      const first = bytes[i++]; let code, extra, minimum;
      if (first < 0x80) { code = first; extra = 0; minimum = 0; }
      else if (first >= 0xC2 && first <= 0xDF) { code = first & 31; extra = 1; minimum = 0x80; }
      else if (first >= 0xE0 && first <= 0xEF) { code = first & 15; extra = 2; minimum = 0x800; }
      else if (first >= 0xF0 && first <= 0xF4) { code = first & 7; extra = 3; minimum = 0x10000; }
      else throw new Error('Snapshot name is not valid UTF-8');
      if (i + extra > bytes.length) throw new Error('Snapshot name has truncated UTF-8');
      for (let n = 0; n < extra; n++) {
        const next = bytes[i++]; if ((next & 0xC0) !== 0x80) throw new Error('Snapshot name is not valid UTF-8');
        code = code * 64 + (next & 63);
      }
      if (code < minimum || code > 0x10FFFF || (code >= 0xD800 && code <= 0xDFFF)) throw new Error('Snapshot name is not valid UTF-8');
      name += String.fromCodePoint(code);
    }
    const canonical = utf8Name(name);
    if (canonical.name !== name) throw new Error('Snapshot name must be normalized and trimmed');
    return canonical;
  }
  function snapshotBytes(entry) { return 128 + entry.nameBytes.byteLength + entry.packed.flags.byteLength + entry.packed.bits.byteLength; }
  function snapshotMetadata(entry) { return Object.freeze({ id: entry.id, name: entry.name, selectedPixels: entry.selectedPixels, bytes: entry.bytes }); }
  function snapshotEntry(doc, id) {
    integer(id, 1, 0xFFFFFFFE, 'selection snapshot id');
    const state = SNAPSHOT_STATE.get(doc), index = state.entries.findIndex(entry => entry.id === id);
    if (index === -1) throw new RangeError('That saved selection no longer exists');
    return { state, index, entry: state.entries[index] };
  }
  function validateSnapshotSet(entries) {
    if (entries.length > MAX_SELECTION_SNAPSHOTS) throw new RangeError('At most 256 selections can be saved in one project');
    const ids = new Set(), names = new Set(); let bytes = 0;
    for (const entry of entries) {
      const key = entry.name.toLowerCase();
      if (ids.has(entry.id)) throw new Error('Duplicate selection snapshot ID');
      if (names.has(key)) throw new Error('A saved selection already uses that name');
      ids.add(entry.id); names.add(key); bytes += entry.bytes;
    }
    if (bytes > MAX_SELECTION_SNAPSHOT_BYTES) throw new RangeError('Saved selections exceed the 64 MiB storage budget; delete a saved selection before adding another');
    return bytes;
  }
  function prepareSnapshotChange(state, command, direction) {
    const entries = state.entries.slice(), index = entries.findIndex(entry => entry.id === command.id);
    if (command.action === 'rename') {
      if (index === -1) throw new Error('Saved selection history is inconsistent');
      const entry = { ...entries[index], name: command[direction + 'Name'], nameBytes: command[direction + 'NameBytes'] };
      entry.bytes = snapshotBytes(entry); entries[index] = entry;
    } else {
      const insert = command.action === 'add' ? direction === 'after' : direction === 'before';
      if (insert) {
        if (index !== -1) throw new Error('Saved selection history is inconsistent');
        entries.splice(Math.min(command.index, entries.length), 0, command.entry);
      } else {
        if (index === -1) throw new Error('Saved selection history is inconsistent');
        entries.splice(index, 1);
      }
    }
    return { entries, bytes: validateSnapshotSet(entries) };
  }
  function commitSnapshotChange(state, prepared) {
    state.entries = prepared.entries; state.bytes = prepared.bytes; state.snapshotRevision++; state.matches.clear();
  }
  function validatePackedSnapshot(packed, count, expectedSelected) {
    if (packed.flags.length !== Math.ceil(count / PAGE)) throw new Error('Snapshot page count is invalid');
    let at = 0, selected = 0;
    for (let page = 0; page < packed.flags.length; page++) {
      const length = Math.min(PAGE, count - page * PAGE), flag = packed.flags[page];
      if (flag === 1) selected += length;
      else if (flag === 2) {
        const byteCount = Math.ceil(length / 8); if (at + byteCount > packed.bits.length) throw new Error('Snapshot mask length is invalid');
        let pageSelected = 0;
        for (let i = 0; i < byteCount; i++) pageSelected += BYTE_COUNTS[packed.bits[at + i]];
        if (!pageSelected || pageSelected === length) throw new Error('Snapshot mixed page is not canonical');
        if (length % 8 && (packed.bits[at + byteCount - 1] >> (length % 8))) throw new Error('Snapshot padding bits must be zero');
        selected += pageSelected; at += byteCount;
      } else if (flag !== 0) throw new Error('Snapshot page flag is invalid');
    }
    if (at !== packed.bits.length || selected !== expectedSelected || selected === 0) throw new Error('Snapshot mask length or selected pixel count is invalid');
  }
  function landformOptions(options, x, y) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('Landform options must be an object');
    const mode = options.mode === undefined ? 'mountain' : options.mode;
    if (!['range', 'mountain', 'hills', 'ridge', 'path'].includes(mode)) throw new RangeError('Landform mode must be mountain, hills, ridge or path');
    const slope = options.slope === undefined ? 1 : options.slope;
    if (typeof slope !== 'number' || !Number.isFinite(slope) || slope < 0.1 || slope > 8) throw new RangeError('Slope must be a number from 0.1 to 8');
    const settings = {
      mode, baseZ: integer(options.baseZ === undefined ? 0 : options.baseZ, -128, 127, 'base Z'),
      peakZ: integer(options.peakZ === undefined ? 64 : options.peakZ, -128, 127, 'peak Z'), slope,
      featureSize: integer(options.featureSize === undefined ? 48 : options.featureSize, 1, 8192, 'feature size'),
      roughness: integer(options.roughness === undefined ? 25 : options.roughness, 0, 100, 'roughness'),
      detailScale: integer(options.detailScale === undefined ? 12 : options.detailScale, 1, 8192, 'detail scale'),
      seed: integer(options.seed === undefined ? 1 : options.seed, 0, 4294967295, 'seed')
    };
    if (mode === 'ridge' || mode === 'path') {
      const points = options.points === undefined ? [{ x, y }] : options.points;
      if (!Array.isArray(points) || !points.length || points.length > 100000) throw new RangeError(`A ${mode} needs 1 to 100000 points`);
      settings.points = Object.freeze(points.map(point => {
        if (!point || typeof point !== 'object') throw new TypeError(`${mode === 'path' ? 'Path' : 'Ridge'} points must contain x and y`);
        return Object.freeze({ x: integer(point.x, -1000000000, 1000000000, mode + ' x'), y: integer(point.y, -1000000000, 1000000000, mode + ' y') });
      }));
    }
    return Object.freeze(settings);
  }
  // Seeded continuous value noise, with no random/global state and no table whose
  // size grows with the map. Cubic interpolation gives coherent terrain features.
  function noiseHash(x, y, seed) {
    let n = (seed ^ Math.imul(x, 0x9E3779B1) ^ Math.imul(y, 0x85EBCA77)) >>> 0;
    n = Math.imul(n ^ (n >>> 16), 0x7FEB352D); n = Math.imul(n ^ (n >>> 15), 0x846CA68B);
    return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
  }
  function valueNoise(x, y, scale, seed) {
    const fx = x / scale, fy = y / scale, ix = Math.floor(fx), iy = Math.floor(fy);
    const tx = fx - ix, ty = fy - iy, u = tx * tx * (3 - 2 * tx), v = ty * ty * (3 - 2 * ty);
    const a = noiseHash(ix, iy, seed), b = noiseHash(ix + 1, iy, seed), c = noiseHash(ix, iy + 1, seed), d = noiseHash(ix + 1, iy + 1, seed);
    return (a + (b - a) * u) * (1 - v) + (c + (d - c) * u) * v;
  }
  function rasterRidge(points, left, top, width, height, mask, name = 'ridge') {
    const distances = new Uint32Array(width * height); distances.fill(0x3FFFFFFF); let seeds = 0;
    const segment = (a, b) => {
      const clipped = clipLine(a.x, a.y, b.x, b.y, left, top, left + width - 1, top + height - 1);
      if (!clipped) return;
      let [x0, y0, x1, y1] = clipped;
      const dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1, dy = -Math.abs(y1 - y0), sy = y0 < y1 ? 1 : -1; let error = dx + dy;
      while (true) {
        const i = (y0 - top) * width + x0 - left;
        if (mask[i] && distances[i]) { distances[i] = 0; seeds++; }
        if (x0 === x1 && y0 === y1) break;
        const twice = 2 * error;
        if (twice >= dy) { error += dy; x0 += sx; }
        if (twice <= dx) { error += dx; y0 += sy; }
      }
    };
    if (points.length === 1) segment(points[0], points[0]);
    else for (let i = 1; i < points.length; i++) segment(points[i - 1], points[i]);
    if (!seeds) throw new Error(`Draw the ${name} through the selected area`);
    return edgeDistanceSquared(distances, width, height);
  }

  function rampState(session, owner) {
    const record = session && RAMP_SESSIONS.get(session);
    if (!record || record.owner !== owner) throw new Error('This ramp belongs to a different document');
    if (record.finished) throw new Error(`This ramp has already been ${record.finished}`);
    owner._idle();
    if (owner.currentLayer !== 'altitude' || owner.width !== record.width || owner.height !== record.height ||
        owner.altitude !== record.altitude || owner.terrain !== record.terrain || owner.selection !== record.selectionRef ||
        owner.selectionActive !== record.selectionActive || owner._paintLink !== record.link)
      throw new Error('The ramp preview is stale; start a new ramp after changing the image, selection or linked painting');
    return record;
  }
  function rampShade(record, slot) {
    const t = record.totalLength === 0 ? 0 : Math.max(0, Math.min(1, record.stations[slot] / record.totalLength));
    return Math.round(record.options.startZ + 128 + ((record.options.sampleEnd?record.sampledEndZ:record.options.endZ) - record.options.startZ) * t);
  }
  function reserveRamp(record, required) {
    if (required <= record.indices.length) return;
    let capacity = Math.max(1024, record.indices.length);
    while (capacity < required) capacity = Math.min(MAX_RAMP_PIXELS, capacity * 2);
    // Allocate/copy before replacing any live preview arrays.
    const indices = new Uint32Array(capacity), stations = new Float64Array(capacity), distances = new Float64Array(capacity);
    const beforeAltitude = new Uint16Array(capacity), beforeTerrain = record.link ? new Uint16Array(capacity) : null;
    indices.set(record.indices); stations.set(record.stations); distances.set(record.distances); beforeAltitude.set(record.beforeAltitude);
    if (beforeTerrain) beforeTerrain.set(record.beforeTerrain);
    Object.assign(record, { indices, stations, distances, beforeAltitude, beforeTerrain });
  }
  function rampSegment(record, x0, y0, x1, y1, initial = false) {
    for (const coordinate of [x0, y0, x1, y1]) integer(coordinate, -1000000000, 1000000000, 'ramp coordinate');
    if (!initial && x0 === x1 && y0 === y1) return;
    if (record.pointCount >= MAX_RAMP_POINTS) throw new RangeError('This ramp is too long. Release it, then start another ramp.');
    const dx = x1 - x0, dy = y1 - y0, lengthSquared = dx * dx + dy * dy, length = Math.hypot(dx, dy), prefix = record.totalLength;
    const { width, height } = record, size = record.options.size, half = Math.floor(size / 2), pad = Math.ceil(size / 2);
    const clipped = clipLine(x0, y0, x1, y1, -pad, -pad, width - 1 + pad, height - 1 + pad);
    const rowLeft = record.rowLeft, rowRight = record.rowRight; let firstRow = height, lastRow = -1;
    // A straight Bresenham segment is monotone. Its square stamps have a single
    // continuous interval per row; union those intervals before visiting pixels.
    // Work is O(centerline length*size + unique segment footprint), not size^2
    // for every overlapping stamp, and never replays earlier segments.
    if (clipped) {
      let [cx, cy, endX, endY] = clipped;
      const stepX = cx < endX ? 1 : -1, stepY = cy < endY ? 1 : -1, ax = Math.abs(endX - cx), ay = -Math.abs(endY - cy); let error = ax + ay;
      while (true) {
        const left = Math.max(0, cx - half), right = Math.min(width - 1, cx - half + size - 1);
        if (left <= right) for (let row = Math.max(0, cy - half); row <= Math.min(height - 1, cy - half + size - 1); row++) {
          if (row < firstRow || row > lastRow) { rowLeft[row] = left; rowRight[row] = right; }
          else { rowLeft[row] = Math.min(rowLeft[row], left); rowRight[row] = Math.max(rowRight[row], right); }
          firstRow = Math.min(firstRow, row); lastRow = Math.max(lastRow, row);
        }
        if (cx === endX && cy === endY) break;
        const twice = 2 * error;
        if (twice >= ay) { error += ay; cx += stepX; }
        if (twice <= ax) { error += ax; cy += stepY; }
      }
    }
    let added = 0;
    for (let py = firstRow; py <= lastRow; py++) for (let px = rowLeft[py]; px <= rowRight[py]; px++) {
      const index = py * width + px;
      if (record.mask[index] && !record.lookup.has(index)) added++;
    }
    if (record.count + added > MAX_RAMP_PIXELS)
      throw new RangeError('This ramp covers too many pixels (maximum 2,097,152). Release the current ramp, use a smaller brush, or draw several shorter ramps.');
    reserveRamp(record, record.count + added);
    let left = record.bounds ? record.bounds.left : width, top = record.bounds ? record.bounds.top : height;
    let right = record.bounds ? record.bounds.left + record.bounds.width - 1 : -1, bottom = record.bounds ? record.bounds.top + record.bounds.height - 1 : -1;
    for (let py = firstRow; py <= lastRow; py++) for (let px = rowLeft[py]; px <= rowRight[py]; px++) {
      const index = py * width + px; if (!record.mask[index]) continue;
      const fromX = px - x0, fromY = py - y0;
      const t = lengthSquared ? Math.max(0, Math.min(1, (fromX * dx + fromY * dy) / lengthSquared)) : 0;
      // Perpendicular distance avoids subtracting nearly equal interpolated
      // coordinates for long/off-canvas segments. Endcaps use the finite endpoint.
      const cross = fromX * dy - fromY * dx;
      const distance = t === 0 ? fromX * fromX + fromY * fromY : t === 1 ? (px - x1) ** 2 + (py - y1) ** 2 : cross * cross / lengthSquared;
      let slot = record.lookup.get(index);
      if (slot === undefined) {
        slot = record.count++; record.lookup.set(index, slot); record.indices[slot] = index;
        record.beforeAltitude[slot] = record.altitude[index]; if (record.link) record.beforeTerrain[slot] = record.terrain[index];
        record.distances[slot] = Infinity;
        left = Math.min(left, px); right = Math.max(right, px); top = Math.min(top, py); bottom = Math.max(bottom, py);
      }
      // Closest centerline wins. Exact ties use this newest segment, so an actual
      // self-crossing follows the later visit without moving a short wide ramp's
      // start merely because neighboring brush stamps overlap it.
      if (distance <= record.distances[slot]) {
        record.distances[slot] = distance; record.stations[slot] = prefix + t * length;
      }
    }
    record.totalLength += length; record.pointCount++; record.lastX = x1; record.lastY = y1;
    record.bounds = record.count ? Object.freeze({ left, top, width: right - left + 1, height: bottom - top + 1 }) : null;
  }

  class MapPaintDocument {
    constructor(width, height, palette, options = {}) {
      const count = dimensions(width, height);
      if (!options || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('options must be an object');
      const maxHistoryBytes = integer(options.maxHistoryBytes === undefined ? 160 * 1024 * 1024 : options.maxHistoryBytes, 0, 1024 * 1024 * 1024, 'maxHistoryBytes');
      const historyLimit = integer(options.historyLimit === undefined ? 100 : options.historyLimit, 1, 10000, 'historyLimit');
      this.width = width; this.height = height; this._palette = paletteOf(palette);
      this.palette = Object.freeze(this._palette.entries.slice());
      this.terrain = new Uint16Array(count); this.altitude = new Uint16Array(count);
      this.terrain.fill(UNSET); this.altitude.fill(UNSET);
      this.deco = new Uint16Array(count); this.deco.fill(UNSET);
      this.selection = new Uint8Array(count); this.selection.fill(1);
      // Fresh documents paint freely, but do not yet have a user-made selection.
      // UI may treat the first additive gesture as replacement in this state.
      this.selectionActive = false;
      this.maxHistoryBytes = maxHistoryBytes; this.historyLimit = historyLimit;
      this._layer = 'terrain'; this._undo = []; this._redo = []; this._stroke = null; this._historyBytes = 0; this._paintLink = null;
      this._seedX = 0; this._seedY = 0;
      SNAPSHOT_STATE.set(this, { entries: [], bytes: 0, nextId: 1, selectionRevision: 0, snapshotRevision: 0, matches: new Map() });
    }
    get currentLayer() { return this._layer; }
    set currentLayer(value) { this._idle(); this._layer = layerName(value); }
    get activeData() { return this[this._layer]; }
    get canUndo() { return this._undo.length > 0; }
    get canRedo() { return this._redo.length > 0; }
    get inStroke() { return this._stroke !== null; }
    get historyBytes() { return this._historyBytes; }
    get paintLinked() { return this._paintLink !== null; }
    get selectionRevision() { return SNAPSHOT_STATE.get(this).selectionRevision; }
    get snapshotRevision() { return SNAPSHOT_STATE.get(this).snapshotRevision; }
    get snapshotBytes() { return SNAPSHOT_STATE.get(this).bytes; }
    listSelectionSnapshots() { return Object.freeze(SNAPSHOT_STATE.get(this).entries.map(snapshotMetadata)); }
    matchesSelectionSnapshot(id) {
      const { state, entry } = snapshotEntry(this, id);
      // Normal consumers treat public masks as read-only. All selection APIs and
      // history replay invalidate this cache; image-only edits need not rescan it.
      if (!state.matches.has(id)) state.matches.set(id, this.selectionActive && samePackedMask(this.selection, entry.packed));
      return state.matches.get(id);
    }
    saveSelectionSnapshot(name) {
      this._idle(); const state = SNAPSHOT_STATE.get(this), named = utf8Name(name);
      if (!this.selectionActive) throw new Error('Make a selection first, or use Select All, before saving it');
      if (state.entries.length >= MAX_SELECTION_SNAPSHOTS) throw new RangeError('At most 256 selections can be saved in one project');
      if (state.entries.some(entry => entry.name.toLowerCase() === named.name.toLowerCase())) throw new Error('A saved selection already uses that name');
      if (state.nextId > 0xFFFFFFFE) throw new RangeError('This project has exhausted its saved-selection IDs');
      let selectedPixels = 0;
      for (let i = 0; i < this.selection.length; i++) {
        if (this.selection[i] !== 0 && this.selection[i] !== 1) throw new RangeError('Selection must be binary');
        selectedPixels += this.selection[i];
      }
      if (!selectedPixels) throw new Error('Select a nonempty area before saving it');
      const entry = { id: state.nextId, ...named, selectedPixels, packed: packMask(this.selection) }; entry.bytes = snapshotBytes(entry);
      const command = { kind: 'snapshot', action: 'add', id: entry.id, entry, index: state.entries.length, bytes: 256 + entry.bytes };
      const prepared = prepareSnapshotChange(state, command, 'after');
      this._storeCommand(command); commitSnapshotChange(state, prepared); state.nextId++;
      state.matches.set(entry.id, true);
      return { changed: true, ...snapshotMetadata(entry), historyBytes: this._historyBytes };
    }
    renameSelectionSnapshot(id, name) {
      this._idle(); const { state, entry } = snapshotEntry(this, id), named = utf8Name(name);
      if (entry.name === named.name) return { changed: false, ...snapshotMetadata(entry), historyBytes: this._historyBytes };
      const command = { kind: 'snapshot', action: 'rename', id, beforeName: entry.name, beforeNameBytes: entry.nameBytes,
        afterName: named.name, afterNameBytes: named.nameBytes, bytes: 256 + entry.nameBytes.byteLength + named.nameBytes.byteLength };
      const prepared = prepareSnapshotChange(state, command, 'after');
      this._storeCommand(command); commitSnapshotChange(state, prepared);
      return { changed: true, ...snapshotMetadata(state.entries.find(item => item.id === id)), historyBytes: this._historyBytes };
    }
    deleteSelectionSnapshot(id) {
      this._idle(); const { state, entry, index } = snapshotEntry(this, id);
      const command = { kind: 'snapshot', action: 'delete', id, entry, index, bytes: 256 + entry.bytes };
      const prepared = prepareSnapshotChange(state, command, 'after');
      this._storeCommand(command); commitSnapshotChange(state, prepared);
      return { changed: true, id, historyBytes: this._historyBytes };
    }
    restoreSelectionSnapshot(id) {
      this._idle(); const { entry } = snapshotEntry(this, id);
      const next = unpackMask(entry.packed, this.selection.length); let changedPixels = 0;
      for (let i = 0; i < this.selection.length; i++) {
        if (this.selection[i] !== 0 && this.selection[i] !== 1) throw new RangeError('Selection must be binary');
        if (this.selection[i] !== next[i]) changedPixels++;
      }
      if (!changedPixels && this.selectionActive) return { changed: false, changedPixels: 0, selectedPixels: entry.selectedPixels, id, historyBytes: this._historyBytes };
      const beforeSelection = packMask(this.selection), afterSelection = entry.packed;
      const command = { kind: 'selection', preserveLayer: true, beforeSelection, afterSelection, beforeActive: this.selectionActive, afterActive: true,
        changed: changedPixels, bytes: 256 + beforeSelection.flags.byteLength + beforeSelection.bits.byteLength + afterSelection.flags.byteLength + afterSelection.bits.byteLength };
      this._storeCommand(command); this.selection = next; this.selectionActive = true; selectionChanged(this);
      return { changed: true, changedPixels, selectedPixels: entry.selectedPixels, id, historyBytes: this._historyBytes };
    }
    setPaintLink(mapping = null) {
      this._idle();
      if (mapping === null) { this._paintLink = null; return false; }
      if (!mapping || typeof mapping !== 'object' || !(mapping.terrainToAltitude instanceof Uint16Array) || mapping.terrainToAltitude.length !== 65536 ||
          !(mapping.altitudeToTerrain instanceof Uint16Array) || mapping.altitudeToTerrain.length !== 256)
        throw new TypeError('Paint link requires terrainToAltitude Uint16Array(65536) and altitudeToTerrain Uint16Array(256)');
      // Own the validated arrays. Caller mutations cannot change a live mapping or
      // a stroke that has captured it; unused terrain-ID entries are never read.
      const terrainToAltitude = mapping.terrainToAltitude.slice(), altitudeToTerrain = mapping.altitudeToTerrain.slice();
      for (const id of this._palette.byId.keys()) integer(terrainToAltitude[id], 0, 255, `Mapped altitude for material ${id}`);
      for (let shade = 0; shade < 256; shade++) this._value(altitudeToTerrain[shade], 'terrain', false);
      this._paintLink = { terrainToAltitude, altitudeToTerrain }; return true;
    }
    _idle() { if (this._stroke) throw new Error('Finish or cancel the active stroke first'); }
    _point(x, y) { integer(x, 0, this.width - 1, 'x'); integer(y, 0, this.height - 1, 'y'); return y * this.width + x; }
    _value(value, layer = this._layer, allowUnset = true) {
      if (allowUnset && value === UNSET) return value;
      integer(value, 0, layer === 'altitude' ? 255 : 65534, layer === 'altitude' ? 'altitude shade' : 'material ID');
      if (layer === 'terrain' && !this._palette.byId.has(value)) throw new RangeError(`Unknown material ID ${value}`);
      return value;
    }
    _combine(next, operation) {
      if (!['replace', 'add', 'subtract', 'intersect'].includes(operation)) throw new RangeError('Unknown selection operation');
      for (let i = 0; i < next.length; i++) {
        if (operation === 'add') next[i] |= this.selection[i];
        else if (operation === 'subtract') next[i] = this.selection[i] && !next[i] ? 1 : 0;
        else if (operation === 'intersect') next[i] &= this.selection[i];
      }
      this.selection = next; this.selectionActive = true; selectionChanged(this); return next;
    }
    createSelectionStroke(x, y, options = {}) {
      this._idle(); this._point(x, y);
      if (!options || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('Selection stroke options must be an object');
      const operation = options.operation === undefined ? 'add' : options.operation;
      if (operation !== 'add' && operation !== 'subtract') throw new RangeError('Pixel selection strokes must add or subtract');
      for (const value of this.selection) if (value !== 0 && value !== 1) throw new RangeError('Selection must be binary');
      const before = packMask(this.selection), offsets = new Uint32Array(before.flags.length); let offset = 0;
      for (let page = 0; page < before.flags.length; page++) {
        offsets[page] = offset;
        if (before.flags[page] === 2) offset += Math.ceil(Math.min(PAGE, this.selection.length - page * PAGE) / 8);
      }
      const record = { owner: this, width: this.width, height: this.height, layer: this._layer, operation,
        before, offsets, beforeActive: this.selectionActive, selectionRef: this.selection, revision: this.selectionRevision,
        touched: new Uint8Array(Math.ceil(this.selection.length / 8)), indices: new Uint32Array(256),
        count: 0, pointCount: 0, work: 0, lastX: x, lastY: y, bounds: null, finished: null };
      const selectedAt = (px, py) => {
        if (record.finished === 'canceled' || !Number.isInteger(px) || !Number.isInteger(py) || px < 0 || py < 0 || px >= record.width || py >= record.height) return false;
        return selectionStrokeValue(record, py * record.width + px);
      };
      const session = Object.freeze({
        operation, selectedAt, valueAt: selectedAt,
        get selectionActive() { return record.finished !== 'canceled' && (record.beforeActive || operation === 'add'); },
        get bounds() { return record.bounds; }, get pixelCount() { return record.count; }, get pointCount() { return record.pointCount; },
        get storageBytes() { return record.finished === 'canceled' ? 0 : record.before.flags.byteLength + record.before.bits.byteLength + record.offsets.byteLength + record.touched.byteLength + record.indices.byteLength; },
        addPoint: (px, py) => { selectionStrokeState(session, this); appendSelectionStroke(record, px, py); return session; },
        cancel: () => { if (record.finished) return false; record.finished = 'canceled'; record.before = record.offsets = record.touched = record.indices = null; return true; }
      });
      SELECTION_STROKES.set(session, record); appendSelectionStroke(record, x, y); return session;
    }
    applySelectionStroke(session) {
      const record = selectionStrokeState(session, this);
      if (!samePackedMask(this.selection, record.before)) throw new Error('The selection stroke is stale; the selection changed');
      if (!record.beforeActive && record.operation === 'subtract') {
        record.finished = 'applied'; return { changed: 0, changedPixels: 0, selectedPixels: 0, selectionChanged: false, historyBytes: this._historyBytes };
      }
      const next = record.beforeActive ? unpackMask(record.before, this.selection.length) : new Uint8Array(this.selection.length);
      for (let slot = 0; slot < record.count; slot++) next[record.indices[slot]] = record.operation === 'add' ? 1 : 0;
      let changedPixels = 0, selectedPixels = 0;
      for (let i = 0; i < next.length; i++) { selectedPixels += next[i]; if (next[i] !== this.selection[i]) changedPixels++; }
      const activeChanged = !record.beforeActive;
      if (!changedPixels && !activeChanged) {
        record.finished = 'applied'; return { changed: 0, changedPixels: 0, selectedPixels, selectionChanged: false, historyBytes: this._historyBytes };
      }
      const afterSelection = packMask(next), command = { kind: 'selection', preserveLayer: true,
        beforeSelection: record.before, afterSelection, beforeActive: record.beforeActive, afterActive: true, changed: changedPixels,
        bytes: 256 + record.before.flags.byteLength + record.before.bits.byteLength + afterSelection.flags.byteLength + afterSelection.bits.byteLength };
      this._storeCommand(command); this.selection = next; this.selectionActive = true; selectionChanged(this); record.finished = 'applied';
      return { changed: changedPixels, changedPixels, selectedPixels, selectionChanged: true, historyBytes: this._historyBytes };
    }
    createWandStroke(x,y,options={}) {
      this._idle();this._point(x,y);const operation=options.operation||'replace';
      if(!['replace','add','subtract'].includes(operation))throw new Error('Invalid wand operation');
      const owner=this,source=this.activeData,selection=this.selection,before=packMask(selection),beforeActive=this.selectionActive,revision=this.selectionRevision;
      const match=options.contiguous===false&&options.matchSurroundings===true;
      const mask=match?surroundedMatches(source,this.width,this.height,x,y):new Uint8Array(source.length),queue=match?null:new Uint32Array(source.length),seenColors=new Set(),recipeSamples=[];let ended=false,last={x,y};
      const check=()=>{owner._idle();if(ended||owner.activeData!==source||owner.selection!==selection||owner.selectionRevision!==revision)throw new Error('Wand selection is stale');};
      const collect=(px,py)=>{if(match||px<0||py<0||px>=owner.width||py>=owner.height)return;const at=py*owner.width+px,value=source[at];if(mask[at])return;recipeSamples.push({x:px/Math.max(1,owner.width-1),y:py/Math.max(1,owner.height-1),value});
        if(options.contiguous===false){if(seenColors.has(value))return;seenColors.add(value);for(let i=0;i<source.length;i++)if(source[i]===value)mask[i]=1;return;}
        let head=0,tail=0;queue[tail++]=at;mask[at]=1;while(head<tail){const i=queue[head++],cx=i%owner.width,cy=Math.floor(i/owner.width);for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){
          if((!dx&&!dy)||(!options.diagonal&&dx&&dy)||cx+dx<0||cy+dy<0||cx+dx>=owner.width||cy+dy>=owner.height)continue;const n=(cy+dy)*owner.width+cx+dx;if(!mask[n]&&source[n]===value){mask[n]=1;queue[tail++]=n;}}
        }
      };
      const selected=i=>operation==='subtract'?(beforeActive&&selection[i]&&!mask[i]?1:0):operation==='add'&&beforeActive?(selection[i]||mask[i]?1:0):mask[i];
      collect(x,y);if(match)recipeSamples.push({x:x/Math.max(1,owner.width-1),y:y/Math.max(1,owner.height-1),value:source[y*owner.width+x]});return Object.freeze({recipe:{samples:recipeSamples,options:{...options}},selectionActive:true,selectedAt(px,py){return selected(py*owner.width+px)===1;},
        addPoint(px,py){check();integer(px,-1000000000,1000000000,'wand x');integer(py,-1000000000,1000000000,'wand y');px=Math.max(0,Math.min(owner.width-1,px));py=Math.max(0,Math.min(owner.height-1,py));const n=Math.max(Math.abs(px-last.x),Math.abs(py-last.y));for(let j=0;j<=n;j++)collect(Math.round(last.x+(px-last.x)*j/(n||1)),Math.round(last.y+(py-last.y)*j/(n||1)));last={x:px,y:py};},
        cancel(){ended=true;},apply(){check();if(operation==='subtract'&&!beforeActive){ended=true;return {changed:0,selectionChanged:false};}const next=new Uint8Array(mask.length);let changed=0;for(let i=0;i<next.length;i++){next[i]=selected(i);if(next[i]!==selection[i])changed++;}if(!changed&&beforeActive){ended=true;return {changed:0,selectionChanged:false};}const afterSelection=packMask(next);owner._storeCommand({kind:'selection',preserveLayer:true,beforeSelection:before,afterSelection,beforeActive,afterActive:true,changed,bytes:256+before.flags.byteLength+before.bits.byteLength+afterSelection.flags.byteLength+afterSelection.bits.byteLength});owner.selection=next;owner.selectionActive=true;selectionChanged(owner);ended=true;return {changed,selectionChanged:changed>0||!beforeActive};}
      });
    }
    select(x, y, options = {}) {
      this._idle(); const seed = this._point(x, y);
      if (!options || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('options must be an object');
      if ('tolerance' in options) throw new RangeError('Map images use exact values; tolerance is not supported');
      const { singlePixel = false, contiguous = true, diagonal = false, operation = 'replace' } = options;
      if (typeof singlePixel !== 'boolean' || typeof contiguous !== 'boolean' || typeof diagonal !== 'boolean') throw new TypeError('Selection flags must be boolean');
      let next;
      if (singlePixel) { next = new Uint8Array(this.selection.length); next[seed] = 1; }
      else if (contiguous) next = connected(this.activeData, this.width, this.height, x, y, undefined, diagonal);
      else if(options.matchSurroundings===true)next=surroundedMatches(this.activeData,this.width,this.height,x,y);
      else { next = new Uint8Array(this.selection.length); const value = this.activeData[seed]; for (let i = 0; i < next.length; i++) next[i] = this.activeData[i] === value ? 1 : 0; }
      this._seedX = x; this._seedY = y; return this._combine(next, operation);
    }
    selectRect(x0, y0, x1, y1, options = {}) {
      this._idle(); this._point(x0, y0); this._point(x1, y1);
      if (!options || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('options must be an object');
      const next = new Uint8Array(this.selection.length), left = Math.min(x0, x1), right = Math.max(x0, x1);
      for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) next.fill(1, y * this.width + left, y * this.width + right + 1);
      return this._combine(next, options.operation === undefined ? 'replace' : options.operation);
    }
    selectFreehand(points,options={}) {
      this._idle();const operation=options.operation||'replace';if(!['replace','add','subtract'].includes(operation))throw Error('Invalid selection operation');
      if(!Array.isArray(points)||points.length>20000)throw Error('Freehand outline is too long.');for(const p of points){integer(p.x,-1000000,1000000,'x');integer(p.y,-1000000,1000000,'y');}
      if(points.length<3||operation==='subtract'&&!this.selectionActive)return {changed:0};
      const a=points[0],b=points.find(p=>p.x!==a.x||p.y!==a.y);if(!b||!points.some(p=>(b.x-a.x)*(p.y-a.y)!==(b.y-a.y)*(p.x-a.x)))return {changed:0};
      const mask=new Uint8Array(this.selection.length);let top=this.height,bottom=-1;for(const p of points){top=Math.min(top,p.y);bottom=Math.max(bottom,p.y);}top=Math.max(0,top);bottom=Math.min(this.height-1,bottom);
      for(let y=top;y<=bottom;y++){const xs=[];for(let i=0,j=points.length-1;i<points.length;j=i++){const a=points[j],b=points[i];if((a.y>y)!==(b.y>y))xs.push(a.x+(y-a.y)*(b.x-a.x)/(b.y-a.y));}xs.sort((a,b)=>a-b);for(let k=0;k+1<xs.length;k+=2){const l=Math.max(0,Math.ceil(xs[k])),r=Math.min(this.width-1,Math.floor(xs[k+1]));if(l<=r)mask.fill(1,y*this.width+l,y*this.width+r+1);}}
      for(let i=0,j=points.length-1;i<points.length;j=i++){const c=clipLine(points[j].x,points[j].y,points[i].x,points[i].y,0,0,this.width-1,this.height-1);if(!c)continue;let [x,y,xx,yy]=c.map(Math.round),dx=Math.abs(xx-x),dy=-Math.abs(yy-y),sx=x<xx?1:-1,sy=y<yy?1:-1,err=dx+dy;for(;;){mask[y*this.width+x]=1;if(x===xx&&y===yy)break;const e=2*err;if(e>=dy){err+=dy;x+=sx;}if(e<=dx){err+=dx;y+=sy;}}}
      if(!mask.some(v=>v))return {changed:0};const next=mask;let changed=0;for(let i=0;i<next.length;i++){if(operation==='add'&&this.selectionActive)next[i]|=this.selection[i];if(operation==='subtract')next[i]=this.selection[i]&&!next[i]?1:0;if(next[i]!==this.selection[i])changed++;}
      const before=packMask(this.selection),after=packMask(next);this._storeCommand({kind:'selection',preserveLayer:true,beforeSelection:before,afterSelection:after,beforeActive:this.selectionActive,afterActive:true,changed,bytes:256+before.flags.byteLength+before.bits.byteLength+after.flags.byteLength+after.bits.byteLength});this.selection=next;this.selectionActive=true;selectionChanged(this);return {changed};
    }
    selectEllipse(x0, y0, x1, y1, options = {}) {
      this._idle(); this._point(x0, y0); this._point(x1, y1);
      if (!options || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('options must be an object');
      const left = Math.min(x0, x1), right = Math.max(x0, x1), top = Math.min(y0, y1), bottom = Math.max(y0, y1);
      const cx = (left + right) / 2, cy = (top + bottom) / 2, rx = (right - left + 1) / 2, ry = (bottom - top + 1) / 2;
      const next = new Uint8Array(this.selection.length);
      for (let y = top; y <= bottom; y++) for (let x = left; x <= right; x++)
        if (((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1) next[y * this.width + x] = 1;
      return this._combine(next, options.operation === undefined ? 'replace' : options.operation);
    }
    selectAll() { this._idle(); this.selection.fill(1); this.selectionActive = true; selectionChanged(this); }
    // Deselect removes the user selection and restores unrestricted painting.
    // Explicit empty selections (clear/intersect/contract) remain protective.
    deselect() { this._idle(); this.selection.fill(1); this.selectionActive = false; selectionChanged(this); }
    clearSelection() { this._idle(); this.selection.fill(0); this.selectionActive = true; selectionChanged(this); }
    invertSelection() { this._idle(); for (let i = 0; i < this.selection.length; i++) this.selection[i] = this.selection[i] ? 0 : 1; this.selectionActive = true; selectionChanged(this); }
    expandSelection(pixels) { return this._resizeSelection(pixels, true); }
    contractSelection(pixels) { return this._resizeSelection(pixels, false); }
    _resizeSelection(pixels, expand) {
      this._idle(); integer(pixels, 1, 8192, 'selection radius');
      if (!this.selectionActive) throw new Error('Make an explicit selection before expanding or contracting it');
      let left = this.width, top = this.height, right = -1, bottom = -1, selected = 0;
      for (let i = 0; i < this.selection.length; i++) {
        if (this.selection[i] !== 0 && this.selection[i] !== 1) throw new RangeError('Selection must be binary');
        if (!this.selection[i]) continue;
        const x = i % this.width, y = Math.floor(i / this.width);
        left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y); selected++;
      }
      if (!selected) throw new Error('The selection is empty; select some pixels before expanding or contracting it');
      if (expand && selected === this.selection.length) return { changed: 0, selectedPixels: selected, historyBytes: this._historyBytes };
      const next = this.selection.slice(); let changed = 0;
      if (expand) { left = Math.max(0, left - pixels); right = Math.min(this.width - 1, right + pixels); top = Math.max(0, top - pixels); bottom = Math.min(this.height - 1, bottom + pixels); }
      const cropWidth = right - left + 1, cropHeight = bottom - top + 1, radiusSquared = pixels * pixels;
      if (!expand && pixels >= Math.ceil(Math.min(cropWidth, cropHeight) / 2)) {
        // Every selected cell is this close to the complement beyond the bounding box.
        next.fill(0); changed = selected;
      } else {
        // Expansion seeds selected cells; contraction seeds their complement.
        // A solid selected rectangle needs only the analytic outside-bbox distance.
        let distances = null;
        if (expand || selected !== cropWidth * cropHeight) {
          distances = new Uint32Array(cropWidth * cropHeight); distances.fill(0x3FFFFFFF);
          for (let y = top; y <= bottom; y++) for (let x = left; x <= right; x++) {
            const isSelected = this.selection[y * this.width + x] === 1;
            if (isSelected === expand) distances[(y - top) * cropWidth + x - left] = 0;
          }
          edgeDistanceSquared(distances, cropWidth, cropHeight);
        }
        for (let y = top; y <= bottom; y++) for (let x = left; x <= right; x++) {
          const i = y * this.width + x, localX = x - left, localY = y - top;
          if (expand) {
            if (!this.selection[i] && distances[localY * cropWidth + localX] <= radiusSquared) { next[i] = 1; changed++; }
          } else if (this.selection[i]) {
            // One pixel beyond the GLOBAL selected bbox is always unselected or
            // outside the image. This includes the virtual outside-image seeds
            // without allocating a padded grid, even for full-canvas selections.
            const outside = Math.min(localX + 1, localY + 1, cropWidth - localX, cropHeight - localY);
            const nearestSquared = Math.min(outside * outside, distances ? distances[localY * cropWidth + localX] : 0x3FFFFFFF);
            if (nearestSquared <= radiusSquared) { next[i] = 0; changed++; }
          }
        }
      }
      if (!changed) return { changed: 0, selectedPixels: selected, historyBytes: this._historyBytes };
      const beforeSelection = packMask(this.selection), afterSelection = packMask(next);
      const command = {
        kind: 'selection', layer: this._layer, beforeSelection, afterSelection,
        beforeActive: this.selectionActive, afterActive: true, changed,
        bytes: 256 + beforeSelection.flags.byteLength + beforeSelection.bits.byteLength + afterSelection.flags.byteLength + afterSelection.bits.byteLength
      };
      // Validate/store history before committing the new mask. A budget failure
      // leaves both history stacks, the selection and both image planes untouched.
      this._storeCommand(command); this.selection = next; this.selectionActive = true; selectionChanged(this);
      return { changed, selectedPixels: expand ? selected + changed : selected - changed, historyBytes: this._historyBytes };
    }
    eyedropper(x, y) { const index = this._point(x, y); this._seedX = x; this._seedY = y; return this.activeData[index]; }
    beginStroke() { this._beginStroke(this._paintLink); }
    _beginStroke(link, wholeMap = false) {
      this._idle();
      // Snapshot the binary gate once, never an RGBA canvas. Changing the public
      // selection buffer during a transaction cannot widen its edit-time boundary.
      for (let i = 0; i < this.selection.length; i++) if (this.selection[i] !== 0 && this.selection[i] !== 1) throw new RangeError('Selection must be binary');
      this._stroke = { layer: this._layer, link, mask: wholeMap ? new Uint8Array(this.selection.length).fill(1) : this.selection.slice(), selectionActive: this.selectionActive, preserveSelection: wholeMap, pages: new Map() };
    }
    _write(index, value) {
      const stroke = this._stroke;
      if (!stroke.mask[index]) return;
      this._writePlane(stroke.layer, index, value);
      // Convert once from the originating layer. Never recurse through the reverse
      // map; the counterpart may need repair even if the active value is unchanged.
      if (stroke.link) {
        const other = stroke.layer === 'terrain' ? 'altitude' : 'terrain';
        const mapped = value === UNSET ? UNSET : stroke.layer === 'terrain' ? stroke.link.terrainToAltitude[value] : stroke.link.altitudeToTerrain[value];
        this._writePlane(other, index, mapped);
      }
    }
    _writePlane(layer, index, value) {
      const stroke = this._stroke, plane = this[layer];
      if (plane[index] === value) return;
      const page = Math.floor(index / PAGE), start = page * PAGE, key = page * 3 + (layer === 'deco' ? 2 : layer === 'altitude' ? 1 : 0);
      if (!stroke.pages.has(key)) stroke.pages.set(key, { layer, page, before: plane.slice(start, Math.min(plane.length, start + PAGE)) });
      plane[index] = value;
    }
    paintLine(x0, y0, x1, y1, value, size = 1) {
      if (!this._stroke) throw new Error('Call beginStroke before painting');
      this._value(value, this._stroke.layer); integer(size, 1, 64, 'brush size');
      for (const coordinate of [x0, y0, x1, y1]) integer(coordinate, -1000000000, 1000000000, 'line coordinate');
      const pad = Math.ceil(size / 2), clipped = clipLine(x0, y0, x1, y1, -pad, -pad, this.width - 1 + pad, this.height - 1 + pad);
      if (!clipped) return;
      [x0, y0, x1, y1] = clipped;
      const stamp = (x, y) => {
        const left = x - Math.floor(size / 2), top = y - Math.floor(size / 2);
        for (let cy = Math.max(0, top); cy < Math.min(this.height, top + size); cy++)
          for (let cx = Math.max(0, left); cx < Math.min(this.width, left + size); cx++) this._write(cy * this.width + cx, value);
      };
      const dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1, dy = -Math.abs(y1 - y0), sy = y0 < y1 ? 1 : -1;
      let error = dx + dy;
      while (true) { stamp(x0, y0); if (x0 === x1 && y0 === y1) break; const twice = 2 * error; if (twice >= dy) { error += dy; x0 += sx; } if (twice <= dx) { error += dx; y0 += sy; } }
    }
    cancelStroke() {
      if (!this._stroke) return false;
      const stroke = this._stroke;
      for (const { layer, page, before } of stroke.pages.values()) this[layer].set(before, page * PAGE);
      this._stroke = null; return true;
    }
    endStroke() {
      if (!this._stroke) throw new Error('No active stroke');
      const stroke = this._stroke, command = { layer: stroke.layer, selectionActive: stroke.selectionActive, preserveSelection: stroke.preserveSelection, pages: [], bytes: 64, changed: 0, linkedChanged: 0 };
      // At most two plane records share any page number. Reuse the first record's
      // bits to count their union without a document-size second change mask.
      const changedPages = stroke.link ? new Map() : null;
      try {
        for (const { layer, page, before } of stroke.pages.values()) {
          const plane = this[layer];
          const start = page * PAGE; let count = 0, beforeValue, afterValue, beforeUniform = true, afterUniform = true, beforeMax = 0, afterMax = 0;
          for (let i = 0; i < before.length; i++) if (before[i] !== plane[start + i]) {
            if (!stroke.mask[start + i]) throw new Error('Protected pixel changed during transaction');
            if (count === 0) { beforeValue = before[i]; afterValue = plane[start + i]; }
            else { if (before[i] !== beforeValue) beforeUniform = false; if (plane[start + i] !== afterValue) afterUniform = false; }
            beforeMax = Math.max(beforeMax, before[i]); afterMax = Math.max(afterMax, plane[start + i]);
            count++;
          }
          if (!count) continue;
          const bits = new Uint8Array(Math.ceil(before.length / 8));
          const old = beforeUniform ? beforeValue : new (beforeMax <= 255 ? Uint8Array : Uint16Array)(count), next = afterUniform ? afterValue : new (afterMax <= 255 ? Uint8Array : Uint16Array)(count);
          let at = 0, unique = count; const previousBits = changedPages && changedPages.get(page);
          for (let i = 0; i < before.length; i++) if (before[i] !== plane[start + i]) {
            bits[i >> 3] |= 1 << (i & 7); if (!beforeUniform) old[at] = before[i]; if (!afterUniform) next[at] = plane[start + i]; at++;
            if (previousBits && (previousBits[i >> 3] & (1 << (i & 7)))) unique--;
          }
          if (changedPages && !previousBits) changedPages.set(page, bits);
          command.pages.push({ layer, start, length: before.length, bits, before: old, after: next });
          command.changed += unique; if (layer !== stroke.layer) command.linkedChanged += count;
          command.bytes += 192 + bits.byteLength + (beforeUniform ? 2 : old.byteLength) + (afterUniform ? 2 : next.byteLength);
          if (command.bytes > this.maxHistoryBytes) throw new RangeError('This edit exceeds the history memory budget; it was cancelled without changing pixels');
        }
        if (command.changed) {
          command.selection = packMask(stroke.mask);
          command.bytes += 64 + command.selection.flags.byteLength + command.selection.bits.byteLength;
          if (command.bytes > this.maxHistoryBytes) throw new RangeError('This edit exceeds the history memory budget; it was cancelled without changing pixels');
        }
        if(this._recipeFinalSelection){const r=this._recipeFinalSelection;command.recipeSelection=r;command.bytes+=128+r.before.flags.byteLength+r.before.bits.byteLength+r.after.flags.byteLength+r.after.bits.byteLength;if(!command.changed){command.kind='selection';command.beforeSelection=r.before;command.afterSelection=r.after;command.beforeActive=r.beforeActive;command.afterActive=r.afterActive;command.preserveLayer=true;}this._storeCommand(command);}else if (command.changed) this._storeCommand(command);
        this._stroke = null;
        const result = { changed: command.changed, outsideChanged: 0, historyBytes: this._historyBytes };
        if (stroke.link) result.linkedChanged = command.linkedChanged;
        return result;
      } catch (error) { this.cancelStroke(); throw error; }
    }
    _storeCommand(command) {
      if (command.bytes > this.maxHistoryBytes) throw new RangeError('This operation exceeds the history memory budget; it was cancelled without changes');
      for (const old of this._redo) this._historyBytes -= old.bytes;
      this._redo = [];
      while (this._undo.length && (this._historyBytes + command.bytes > this.maxHistoryBytes || this._undo.length >= this.historyLimit)) this._historyBytes -= this._undo.shift().bytes;
      this._undo.push(command); this._historyBytes += command.bytes;
    }
    _edit(callback, layer = this._layer, link = this._paintLink, wholeMap = false) {
      this._idle(); layerName(layer); const previous = this._layer; this._layer = layer;
      try { this._beginStroke(link, wholeMap); callback(); return this.endStroke(); }
      catch (error) { this.cancelStroke(); throw error; }
      finally { this._layer = previous; }
    }
    fillSelection(value) {
      this._value(value); return this._edit(() => { for (let i = 0; i < this.selection.length; i++) this._write(i, value); });
    }
    flood(x, y, value, options = {}) {
      this._idle(); this._point(x, y); this._value(value);
      this._seedX = x; this._seedY = y;
      if(!this.selection[y*this.width+x])return {changed:0,linkedChanged:0};
      // An explicit selection is the complete fill target when connectivity is
      // off. Do not re-filter it by color or recompute its surrounding borders.
      if(options.contiguous===false&&this.selectionActive)return this.fillSelection(value);
      let area;
      if(options.contiguous===false){if(options.matchSurroundings===true)area=surroundedMatches(this.activeData,this.width,this.height,x,y);else{const target=this.activeData[y*this.width+x];area=Uint8Array.from(this.activeData,v=>v===target?1:0);}}
      else area = connected(this.activeData, this.width, this.height, x, y, this.selection,options.diagonal===true);
      return this._edit(() => { for (let i = 0; i < area.length; i++) if (area[i]) this._write(i, value); });
    }
    fillAt(x, y, value) { return this.flood(x, y, value); }
    fill(value, x = this._seedX, y = this._seedY) { return this.flood(x, y, value); }
    altitudeGradient(x, y, edgeZ = 0, centerZ = 32) {
      this._idle();
      if (this._layer !== 'altitude') throw new Error('The altitude gradient is available only on the altitude layer');
      const seed = this._point(x, y); integer(edgeZ, -128, 127, 'edge Z'); integer(centerZ, -128, 127, 'center Z');
      if (this.selection[seed] !== 1) throw new Error('Click a selected interior pixel for the altitude gradient');
      // Connectivity follows only the selected shape, independent of existing shade.
      const component = connected(this.selection, this.width, this.height, x, y, this.selection);
      const boundary = (px, py) => {
        if (px === 0 || py === 0 || px === this.width - 1 || py === this.height - 1) return true;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++)
          if ((dx || dy) && !component[(py + dy) * this.width + px + dx]) return true;
        return false;
      };
      if (boundary(x, y)) throw new Error('Click inside the selection, beyond its one-pixel edge rim; an edge pixel cannot also be the gradient center');
      let left = this.width, top = this.height, right = 0, bottom = 0, componentPixels = 0;
      for (let i = 0; i < component.length; i++) if (component[i]) {
        const px = i % this.width, py = Math.floor(i / this.width);
        left = Math.min(left, px); right = Math.max(right, px); top = Math.min(top, py); bottom = Math.max(bottom, py); componentPixels++;
      }
      const cropWidth = right - left + 1, cropHeight = bottom - top + 1, distances = new Uint32Array(cropWidth * cropHeight);
      distances.fill(0x3FFFFFFF); let boundaryPixels = 0;
      for (let py = top; py <= bottom; py++) for (let px = left; px <= right; px++) {
        const i = py * this.width + px;
        if (component[i] && boundary(px, py)) { component[i] = 2; distances[(py - top) * cropWidth + px - left] = 0; boundaryPixels++; }
      }
      edgeDistanceSquared(distances, cropWidth, cropHeight);
      const edgeShade = edgeZ + 128, centerShade = centerZ + 128;
      const result = this._edit(() => {
        for (let py = top; py <= bottom; py++) for (let px = left; px <= right; px++) {
          const i = py * this.width + px; if (!component[i]) continue;
          const edgeSquared = distances[(py - top) * cropWidth + px - left];
          const clickSquared = (px - x) ** 2 + (py - y) ** 2;
          this._write(i, gradientShade(edgeSquared, clickSquared, edgeShade, centerShade));
        }
      }, 'altitude', this._paintLink);
      this._seedX = x; this._seedY = y;
      return Object.assign(result, { componentPixels, boundaryPixels, edgeZ, centerZ });
    }
    applySimpleFilter(kind, strength=50) {
      this._idle(); integer(strength,0,100,'Filter strength');
      if(!['contrast-up','contrast-down','posterize','cleanup'].includes(kind))throw new Error('Unknown filter');
      const layer=kind==='cleanup'?this._layer:'altitude',src=kind==='cleanup'?this[layer].slice():this[layer],amount=strength/100;
      const step=Math.max(1,Math.round(1+31*amount));
      return this._edit(()=>{for(let y=0;y<this.height;y++)for(let x=0;x<this.width;x++){
        const i=y*this.width+x,v=src[i];if(!this.selection[i]||v===UNSET||!strength)continue;let next=v;
        if(kind==='posterize')next=Math.min(255,Math.round(v/step)*step);
        else if(kind==='contrast-up'){let t=v/255;const curved=t*t*(3-2*t);next=Math.round(255*(t+(curved-t)*amount));}
        else if(kind==='contrast-down')next=Math.round(v+(128-v)*amount*.8);
        else {const counts=new Map();let same=0;for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){
          if((!dx&&!dy)||x+dx<0||y+dy<0||x+dx>=this.width||y+dy>=this.height)continue;
          const n=src[(y+dy)*this.width+x+dx];if(n===UNSET)continue;counts.set(n,(counts.get(n)||0)+1);if(n===v)same++;
        }let best=v,count=0;for(const [n,c]of counts)if(c>count||(c===count&&n<best)){best=n;count=c;}
        if(same<=Math.floor(amount*2)&&count>=Math.max(3,6-Math.floor(amount*3)))next=best;}
        this._write(i,next);
      }},layer,this._paintLink);
    }
    createHousingTerraces(options={}) {
      this._idle();
      const min=integer(options.min===undefined?12:options.min,3,128,'minimum terrace size'),max=integer(options.max===undefined?24:options.max,3,128,'maximum terrace size');
      if(max<min)throw new Error('Maximum size must be at least minimum size.');
      let seed=integer(options.seed===undefined?1:options.seed,0,2147483647,'seed')>>>0;
      const rand=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
      const w=this.width,h=this.height;let pads=0,pixels=0,partialPads=0;
      // Tile the height vertices with staggered square bands, without suitability searches.
      // A side of size+1 vertices leaves size fully flat UO cells inside each complete pad.
      const result=this._edit(()=>{
        for(let y=0;y<h;){const side=min+Math.floor(rand()*(max-min+1))+1,ye=Math.min(h,y+side),offset=Math.floor(rand()*side);
          for(let x=-offset;x<w;x+=side){const xs=Math.max(0,x),xe=Math.min(w,x+side);let sum=0,count=0;
            for(let yy=y;yy<ye;yy++)for(let xx=xs;xx<xe;xx++){const i=yy*w+xx;if(this.selection[i]&&this.altitude[i]!==UNSET){sum+=this.altitude[i];count++;}}
            if(!count)continue;const shade=Math.round(sum/count);pads++;pixels+=count;
            if(count!==side*side)partialPads++;
            for(let yy=y;yy<ye;yy++)for(let xx=xs;xx<xe;xx++){const i=yy*w+xx;if(this.selection[i]&&this.altitude[i]!==UNSET)this._writePlane('altitude',i,shade);}
          }y=ye;
        }
      },this._layer,null);
      return {...result,pads,pixels,partialPads};
    }
    createCityPlots(options={}) {
      this._idle();
      const engine=typeof module==='object'&&module.exports?require('./city-plots.cjs'):globalThis.CityPlots;
      const plots=engine.plan(this,options);
      if(!plots.length)throw new Error('No suitable city site found. Select a larger dry area or increase Max height range.');
      // A rendered UO cell uses heights at its four corners. Include the extra
      // east/south vertex row so the last paving cells cannot slope outward.
      const result=this._edit(()=>{for(const p of plots)for(let y=p.y-p.siteBorder-p.siteBlend;y<=p.y+p.height+p.siteBorder+p.siteBlend;y++)for(let x=p.x-p.siteBorder-p.siteBlend;x<=p.x+p.width+p.siteBorder+p.siteBlend;x++){
        const i=y*this.width+x,distance=Math.max(p.x-x,x-(p.x+p.width),p.y-y,y-(p.y+p.height),0);let shade=p.shade;
        if(distance>p.siteBorder){const t=(distance-p.siteBorder)/p.siteBlend,weight=t*t*(3-2*t);shade=Math.round(p.shade+(this.altitude[i]-p.shade)*weight);}
        this._writePlane('altitude',i,shade);
        if(!options.altitudeOnly&&x>=p.x&&y>=p.y&&x<p.x+p.width&&y<p.y+p.height)this._writePlane('terrain',i,p.material);
      }engine.assertFlat(this,plots);},'terrain',null,options.scope==='whole');
      return {...result,plots:plots.length};
    }
    levelCityFoundations(options={}) {
      this._idle();const engine=typeof module==='object'&&module.exports?require('./city-plots.cjs'):globalThis.CityPlots;
      const plan=engine.foundations(this,options);let leveled=0;
      const result=this._edit(()=>{for(const p of plan.plots){let changed=false;for(let y=p.y;y<=p.y+p.height;y++)for(let x=p.x;x<=p.x+p.width;x++){const i=y*this.width+x;changed=changed||this.altitude[i]!==p.shade;this._writePlane('altitude',i,p.shade);}if(changed)leveled++;}engine.assertFlat(this,plan.plots);},this._layer,null,options.scope==='whole');
      return {...result,plots:plan.plots.length,leveled,skipped:plan.skipped};
    }
    generateDecorations(options={}) {
      this._idle();
      const engine=typeof module==='object'&&module.exports?require('./deco-generator.cjs'):globalThis.DecoGenerator;
      const plan=options.housingSafe?engine.housing(this,options):options.wallsOnly?engine.walls(this,options):engine.plan(this,options);
      const result=this._edit(()=>{for(const p of plan.placements)this._writePlane('deco',p.index,p.preset);},this._layer,null,!options.housingSafe&&options.scope==='whole');
      return {...result,protectedCells:plan.protectedCells||0,cleared:plan.cleared||0,added:plan.added||0,placements:plan.placements.length,center:plan.center,repaired:plan.repaired||0,wallPlots:plan.wallPlots||plan.plots||0,skippedPlots:plan.skippedPlots||plan.skipped||0};
    }
    growTerrainPatches(limit=6,radius=1) {
      this._idle();
      const filter=typeof module==='object'&&module.exports?require('./growth.cjs'):globalThis.MapGrowth;
      const result=filter.plan(this,limit,radius);
      return this._edit(()=>{for(let i=0;i<result.length;i++)if(this.selection[i]&&result[i]!==this.terrain[i])this._write(i,result[i]);},'terrain',null);
    }
    consumeTerrainPatches(limit=6) {
      this._idle();
      const filter=typeof module==='object'&&module.exports?require('./consumption.cjs'):globalThis.MapConsumption;
      const result=filter.plan(this,limit);
      const stats=this._edit(()=>{for(let i=0;i<result.terrain.length;i++)if(this.selection[i]&&result.terrain[i]!==this.terrain[i])this._write(i,result.terrain[i]);},'terrain',null);
      return {...stats,consumedPatches:result.patches};
    }
    applyTerrainBoundaryFilter(kind, width=5, blend=5) {
      this._idle();
      const filters=typeof module==='object'&&module.exports?require('./terrain-boundary-filters.cjs'):globalThis.TerrainBoundaryFilters;
      let result;
      if(kind==='smooth-boundaries')result=filters.smoothBoundaries(this,width);
      else if(kind==='water-banks')result=filters.flattenWater(this,width,blend);
      else throw new Error('Unknown terrain boundary filter');
      const originalSelection=this.selection;
      try{
        // Only water-banks explicitly authorizes a band outside the selected water.
        this.selection=result.mask;
        const stats=this._edit(()=>{for(let i=0;i<result.altitude.length;i++)if(result.mask[i])this._write(i,result.altitude[i]);},'altitude',null);
        return {...stats,waterSections:result.components||0};
      }finally{this.selection=originalSelection;}
    }
    flattenTerrainEdges(width = 5) {
      this._idle(); integer(width,1,32,'Edge width');
      const source=this.altitude,terrain=this.terrain,w=this.width,h=this.height;
      let spread=new Uint16Array(source.length);spread.fill(UNSET);
      const neighbors=(i,fn)=>{const x=i%w;if(x>0)fn(i-1);if(x+1<w)fn(i+1);if(i>=w)fn(i-w);if(i+w<source.length)fn(i+w);};
      // Seed the higher side of actual terrain-color boundaries from original heights.
      for(let i=0;i<source.length;i++)if(this.selection[i]&&source[i]!==UNSET&&terrain[i]!==UNSET){
        neighbors(i,j=>{if(terrain[j]!==UNSET&&terrain[j]!==terrain[i]&&source[j]!==UNSET&&source[j]<source[i])spread[i]=Math.min(spread[i],source[j]);});
      }
      // Each pass adds one side-connected pixel; never cross another material or a selection hole.
      for(let step=1;step<width;step++){
        const next=spread.slice();
        for(let i=0;i<source.length;i++)if(this.selection[i]&&source[i]!==UNSET&&terrain[i]!==UNSET){
          neighbors(i,j=>{if(this.selection[j]&&terrain[j]===terrain[i]&&spread[j]!==UNSET)next[i]=Math.min(next[i],spread[j]);});
        }
        spread=next;
      }
      return this._edit(()=>{for(let i=0;i<source.length;i++)if(this.selection[i]&&spread[i]!==UNSET&&spread[i]<source[i])this._write(i,spread[i]);},'altitude',null);
    }
    createFlatten(x, y, options = {}) {
      if (!Flatten) throw new Error('The Flatten module is not loaded');
      return Flatten.create(this, x, y, options, { connected, packMask, samePackedMask, edgeDistanceSquared });
    }
    planFlatten(session) { if (!Flatten) throw new Error('The Flatten module is not loaded'); return Flatten.plan(this, session); }
    applyFlatten(plan) { if (!Flatten) throw new Error('The Flatten module is not loaded'); return Flatten.apply(this, plan); }
    createRoad(x, y, options = {}) {
      if (!Road) throw new Error('The Road module is not loaded');
      return Road.create(this, x, y, options, { connected, packMask, samePackedMask, edgeDistanceSquared });
    }
    planRoad(session) { if (!Road) throw new Error('The Road module is not loaded'); return Road.plan(this, session); }
    applyRoad(plan) { if (!Road) throw new Error('The Road module is not loaded'); return Road.apply(this, plan); }
    planDistort(options = {}) {
      if (!Distortion) throw new Error('The altitude distortion module is not loaded');
      return Distortion.plan(this, options, { packMask, samePackedMask, edgeDistanceSquared });
    }
    applyDistort(plan) { if (!Distortion) throw new Error('The altitude distortion module is not loaded'); return Distortion.apply(this, plan); }
    planBlur(options = {}) {
      if (!Smoothing) throw new Error('The altitude smoothing module is not loaded');
      return Smoothing.filter(this, 'blur', options, { packMask, samePackedMask, edgeDistanceSquared, clipLine });
    }
    planMelt(options = {}) {
      if (!Smoothing) throw new Error('The altitude smoothing module is not loaded');
      return Smoothing.filter(this, 'melt', options, { packMask, samePackedMask, edgeDistanceSquared, clipLine });
    }
    applySmoothing(plan) { if (!Smoothing) throw new Error('The altitude smoothing module is not loaded'); return Smoothing.apply(this, plan); }
    createBlurBrush(x, y, options = {}) {
      if (!Smoothing) throw new Error('The altitude smoothing module is not loaded');
      return Smoothing.createBrush(this, x, y, options, { packMask, samePackedMask, edgeDistanceSquared, clipLine });
    }
    applyBlurBrush(session) { if (!Smoothing) throw new Error('The altitude smoothing module is not loaded'); return Smoothing.applyBrush(this, session); }
    createRamp(x, y, options = {}) {
      this._idle();
      if (this._layer !== 'altitude') throw new Error('The Ramp tool is available only on the altitude layer');
      if (!options || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('Ramp options must be an object');
      const settings = Object.freeze({
        startZ: integer(options.startZ === undefined ? 0 : options.startZ, -128, 127, 'ramp start Z'),
        endZ: integer(options.endZ === undefined ? 32 : options.endZ, -128, 127, 'ramp end Z'),
        size: integer(options.size === undefined ? 1 : options.size, 1, 64, 'ramp brush size'),
        sampleEnd: options.sampleEnd === true
      });
      integer(x, -1000000000, 1000000000, 'ramp x'); integer(y, -1000000000, 1000000000, 'ramp y');
      const mask = this.selection.slice();
      for (let i = 0; i < mask.length; i++) if (mask[i] !== 0 && mask[i] !== 1) throw new RangeError('Selection must be binary');
      const record = { owner: this, width: this.width, height: this.height, altitude: this.altitude, terrain: this.terrain,
        selectionRef: this.selection, selectionActive: this.selectionActive, mask, link: this._paintLink, options: settings,
        sampledEndZ: settings.sampleEnd && x>=0 && y>=0 && x<this.width && y<this.height && this.altitude[y*this.width+x]!==UNSET ? this.altitude[y*this.width+x]-128 : settings.endZ, sourceForSampling: settings.sampleEnd ? this.altitude.slice() : null,
        lookup: new Map(), indices: new Uint32Array(0), stations: new Float64Array(0), distances: new Float64Array(0),
        beforeAltitude: new Uint16Array(0), beforeTerrain: this._paintLink ? new Uint16Array(0) : null,
        rowLeft: new Int32Array(this.height), rowRight: new Int32Array(this.height),
        count: 0, totalLength: 0, pointCount: 0, lastX: x, lastY: y, bounds: null, finished: null };
      const session = Object.freeze({
        mode: 'ramp', options: settings,
        get bounds() { return record.bounds; },
        get pixelCount() { return record.count; },
        get pointCount() { return record.pointCount; },
        get totalLength() { return record.totalLength; },
        get storageBytes() { return (record.sourceForSampling ? record.sourceForSampling.byteLength : 0) + (record.mask ? record.mask.byteLength : 0) + record.indices.byteLength + record.stations.byteLength +
          record.distances.byteLength + record.beforeAltitude.byteLength + (record.beforeTerrain ? record.beforeTerrain.byteLength : 0) + record.rowLeft.byteLength + record.rowRight.byteLength; },
        addPoint: (px, py) => {
          rampState(session, this); if(record.sourceForSampling&&Number.isInteger(px)&&Number.isInteger(py)&&px>=0&&py>=0&&px<record.width&&py<record.height){const shade=record.sourceForSampling[py*record.width+px];if(shade!==UNSET)record.sampledEndZ=shade-128;} rampSegment(record, record.lastX, record.lastY, px, py); return session;
        },
        valueAt: (px, py, layer = 'altitude') => {
          if (record.finished === 'canceled' || (layer !== 'altitude' && layer !== 'terrain') || !Number.isInteger(px) || !Number.isInteger(py) ||
              px < 0 || py < 0 || px >= record.width || py >= record.height) return undefined;
          const bounds = record.bounds;
          if (!bounds || px < bounds.left || py < bounds.top || px >= bounds.left + bounds.width || py >= bounds.top + bounds.height) return undefined;
          const slot = record.lookup.get(py * record.width + px); if (slot === undefined) return undefined;
          const shade = rampShade(record, slot); return layer === 'altitude' ? shade : undefined;
        },
        cancel: () => {
          if (record.finished) return false;
          record.finished = 'canceled'; record.lookup.clear(); record.mask = null; record.sourceForSampling=null;
          record.indices = new Uint32Array(0); record.stations = record.distances = new Float64Array(0);
          record.beforeAltitude = new Uint16Array(0); record.beforeTerrain = null;
          record.rowLeft = record.rowRight = new Int32Array(0); return true;
        }
      });
      RAMP_SESSIONS.set(session, record);
      rampSegment(record, x, y, x, y, true);
      return session;
    }
    planRamp(points, options = {}) {
      if (!Array.isArray(points) || !points.length || points.length > MAX_RAMP_POINTS) throw new RangeError('A ramp needs 1 to 100000 points');
      for (const point of points) {
        if (!point || typeof point !== 'object') throw new TypeError('Ramp points must contain x and y');
        integer(point.x, -1000000000, 1000000000, 'ramp x'); integer(point.y, -1000000000, 1000000000, 'ramp y');
      }
      const session = this.createRamp(points[0].x, points[0].y, options);
      try { for (let i = 1; i < points.length; i++) session.addPoint(points[i].x, points[i].y); return session; }
      catch (error) { session.cancel(); throw error; }
    }
    applyRamp(session) {
      const record = rampState(session, this);
      const stale = () => { throw new Error('The ramp preview is stale; start a new ramp after changing the image or selection'); };
      for (let i = 0; i < record.mask.length; i++) if (this.selection[i] !== record.mask[i]) stale();
      for (let slot = 0; slot < record.count; slot++) {
        const i = record.indices[slot];
        if (this.altitude[i] !== record.beforeAltitude[slot] || (record.link && this.terrain[i] !== record.beforeTerrain[slot])) stale();
      }
      const result = this._edit(() => {
        for (let slot = 0; slot < record.count; slot++) this._write(record.indices[slot], rampShade(record, slot));
      }, 'altitude', record.link);
      record.finished = 'applied'; record.sourceForSampling=null;
      return Object.assign(result, { mode: 'ramp', startZ: record.options.startZ, endZ: record.options.sampleEnd?record.sampledEndZ:record.options.endZ,
        size: record.options.size, totalLength: record.totalLength, footprintPixels: record.count });
    }
    planLandform(x, y, options = {}) {
      this._idle();
      if (this._layer !== 'altitude') throw new Error('Landforms are available only on the altitude layer');
      const anchor = this._point(x, y), settings = landformOptions(options, x, y);
      if (!this.selectionActive && settings.mode !== 'range') throw new Error('Select an area first, or use Select all, before making a landform');
      if (this.selection[anchor] !== 1) throw new Error('Click inside the selected area for the landform');
      for (let i = 0; i < this.selection.length; i++)
        if (this.selection[i] !== 0 && this.selection[i] !== 1) throw new RangeError('Selection must be binary');
      let component = settings.mode==='range'?this.selection.slice():connected(this.selection, this.width, this.height, x, y, this.selection);
      let left = this.width, top = this.height, right = 0, bottom = 0, componentPixels = 0;
      for (let i = 0; i < component.length; i++) if (component[i]) {
        const px = i % this.width, py = Math.floor(i / this.width);
        if (px < left) left = px; if (px > right) right = px;
        if (py < top) top = py; if (py > bottom) bottom = py;
        componentPixels++;
      }
      const width = right - left + 1, height = bottom - top + 1, count = width * height;
      const mask = new Uint8Array(count), distances = new Uint32Array(count); distances.fill(0x3FFFFFFF);
      let boundaryPixels = 0;
      for (let py = top; py <= bottom; py++) for (let px = left; px <= right; px++) {
        const source = py * this.width + px, target = (py - top) * width + px - left;
        if (!component[source]) continue;
        let boundary = px === 0 || py === 0 || px === this.width - 1 || py === this.height - 1;
        for (let dy = -1; dy <= 1 && !boundary; dy++) for (let dx = -1; dx <= 1; dx++)
          if (!component[(py + dy) * this.width + px + dx]) { boundary = true; break; }
        mask[target] = boundary ? 2 : 1;
        if (boundary) { distances[target] = 0; boundaryPixels++; }
      }
      component = null; // Further grids scale with the component bounds, not the entire map.
      edgeDistanceSquared(distances, width, height);
      const pathMode = settings.mode === 'path';
      const ridgeDistances = settings.mode === 'ridge' || pathMode ? rasterRidge(settings.points, left, top, width, height, mask, pathMode ? 'path' : 'ridge') : null;
      const shades = new Uint8Array(count), beforeAltitude = new Uint16Array(count);
      const link = this._paintLink, beforeTerrain = link ? new Uint16Array(count) : null;
      const anchorEdge = Math.sqrt(distances[(y - top) * width + x - left]);
      const baseShade = settings.baseZ + 128, span = settings.peakZ - settings.baseZ, roughness = settings.roughness / 100;
      const mountainScale = Math.max(1, anchorEdge) / settings.featureSize;
      const hillEdgeScale = Math.max(1, Math.min(settings.featureSize, width, height) * 0.35);
      let minZ = 127, maxZ = -128, rangeMaximum=0;
      const rangeShapes=settings.mode==='range'?new Float32Array(count):null;
      for (let py = top; py <= bottom; py++) for (let px = left; px <= right; px++) {
        const i = (py - top) * width + px - left; if (!mask[i]) continue;
        const source = py * this.width + px; beforeAltitude[i] = this.altitude[source];
        if (beforeTerrain) beforeTerrain[i] = this.terrain[source];
        let shape = 0;
        if (mask[i] === 1 && span !== 0) {
          const edge = Math.sqrt(distances[i]);
          if (settings.mode === 'range') {
            const scale=settings.featureSize,warpX=(valueNoise(px,py,scale*2,settings.seed^12345)-.5)*scale,warpY=(valueNoise(px,py,scale*2,settings.seed^67890)-.5)*scale;
            const wx=px+warpX,wy=py+warpY;let ridges=0,weight=1,total=0,frequency=scale;
            for(let octave=0;octave<4;octave++){const n=valueNoise(wx,wy,Math.max(2,frequency),settings.seed+octave*1013),ridge=1-Math.abs(2*n-1);ridges+=ridge*ridge*weight;total+=weight;weight*=.45;frequency*=.5;}
            const province=valueNoise(px,py,scale*3,settings.seed^0x18AC3),zone=Math.max(0,Math.min(1,(province-.2)/.65));
            const f=Math.min(1,edge/Math.max(4,scale*.5)),fade=f*f*f*(f*(f*6-15)+10);
            shape=fade*(.035+.965*Math.pow(zone,1.5)*Math.pow(ridges/total,2));
          } else if (settings.mode === 'mountain') {
            const distance = Math.hypot(px - x, py - y);
            shape = edge / (edge + distance * mountainScale);
          } else if (settings.mode === 'ridge') {
            const distance = Math.sqrt(ridgeDistances[i]);
            shape = edge / (edge + distance) * Math.exp(-0.5 * (distance / settings.featureSize) ** 2);
          } else if (pathMode) {
            // Fit both sides of the drawn path to the actual component boundary.
            // Smoothstep rounds the crest and edge shoulders without a fixed
            // width, random detail or additional width-based attenuation.
            const distance = Math.sqrt(ridgeDistances[i]), t = edge / (edge + distance);
            shape = t * t * (3 - 2 * t);
          } else {
            const fade = Math.min(1, edge / hillEdgeScale);
            const smooth=fade*fade*fade*(fade*(fade*6-15)+10);shape=smooth*(.25+.75*valueNoise(px,py,settings.featureSize,settings.seed)*smooth);
          }
          if (!pathMode) shape = Math.pow(shape, settings.slope);
          if (!pathMode && roughness && shape > 0 && shape < 1) {
            const detail = valueNoise(px, py, settings.detailScale, settings.seed ^ 0xA511E9B3) * 0.7 +
              valueNoise(px, py, Math.max(1, settings.detailScale / 2), settings.seed ^ 0x63D83595) * 0.3;
            // This bounded modulation preserves the exact boundary and crest,
            // while coherent noise changes the slopes instead of speckling pixels.
            const edgeFade=['hills','range'].includes(settings.mode)?Math.min(1,edge/hillEdgeScale)**3:1;shape += edgeFade * roughness * shape * (1 - shape) * (detail * 2 - 1);
          }
        }
        if(rangeShapes){rangeShapes[i]=shape;rangeMaximum=Math.max(rangeMaximum,shape);}
        const shade = Math.max(0, Math.min(255, Math.round(baseShade + span * shape)));
        shades[i] = shade; minZ = Math.min(minZ, shade - 128); maxZ = Math.max(maxZ, shade - 128);
      }
      if(rangeShapes&&rangeMaximum>0){minZ=127;maxZ=-128;for(let i=0;i<count;i++)if(mask[i]){shades[i]=Math.max(0,Math.min(255,Math.round(baseShade+span*rangeShapes[i]/rangeMaximum)));minZ=Math.min(minZ,shades[i]-128);maxZ=Math.max(maxZ,shades[i]-128);}}
      const bounds = Object.freeze({ left, top, width, height });
      const selection = packMask(this.selection);
      const record = { owner: this, width: this.width, height: this.height, altitude: this.altitude, terrain: this.terrain,
        selection, selectionActive:this.selectionActive, mask, shades, beforeAltitude, beforeTerrain, bounds, link, used: false, x, y };
      const valueAt = (px, py, layer = 'altitude') => {
        if (layer !== 'altitude' && layer !== 'terrain') return undefined;
        if (!Number.isInteger(px) || !Number.isInteger(py) || px < left || py < top || px > right || py > bottom) return undefined;
        const i = (py - top) * width + px - left;
        if (!mask[i]) return undefined;
        return layer === 'altitude' ? shades[i] : undefined;
      };
      const plan = Object.freeze({ bounds, componentPixels, boundaryPixels, cropPixels: count, minZ, maxZ,
        seed: settings.seed, options: settings, valueAt,
        storageBytes: mask.byteLength + shades.byteLength + beforeAltitude.byteLength + (beforeTerrain ? beforeTerrain.byteLength : 0) + selection.flags.byteLength + selection.bits.byteLength });
      LANDFORM_PLANS.set(plan, record);
      return plan;
    }
    applyLandform(plan) {
      this._idle();
      const record = plan && LANDFORM_PLANS.get(plan);
      if (!record || record.owner !== this) throw new Error('This landform preview belongs to a different document');
      if (record.used) throw new Error('This landform preview has already been applied');
      const stale = () => { throw new Error('The landform preview is stale; preview again after changing the image, selection or linked painting'); };
      if (this._layer !== 'altitude' || this.selectionActive !== record.selectionActive || this.width !== record.width || this.height !== record.height ||
          this.altitude !== record.altitude || this.terrain !== record.terrain || this._paintLink !== record.link ||
          this.selection.length !== record.width * record.height || !samePackedMask(this.selection, record.selection)) stale();
      const { left, top, width, height } = record.bounds;
      for (let py = 0; py < height; py++) for (let px = 0; px < width; px++) {
        const i = py * width + px; if (!record.mask[i]) continue;
        const source = (py + top) * this.width + px + left;
        if (this.altitude[source] !== record.beforeAltitude[i] || (record.beforeTerrain && this.terrain[source] !== record.beforeTerrain[i])) stale();
      }
      const result = this._edit(() => {
        for (let py = 0; py < height; py++) for (let px = 0; px < width; px++) {
          const i = py * width + px;
          if (record.mask[i]) this._write((py + top) * this.width + px + left, record.shades[i]);
        }
      }, 'altitude', record.link);
      record.used = true; this._seedX = record.x; this._seedY = record.y;
      return Object.assign(result, { componentPixels: plan.componentPixels, boundaryPixels: plan.boundaryPixels,
        mode: plan.options.mode, seed: plan.seed, baseZ: plan.options.baseZ, peakZ: plan.options.peakZ, minZ: plan.minZ, maxZ: plan.maxZ });
    }
    commitRecipe(stage) {
      this._idle();if(stage.width!==this.width||stage.height!==this.height)throw Error('Recipe dimensions changed.');
      const before=packMask(this.selection),after=packMask(stage.selection);this._recipeFinalSelection={before,after,beforeActive:this.selectionActive,afterActive:stage.selectionActive};
      try {const result=this._edit(()=>{for(const layer of ['terrain','altitude','deco'])for(let i=0;i<this[layer].length;i++)if(this[layer][i]!==stage[layer][i])this._writePlane(layer,i,stage[layer][i]);},this.currentLayer,null,true);this.selection=stage.selection.slice();this.selectionActive=stage.selectionActive;selectionChanged(this);return result;}finally{this._recipeFinalSelection=null;}
    }
    _apply(command, direction) {
      if (command.kind === 'snapshot') {
        const state = SNAPSHOT_STATE.get(this), prepared = prepareSnapshotChange(state, command, direction);
        commitSnapshotChange(state, prepared); return;
      }
      if (command.kind === 'selection') {
        this.selection = unpackMask(command[direction + 'Selection'], this.selection.length);
        this.selectionActive = command[direction + 'Active']; if (!command.preserveLayer) this._layer = command.layer;
        selectionChanged(this); return;
      }
      const restoredSelection = unpackMask(command.selection, this.selection.length);
      for (const page of command.pages) {
        const plane = this[page.layer || command.layer];
        const values = page[direction]; let at = 0;
        for (let i = 0; i < page.length; i++) if (page.bits[i >> 3] & (1 << (i & 7))) plane[page.start + i] = typeof values === 'number' ? values : values[at++];
      }
      if(!command.preserveSelection){this.selection = restoredSelection;
      this.selectionActive = command.selectionActive;}
      this._layer = command.layer; if(command.recipeSelection){this.selection=unpackMask(command.recipeSelection[direction],this.selection.length);this.selectionActive=command.recipeSelection[direction+'Active'];} selectionChanged(this);
    }
    undo() { this._idle(); const command = this._undo[this._undo.length - 1]; if (!command) return false; this._apply(command, 'before'); this._undo.pop(); this._redo.push(command); return true; }
    redo() {
      this._idle(); const command = this._redo[this._redo.length - 1]; if (!command) return false;
      if (command.bytes > this.maxHistoryBytes || this._historyBytes > this.maxHistoryBytes) throw new RangeError('Redo exceeds the current history memory budget; no changes were made');
      this._apply(command, 'after'); this._redo.pop(); this._undo.push(command); return true;
    }
    clearHistory() { this._idle(); this._undo = []; this._redo = []; this._historyBytes = 0; }

    renderRGBA(x = 0, y = 0, width = this.width, height = this.height, layer = this._layer) {
      layerName(layer); this._point(x, y); integer(width, 1, this.width - x, 'region width'); integer(height, 1, this.height - y, 'region height');
      const rgba = new Uint8ClampedArray(width * height * 4), plane = this[layer];
      for (let row = 0; row < height; row++) for (let col = 0; col < width; col++) {
        const value = plane[(y + row) * this.width + x + col], target = (row * width + col) * 4;
        if (value === UNSET) continue;
        this._value(value, layer, false);
        if (layer === 'altitude') rgba[target] = rgba[target + 1] = rgba[target + 2] = value;
        else { const material = this._palette.byId.get(value); rgba[target] = material.r; rgba[target + 1] = material.g; rgba[target + 2] = material.b; }
        rgba[target + 3] = 255;
      }
      return rgba;
    }
    exportDecoRGBA(entries) {
      this._idle();
      const palette=new Map(entries.map(e=>[e.id,e.rgb])),out=new Uint8ClampedArray(this.deco.length*4);
      for(let i=0;i<this.deco.length;i++){
        const id=this.deco[i],rgb=id===UNSET?[0,0,0]:palette.get(id);
        if(!rgb)throw new Error('Unknown decoration preset '+id+' at pixel '+i);
        out.set([rgb[0],rgb[1],rgb[2],255],i*4);
      }
      return out;
    }
    exportRGBA(layer = this._layer) {
      this._idle(); layerName(layer); const plane = this[layer];
      for (let i = 0; i < plane.length; i++) {
        const value = plane[i];
        if (value === UNSET) throw new Error(`Unset ${layer} pixel at (${i % this.width}, ${Math.floor(i / this.width)}); complete it before exporting`);
        this._value(value, layer, false);
        if (layer === 'terrain' && this._palette.ambiguous.has(this._palette.byId.get(value).rgb)) throw new Error(`Material ${value} has an ambiguous palette RGB; save the indexed project to preserve its identity`);
      }
      return this.renderRGBA(0, 0, this.width, this.height, layer);
    }
    importRGBA(rgba, width, height, layer = this._layer) {
      this._idle(); layerName(layer);
      if (width !== this.width || height !== this.height) throw new RangeError('Image dimensions must exactly match; resizing is not supported');
      if (!(rgba instanceof Uint8Array) && !(rgba instanceof Uint8ClampedArray)) throw new TypeError('RGBA must be an 8-bit typed array');
      if (rgba.length !== width * height * 4) throw new RangeError('RGBA length does not match dimensions');
      const values = new Uint16Array(width * height);
      for (let i = 0; i < values.length; i++) {
        const p = i * 4;
        if (rgba[p + 3] !== 255) throw new Error(`Transparent pixel at (${i % width}, ${Math.floor(i / width)}); map imports require opaque pixels`);
        if (layer === 'altitude') {
          if (rgba[p] !== rgba[p + 1] || rgba[p] !== rgba[p + 2]) throw new Error(`Non-grayscale altitude at (${i % width}, ${Math.floor(i / width)})`);
          values[i] = rgba[p];
        } else {
          const rgb = (rgba[p] << 16) | (rgba[p + 1] << 8) | rgba[p + 2];
          if (this._palette.ambiguous.has(rgb)) throw new Error(`Ambiguous terrain RGB at (${i % width}, ${Math.floor(i / width)}); choose material IDs in an indexed project`);
          if (!this._palette.byRGB.has(rgb)) throw new Error(`Unknown exact terrain RGB at (${i % width}, ${Math.floor(i / width)})`);
          values[i] = this._palette.byRGB.get(rgb);
        }
      }
      // Loading an image changes only its requested plane, even when drawing is linked.
      return this._edit(() => { for (let i = 0; i < values.length; i++) this._write(i, values[i]); }, layer, null);
    }

    // Version 2 keeps the v1 planes/current mask and appends a bounded SNAP
    // section. Older files remain readable; older readers reject v2 explicitly.
    beginDecoStroke() { this._beginStroke(null); }
    fillDecoSelection(value) {
      this._idle();integer(value,0,65535,'decoration ID');
      if(!this.selectionActive)throw new Error('Select an area first');
      this.beginDecoStroke();try{for(let i=0;i<this.deco.length;i++)if(this._stroke.mask[i])this._writePlane('deco',i,value);return this.endStroke();}catch(e){this.cancelStroke();throw e;}
    }
    paintDecoLine(x0,y0,x1,y1,value) {
      if(!this._stroke)throw new Error('Begin a decoration stroke first');
      integer(value,0,65535,'decoration ID');
      this._point(x0,y0);this._point(x1,y1);
      let dx=Math.abs(x1-x0),sx=x0<x1?1:-1,dy=-Math.abs(y1-y0),sy=y0<y1?1:-1,err=dx+dy;
      for(;;){const i=y0*this.width+x0;if(this._stroke.mask[i])this._writePlane('deco',i,value);if(x0===x1&&y0===y1)break;const e=2*err;if(e>=dy){err+=dy;x0+=sx;}if(e<=dx){err+=dx;y0+=sy;}}
    }
    saveProject() {
      const base=this._saveBaseProject();
      if(!this.deco.some(v=>v!==UNSET))return base;
      if(base.length+this.deco.length*2>MAX_PROJECT_BYTES)throw new RangeError('Project exceeds supported file size');
      const bytes=new Uint8Array(base.length+this.deco.length*2);bytes.set(base);const view=new DataView(bytes.buffer);view.setUint32(8,3,true);
      for(let i=0;i<this.deco.length;i++)view.setUint16(base.length+i*2,this.deco[i],true);
      return bytes;
    }
    _saveBaseProject() {
      this._idle(); const count = dimensions(this.width, this.height), maskBytes = Math.ceil(count / 8);
      const state = SNAPSHOT_STATE.get(this), baseBytes = 32 + count * 4 + maskBytes;
      validateSnapshotSet(state.entries);
      if (typeof this.selectionActive !== 'boolean') throw new TypeError('selectionActive must be boolean');
      const sectionBytes = 24 + state.entries.reduce((total, entry) => total + 20 + entry.nameBytes.length + entry.packed.flags.length + entry.packed.bits.length, 0);
      if (baseBytes + sectionBytes > MAX_PROJECT_BYTES) throw new RangeError('Project exceeds the supported file size');
      const bytes = new Uint8Array(baseBytes + sectionBytes), view = new DataView(bytes.buffer);
      bytes.set(MAGIC); view.setUint32(8, 2, true); view.setUint32(12, this.width, true); view.setUint32(16, this.height, true); view.setUint32(20, count, true); view.setUint32(24, this._layer === 'altitude' ? 1 : 0, true); view.setUint32(28, maskBytes, true);
      for (let i = 0; i < count; i++) {
        this._value(this.terrain[i], 'terrain'); this._value(this.altitude[i], 'altitude');
        if (this.selection[i] !== 0 && this.selection[i] !== 1) throw new RangeError('Selection must be binary');
        view.setUint16(32 + i * 2, this.terrain[i], true); view.setUint16(32 + count * 2 + i * 2, this.altitude[i], true);
        if (this.selection[i]) bytes[32 + count * 4 + (i >> 3)] |= 1 << (i & 7);
      }
      bytes.set(SNAPSHOT_MAGIC, baseBytes); view.setUint32(baseBytes + 4, sectionBytes, true);
      view.setUint32(baseBytes + 8, state.entries.length, true); view.setUint32(baseBytes + 12, state.nextId, true);
      view.setUint32(baseBytes + 16, this.selectionActive ? 1 : 0, true); // +20 reserved, remains zero
      let at = baseBytes + 24;
      for (const entry of state.entries) {
        view.setUint32(at, entry.id, true); view.setUint32(at + 4, entry.nameBytes.length, true); view.setUint32(at + 8, entry.selectedPixels, true);
        view.setUint32(at + 12, entry.packed.flags.length, true); view.setUint32(at + 16, entry.packed.bits.length, true); at += 20;
        for (const part of [entry.nameBytes, entry.packed.flags, entry.packed.bits]) { bytes.set(part, at); at += part.length; }
      }
      return bytes;
    }
    static loadProject(input, palette, options = {}) {
      const bytes = input instanceof Uint8Array ? input : input instanceof ArrayBuffer ? new Uint8Array(input) : null;
      if (!bytes || bytes.length < 32 || MAGIC.some((value, i) => bytes[i] !== value)) throw new Error('Not a UO map image project');
      if (bytes.length > MAX_PROJECT_BYTES) throw new Error('Project exceeds the supported file size');
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const version = view.getUint32(8, true);
      if(version===3){
        const count=dimensions(view.getUint32(12,true),view.getUint32(16,true)),end=bytes.length-count*2;
        if(end<32)throw new Error('Invalid decoration project length');
        const base=bytes.slice(0,end);new DataView(base.buffer).setUint32(8,2,true);
        const doc=MapPaintDocument.loadProject(base,palette,options);
        for(let i=0;i<count;i++)doc.deco[i]=view.getUint16(end+i*2,true);
        return doc;
      }
      if (version !== 1 && version !== 2) throw new Error('Unsupported map image project version');
      const width = view.getUint32(12, true), height = view.getUint32(16, true), count = dimensions(width, height), maskBytes = Math.ceil(count / 8), layer = view.getUint32(24, true);
      const baseBytes = 32 + count * 4 + maskBytes;
      if (view.getUint32(20, true) !== count || view.getUint32(28, true) !== maskBytes || bytes.length < baseBytes || layer > 1) throw new Error('Project dimensions, length or layer are invalid');
      let entries = [], nextId = 1, selectionActive = true;
      if (version === 1) {
        if (bytes.length !== baseBytes) throw new Error('Project length is invalid');
      } else {
        if (bytes.length < baseBytes + 24 || SNAPSHOT_MAGIC.some((value, i) => bytes[baseBytes + i] !== value)) throw new Error('Snapshot section length or signature is invalid');
        const sectionBytes = view.getUint32(baseBytes + 4, true), snapshotCount = view.getUint32(baseBytes + 8, true), active = view.getUint32(baseBytes + 16, true);
        nextId = view.getUint32(baseBytes + 12, true);
        if (sectionBytes !== bytes.length - baseBytes || sectionBytes < 24 || snapshotCount > MAX_SELECTION_SNAPSHOTS || active > 1 || !nextId || view.getUint32(baseBytes + 20, true))
          throw new Error('Snapshot section length, count or flags are invalid');
        if (count % 8 && (bytes[baseBytes - 1] >> (count % 8))) throw new Error('Current selection padding bits must be zero');
        selectionActive = active === 1; let at = baseBytes + 24, maximumId = 0, packedBudget = 0;
        const seenIds = new Set(), seenNames = new Set();
        // Preflight all lengths, names and masks using bounded views of the input.
        // No full-size image or selection arrays are allocated until this succeeds.
        for (let n = 0; n < snapshotCount; n++) {
          if (at + 20 > bytes.length) throw new Error('Snapshot record length is invalid');
          const id = view.getUint32(at, true), nameLength = view.getUint32(at + 4, true), selectedPixels = view.getUint32(at + 8, true);
          const flagsLength = view.getUint32(at + 12, true), bitsLength = view.getUint32(at + 16, true); at += 20;
          if (!id || id > 0xFFFFFFFE || nameLength < 1 || nameLength > 320 || flagsLength !== Math.ceil(count / PAGE) || bitsLength > maskBytes ||
              selectedPixels < 1 || selectedPixels > count || at + nameLength + flagsLength + bitsLength > bytes.length) throw new Error('Snapshot record length or values are invalid');
          const named = decodeSnapshotName(bytes.subarray(at, at + nameLength)); at += nameLength;
          const packed = { flags: bytes.subarray(at, at + flagsLength), bits: bytes.subarray(at + flagsLength, at + flagsLength + bitsLength) }; at += flagsLength + bitsLength;
          const key = named.name.toLowerCase();
          if (seenIds.has(id) || seenNames.has(key)) throw new Error('Duplicate snapshot ID or name');
          seenIds.add(id); seenNames.add(key);
          packedBudget += 128 + nameLength + flagsLength + bitsLength;
          if (packedBudget > MAX_SELECTION_SNAPSHOT_BYTES) throw new Error('Snapshot storage exceeds the 64 MiB budget');
          validatePackedSnapshot(packed, count, selectedPixels);
          const entry = { id, ...named, selectedPixels, packed }; entry.bytes = snapshotBytes(entry); entries.push(entry); maximumId = Math.max(maximumId, id);
        }
        if (at !== bytes.length || nextId <= maximumId) throw new Error('Snapshot section length or next ID is invalid');
        validateSnapshotSet(entries);
      }
      // Palette/plane values are checked before allocating the document as well.
      const checkedPalette = paletteOf(palette);
      for (let i = 0; i < count; i++) {
        const terrain = view.getUint16(32 + i * 2, true), altitude = view.getUint16(32 + count * 2 + i * 2, true);
        if (terrain !== UNSET && !checkedPalette.byId.has(terrain)) throw new Error(`Unknown material ID ${terrain}`);
        if (altitude !== UNSET && altitude > 255) throw new Error('Project altitude shade is invalid');
      }
      const doc = new MapPaintDocument(width, height, palette, options);
      for (let i = 0; i < count; i++) {
        doc.terrain[i] = doc._value(view.getUint16(32 + i * 2, true), 'terrain');
        doc.altitude[i] = doc._value(view.getUint16(32 + count * 2 + i * 2, true), 'altitude');
        doc.selection[i] = (bytes[32 + count * 4 + (i >> 3)] >> (i & 7)) & 1;
      }
      // v1 has no active flag and retains its historical explicit-mask behavior.
      // v2 stores the flag directly; never infer it from an all-ones bitmap.
      doc.selectionActive = selectionActive;
      const state = SNAPSHOT_STATE.get(doc);
      state.entries = entries.map(entry => ({ ...entry, packed: { flags: entry.packed.flags.slice(), bits: entry.packed.bits.slice() } }));
      state.bytes = validateSnapshotSet(state.entries); state.nextId = nextId;
      doc._layer = layer ? 'altitude' : 'terrain'; return doc;
    }
  }
  return { MapPaintDocument, UNSET, MAX_PIXELS, MAX_PROJECT_BYTES, MAX_SELECTION_SNAPSHOTS, MAX_SELECTION_SNAPSHOT_BYTES, clipLine };
});

