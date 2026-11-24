/* Exact indexed-height smoothing. All previews use immutable source snapshots;
 * commits optionally map terrain through the document's paired atomic transaction. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MapPaintSmoothing = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const UNSET = 65535, PLANS = new WeakMap(), BRUSHES = new WeakMap();
  const MAX_COMPONENTS = 65536, MAX_WORK = 134217728, MAX_MELT_CROP = 4194304, MAX_BRUSH_PIXELS = 2097152, MAX_POINTS = 100000, TILE = 64;
  function integer(value, min, max, name) {
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new RangeError(`${name} must be an integer from ${min} to ${max}`);
    return value;
  }
  function settings(value, mode) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Smoothing options must be an object');
    const result = { strength: integer(value.strength === undefined ? (mode === 'melt' ? 100 : 50) : value.strength, 1, 100, 'Strength') };
    if (mode === 'melt') result.width = integer(value.width === undefined ? 16 : value.width, 1, 128, 'Melt width');
    else result.radius = integer(value.radius === undefined ? 4 : value.radius, 1, 64, 'Blur radius');
    if (mode === 'brush') result.size = integer(value.size === undefined ? 32 : value.size, 1, 256, 'Brush size');
    return Object.freeze(result);
  }
  function charge(record, amount) {
    if (record.work + amount > MAX_WORK) throw new RangeError('This smoothing operation is too complex. Use a smaller selection or a shorter brush stroke.');
    record.work += amount;
  }
  function smooth(t) { return t * t * (3 - 2 * t); }
  function blend(source, mean, strength) { return Math.max(0, Math.min(255, Math.round(source + (mean - source) * strength))); }
  function capture(owner, mode, options, helpers) {
    owner._idle();
    if (owner.currentLayer !== 'altitude') throw new Error('Blur and Melt are available only on the altitude layer');
    const count = owner.width * owner.height, mask = owner.selection.slice();
    let selected = 0, anchors = 0, left = owner.width, top = owner.height, right = -1, bottom = -1;
    for (let i = 0; i < count; i++) {
      if (mask[i] !== 0 && mask[i] !== 1) throw new RangeError('Selection must be binary');
      if (!mask[i]) { if (owner.altitude[i] <= 255) anchors++; continue; } selected++; const x = i % owner.width, y = Math.floor(i / owner.width);
      left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
    }
    if (mode === 'melt' && (!owner.selectionActive || !selected)) throw new Error('Select a nonempty area before using Melt edges');
    return { owner, helpers, mode, options, width: owner.width, height: owner.height, altitude: owner.altitude, terrain: owner.terrain,
      source: owner.altitude.slice(), beforeTerrain: owner._paintLink ? owner.terrain.slice() : null, link: owner._paintLink,
      selectionRef: owner.selection, selectionActive: owner.selectionActive, selectionRevision: owner.selectionRevision,
      mask, packedMask: helpers.packMask(mask), selected, anchors, labels: null, components: null, work: 0, finished: null,
      bounds: selected ? Object.freeze({ left, top, width: right - left + 1, height: bottom - top + 1 }) : null };
  }
  function check(record, owner) {
    if (!record || record.owner !== owner) throw new Error('This smoothing preview belongs to a different document');
    if (record.finished) throw new Error(`This smoothing preview has already been ${record.finished}`);
    owner._idle();
    if (owner.currentLayer !== 'altitude' || owner.width !== record.width || owner.height !== record.height || owner.altitude !== record.altitude ||
        owner.terrain !== record.terrain || owner._paintLink !== record.link || owner.selection !== record.selectionRef ||
        owner.selectionActive !== record.selectionActive || owner.selectionRevision !== record.selectionRevision)
      throw new Error('The smoothing preview is stale; preview again after changing the image, selection or linked painting');
    return record;
  }
  function verifySources(record) {
    const owner = record.owner;
    if (!record.helpers.samePackedMask(owner.selection, record.packedMask)) throw new Error('The smoothing preview is stale; the selection changed');
    for (let i = 0; i < record.source.length; i++) if (owner.altitude[i] !== record.source[i] || (record.beforeTerrain && owner.terrain[i] !== record.beforeTerrain[i]))
      throw new Error('The smoothing preview is stale; the source image changed');
  }
  function components(record) {
    if (record.components) return;
    const { width, height, mask, selected } = record, count = mask.length;
    if (!selected) { record.components = []; return; }
    if (selected === count) { record.components = [{ id: 1, left: 0, top: 0, width, height }]; return; }
    const labels = new Uint32Array(count), list = [];
    let stack = new Uint32Array(1024), used = 0;
    const push = point => {
      if (used === stack.length) {
        const capacity = Math.min(count, stack.length * 2);
        if (capacity <= stack.length) throw new RangeError('This selection is too complex to label safely. Use a less fragmented selection.');
        const next = new Uint32Array(capacity); next.set(stack); stack = next;
      }
      stack[used++] = point;
    };
    for (let seed = 0; seed < count; seed++) {
      if (!mask[seed] || labels[seed]) continue;
      if (list.length >= MAX_COMPONENTS) throw new RangeError('This selection has too many separate islands to blur. Use a less fragmented selection.');
      const id = list.length + 1; let left = width, right = -1, top = height, bottom = -1; push(seed);
      while (used) {
        const point = stack[--used]; if (labels[point]) continue;
        const y = Math.floor(point / width), row = y * width; let a = point % width, b = a;
        while (a > 0 && mask[row + a - 1] && !labels[row + a - 1]) a--;
        while (b + 1 < width && mask[row + b + 1] && !labels[row + b + 1]) b++;
        labels.fill(id, row + a, row + b + 1); left = Math.min(left, a); right = Math.max(right, b); top = Math.min(top, y); bottom = Math.max(bottom, y);
        for (const nextY of [y - 1, y + 1]) {
          if (nextY < 0 || nextY >= height) continue; let inRun = false;
          for (let x = a; x <= b; x++) {
            const i = nextY * width + x, match = mask[i] && !labels[i];
            if (match && !inRun) push(i); inRun = !!match;
          }
        }
      }
      list.push({ id, left, top, width: right - left + 1, height: bottom - top + 1 });
    }
    record.labels = labels; record.components = list;
  }
  function componentId(record, i) { return record.mask[i] ? (record.labels ? record.labels[i] : 1) : 0; }
  // Streaming separable normalized box kernel. Only (2r+1) horizontal rows are
  // retained; full-facet sum/count/Float64 grids are never allocated.
  function box(record, bounds, radius, read, emit) {
    if (!bounds || !bounds.width || !bounds.height) return;
    const w = bounds.width, h = bounds.height, rows = radius * 2 + 1;
    charge(record, (w + radius * 2) * (h + radius * 2));
    const rowSums = new Uint32Array(rows * w), rowCounts = new Uint16Array(rows * w), sums = new Uint32Array(w), counts = new Uint32Array(w);
    const row = (y, slot, remove) => {
      const offset = slot * w;
      if (remove) for (let x = 0; x < w; x++) { sums[x] -= rowSums[offset + x]; counts[x] -= rowCounts[offset + x]; }
      let sum = 0, count = 0;
      const sample = x => x < 0 || x >= record.width || y < 0 || y >= record.height ? -1 : read(y * record.width + x);
      for (let x = bounds.left - radius; x <= bounds.left + radius; x++) { const value = sample(x); if (value >= 0 && value <= 255) { sum += value; count++; } }
      for (let x = 0; x < w; x++) {
        rowSums[offset + x] = sum; rowCounts[offset + x] = count; sums[x] += sum; counts[x] += count;
        const before = sample(bounds.left + x - radius), after = sample(bounds.left + x + radius + 1);
        if (before >= 0 && before <= 255) { sum -= before; count--; }
        if (after >= 0 && after <= 255) { sum += after; count++; }
      }
    };
    for (let slot = 0; slot < rows; slot++) row(bounds.top - radius + slot, slot, false);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) emit(bounds.left + x, bounds.top + y, sums[x], counts[x]);
      if (y + 1 < h) row(bounds.top + y + radius + 1, y % rows, true);
    }
  }
  function filter(owner, mode, value, helpers) {
    const opts = settings(value || {}, mode), record = capture(owner, mode, opts, helpers), b = record.bounds;
    const shades = new Uint16Array(b ? b.width * b.height : 0); shades.fill(UNSET); let pixelCount = 0;
    const emit = (x, y, shade) => { shades[(y - b.top) * b.width + x - b.left] = shade; pixelCount++; };
    if (mode === 'blur') {
      components(record);
      for (const component of record.components) box(record, component, opts.radius,
        i => componentId(record, i) === component.id && record.source[i] <= 255 ? record.source[i] : -1,
        (x, y, sum, count) => {
          const i = y * record.width + x;
          if (count && componentId(record, i) === component.id && record.source[i] <= 255) emit(x, y, blend(record.source[i], sum / count, opts.strength / 100));
        });
    } else if (b && record.anchors) {
      // Distance needs only the selected bounds plus the requested band radius.
      // Real unselected pixels are seeds; the area outside the image is not an anchor.
      const left = Math.max(0, b.left - opts.width - 1), top = Math.max(0, b.top - opts.width - 1);
      const right = Math.min(record.width - 1, b.left + b.width + opts.width), bottom = Math.min(record.height - 1, b.top + b.height + opts.width);
      const width = right - left + 1, height = bottom - top + 1;
      if (width * height > MAX_MELT_CROP) throw new RangeError('This Melt area is too large (maximum 4,194,304 pixels including its outside band). Select a smaller region.');
      charge(record, width * height * 3);
      const distance = new Uint32Array(width * height); distance.fill(0x3FFFFFFF);
      for (let y = top; y <= bottom; y++) for (let x = left; x <= right; x++) if (!record.mask[y * record.width + x]) distance[(y - top) * width + x - left] = 0;
      helpers.edgeDistanceSquared(distance, width, height);
      const stride = width + 1, sums = new Float64Array(stride * (height + 1)), counts = new Uint32Array(sums.length);
      for (let y = 0; y < height; y++) {
        let sum = 0, count = 0;
        for (let x = 0; x < width; x++) {
          const source = (y + top) * record.width + x + left, target = (y + 1) * stride + x + 1;
          if (!record.mask[source] && record.source[source] <= 255) { sum += record.source[source]; count++; }
          sums[target] = sums[target - stride] + sum; counts[target] = counts[target - stride] + count;
        }
      }
      for (let y = b.top; y < b.top + b.height; y++) for (let x = b.left; x < b.left + b.width; x++) {
        const i = y * record.width + x; if (!record.mask[i] || record.source[i] > 255) continue;
        const d = Math.sqrt(distance[(y - top) * width + x - left]), depth = Math.max(0, d - 1); if (depth >= opts.width) continue;
        // Near the seam use local anchors; deeper pixels combine a wider set of
        // outside heights. A thin strip receives contributions from both sides.
        const radius = Math.min(opts.width, Math.max(1, 2 * Math.ceil(d)));
        const x0 = Math.max(left, x - radius) - left, x1 = Math.min(right, x + radius) - left + 1;
        const y0 = Math.max(top, y - radius) - top, y1 = Math.min(bottom, y + radius) - top + 1;
        const a = y0 * stride + x0, c = y0 * stride + x1, e = y1 * stride + x0, f = y1 * stride + x1;
        const count = counts[f] - counts[c] - counts[e] + counts[a]; if (!count) continue;
        const mean = (sums[f] - sums[c] - sums[e] + sums[a]) / count;
        emit(x, y, blend(record.source[i], mean, opts.strength / 100 * (1 - smooth(depth / opts.width))));
      }
    }
    const plan = Object.freeze({ mode, options: opts, bounds: b, pixelCount, workUnits: record.work,
      valueAt: (x, y, layer = 'altitude') => {
        if (record.finished === 'canceled' || !b || !Number.isInteger(x) || !Number.isInteger(y) || x < b.left || y < b.top || x >= b.left + b.width || y >= b.top + b.height) return undefined;
        const shade = shades[(y - b.top) * b.width + x - b.left]; if (shade === UNSET) return undefined;
        return layer === 'altitude' ? shade : undefined;
      },
      cancel: () => { if (record.finished) return false; record.finished = 'canceled'; return true; }
    });
    PLANS.set(plan, { record, shades }); return plan;
  }
  function apply(owner, plan) {
    const saved = PLANS.get(plan); if (!saved) throw new Error('This is not a smoothing filter preview');
    const record = check(saved.record, owner); verifySources(record); const b = record.bounds;
    const result = owner._edit(() => {
      if (b) for (let y = 0; y < b.height; y++) for (let x = 0; x < b.width; x++) {
        const shade = saved.shades[y * b.width + x]; if (shade !== UNSET) owner._write((y + b.top) * record.width + x + b.left, shade);
      }
    }, 'altitude', record.link);
    record.finished = 'applied'; return Object.assign(result, { mode: record.mode, footprintPixels: plan.pixelCount });
  }
  function brushMean(record, index) {
    const id = componentId(record, index), x = index % record.width, y = Math.floor(index / record.width), tx = Math.floor(x / TILE), ty = Math.floor(y / TILE);
    const key = id + ':' + tx + ':' + ty; let tile = record.tiles.get(key);
    if (!tile) {
      const component = record.components[id - 1];
      const left = Math.max(component.left, tx * TILE), top = Math.max(component.top, ty * TILE);
      const right = Math.min(component.left + component.width - 1, tx * TILE + TILE - 1), bottom = Math.min(component.top + component.height - 1, ty * TILE + TILE - 1);
      const bounds = { left, top, width: right - left + 1, height: bottom - top + 1 }, means = new Float64Array(bounds.width * bounds.height); means.fill(NaN);
      box(record, bounds, record.options.radius, i => componentId(record, i) === id && record.source[i] <= 255 ? record.source[i] : -1,
        (px, py, sum, count) => { const i = py * record.width + px; if (count && componentId(record, i) === id && record.source[i] <= 255) means[(py - top) * bounds.width + px - left] = sum / count; });
      tile = { bounds, means }; record.tiles.set(key, tile);
    }
    return tile.means[(y - tile.bounds.top) * tile.bounds.width + x - tile.bounds.left];
  }
  function reserveBrush(record, count) {
    if (record.indices.length >= count) return;
    let capacity = Math.max(1024, record.indices.length);
    while (capacity < count) capacity = Math.min(MAX_BRUSH_PIXELS, capacity * 2);
    const indices = new Uint32Array(capacity), coverage = new Float64Array(capacity), means = new Float64Array(capacity), shades = new Uint16Array(capacity);
    indices.set(record.indices); coverage.set(record.coverage); means.set(record.means); shades.set(record.shades);
    Object.assign(record, { indices, coverage, means, shades });
  }
  function brushSegment(record, x0, y0, x1, y1) {
    const radius = record.options.size / 2, dx = x1 - x0, dy = y1 - y0, squared = dx * dx + dy * dy;
    // Pixel-center capsule coverage follows the complete continuous segment, so
    // fast pointer motion cannot leave holes between circular dabs.
    const clipped = record.helpers.clipLine(x0, y0, x1, y1, -Math.ceil(radius), -Math.ceil(radius), record.width - 1 + Math.ceil(radius), record.height - 1 + Math.ceil(radius));
    if (!clipped) return;
    const left = Math.max(0, Math.floor(Math.min(clipped[0], clipped[2]) - radius)), right = Math.min(record.width - 1, Math.ceil(Math.max(clipped[0], clipped[2]) + radius));
    const top = Math.max(0, Math.floor(Math.min(clipped[1], clipped[3]) - radius)), bottom = Math.min(record.height - 1, Math.ceil(Math.max(clipped[1], clipped[3]) + radius));
    // Stage all coverage/mean changes before changing the retained preview, so a
    // footprint or kernel-budget failure leaves the earlier stroke applicable.
    let updateCount = 0, additions = 0, updateCapacity = 1024;
    let updateIndices = new Uint32Array(updateCapacity), updateCoverage = new Float64Array(updateCapacity), updateMeans = new Float64Array(updateCapacity);
    const stage = (index, coverage, mean) => {
      if (updateCount === updateCapacity) {
        updateCapacity = Math.min(MAX_BRUSH_PIXELS, updateCapacity * 2);
        const indices = new Uint32Array(updateCapacity), coverages = new Float64Array(updateCapacity), means = new Float64Array(updateCapacity);
        indices.set(updateIndices); coverages.set(updateCoverage); means.set(updateMeans);
        updateIndices = indices; updateCoverage = coverages; updateMeans = means;
      }
      updateIndices[updateCount] = index; updateCoverage[updateCount] = coverage; updateMeans[updateCount++] = mean;
    };
    for (let y = top; y <= bottom; y++) for (let x = left; x <= right; x++) {
      const i = y * record.width + x; if (!record.mask[i] || record.source[i] > 255) continue;
      const t = squared ? Math.max(0, Math.min(1, ((x - x0) * dx + (y - y0) * dy) / squared)) : 0;
      const distance = Math.hypot(x - x0 - t * dx, y - y0 - t * dy); if (distance >= radius) continue;
      const coverage = smooth(1 - distance / radius), previous = record.pixels.get(i);
      if (previous !== undefined && record.coverage[previous] >= coverage) continue;
      if (previous === undefined && record.pixels.size + ++additions > MAX_BRUSH_PIXELS) throw new RangeError('This blur stroke covers too many pixels (maximum 2,097,152). Release it and start another stroke.');
      const mean = previous === undefined ? brushMean(record, i) : record.means[previous]; if (!Number.isFinite(mean)) continue;
      stage(i, coverage, mean);
    }
    reserveBrush(record, record.pixels.size + additions);
    let b = record.footprint, minX = b ? b.left : record.width, minY = b ? b.top : record.height, maxX = b ? b.left + b.width - 1 : -1, maxY = b ? b.top + b.height - 1 : -1;
    for (let at = 0; at < updateCount; at++) {
      const i = updateIndices[at]; let slot = record.pixels.get(i);
      if (slot === undefined) { slot = record.pixels.size; record.pixels.set(i, slot); record.indices[slot] = i; }
      record.coverage[slot] = updateCoverage[at]; record.means[slot] = updateMeans[at];
      record.shades[slot] = blend(record.source[i], updateMeans[at], record.options.strength / 100 * updateCoverage[at]);
      const x = i % record.width, y = Math.floor(i / record.width); minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
    }
    if (record.pixels.size) record.footprint = Object.freeze({ left: minX, top: minY, width: maxX - minX + 1, height: maxY - minY + 1 });
  }
  function createBrush(owner, x, y, value, helpers) {
    integer(x, -1000000000, 1000000000, 'Brush x'); integer(y, -1000000000, 1000000000, 'Brush y');
    const opts = settings(value || {}, 'brush'), record = capture(owner, 'brush', opts, helpers); components(record);
    Object.assign(record, { pixels: new Map(), tiles: new Map(), footprint: null, lastX: x, lastY: y, points: 1,
      indices: new Uint32Array(0), coverage: new Float64Array(0), means: new Float64Array(0), shades: new Uint16Array(0) });
    const session = Object.freeze({ mode: 'blur-brush', options: opts,
      get bounds() { return record.footprint; }, get pixelCount() { return record.pixels.size; }, get workUnits() { return record.work; },
      addPoint: (px, py) => {
        check(record, owner); integer(px, -1000000000, 1000000000, 'Brush x'); integer(py, -1000000000, 1000000000, 'Brush y');
        if (px === record.lastX && py === record.lastY) return session;
        if (record.points >= MAX_POINTS) throw new RangeError('This blur stroke is too long. Release it and start another stroke.');
        brushSegment(record, record.lastX, record.lastY, px, py); record.lastX = px; record.lastY = py; record.points++; return session;
      },
      valueAt: (px, py, layer = 'altitude') => {
        const b = record.footprint;
        if (record.finished === 'canceled' || !b || !Number.isInteger(px) || !Number.isInteger(py) || px < b.left || py < b.top || px >= b.left + b.width || py >= b.top + b.height) return undefined;
        const slot = record.pixels.get(py * record.width + px); if (slot === undefined) return undefined;
        const shade = record.shades[slot];
        return layer === 'altitude' ? shade : undefined;
      },
      cancel: () => {
        if (record.finished) return false; record.finished = 'canceled'; record.pixels.clear(); record.tiles.clear();
        record.source = record.beforeTerrain = record.mask = record.labels = record.packedMask = null;
        record.indices = new Uint32Array(0); record.coverage = record.means = new Float64Array(0); record.shades = new Uint16Array(0); return true;
      }
    });
    BRUSHES.set(session, record); brushSegment(record, x, y, x, y); return session;
  }
  function applyBrush(owner, session) {
    const record = check(BRUSHES.get(session), owner); verifySources(record);
    const result = owner._edit(() => { for (let slot = 0; slot < record.pixels.size; slot++) owner._write(record.indices[slot], record.shades[slot]); }, 'altitude', record.link);
    record.finished = 'applied'; return Object.assign(result, { mode: 'blur-brush', footprintPixels: record.pixels.size });
  }
  return Object.freeze({ filter, apply, createBrush, applyBrush });
});
