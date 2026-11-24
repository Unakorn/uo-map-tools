(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.UOStudioBridge = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  var UNSET = 65535;
  var MAX_DIMENSION = 8192;
  var MAX_PIXELS = 33554432;

  function integer(value) {
    return typeof value === 'number' && isFinite(value) && Math.floor(value) === value;
  }
  function position(index, width) { return '(' + (index % width) + ', ' + Math.floor(index / width) + ')'; }

  function exportStudioProject(doc, palette) {
    if (!doc || !integer(doc.width) || !integer(doc.height) || doc.width < 1 || doc.height < 1 ||
        doc.width > MAX_DIMENSION || doc.height > MAX_DIMENSION || doc.width * doc.height > MAX_PIXELS) {
      throw new Error('Terrain Studio requires dimensions from 1 to 8192 and at most 33,554,432 pixels.');
    }
    var count = doc.width * doc.height;
    if (!doc.terrain || !doc.altitude || doc.terrain.length !== count || doc.altitude.length !== count) {
      throw new Error('Terrain and altitude planes must both exactly match the image dimensions.');
    }
    if (doc.statics && doc.statics.length) {
      throw new Error('This image export cannot preserve existing static placements. Save that document in Terrain Studio.');
    }
    var entries = Array.isArray(palette) ? palette : palette && palette.materials;
    if (!Array.isArray(entries) || entries.length === 0) throw new Error('A material palette is required.');
    var byId = Object.create(null);
    entries.forEach(function (entry) {
      if (!entry || !integer(entry.id) || entry.id < 0 || entry.id >= UNSET ||
          !integer(entry.tileId) || entry.tileId < 0 || entry.tileId > 0x3fff) {
        throw new Error('The palette contains an invalid material ID or base land tile ID.');
      }
      if (Object.prototype.hasOwnProperty.call(byId, entry.id)) throw new Error('The palette repeats material ID ' + entry.id + '.');
      byId[entry.id] = entry;
    });
    // Validate the entire source before allocating an output. No incomplete pixel is filled or guessed.
    for (var i = 0; i < count; i++) {
      var material = doc.terrain[i], shade = doc.altitude[i];
      if (material === UNSET) throw new Error('Terrain pixel ' + position(i, doc.width) + ' has not been painted.');
      if (!integer(material) || !Object.prototype.hasOwnProperty.call(byId, material)) {
        throw new Error('Terrain pixel ' + position(i, doc.width) + ' uses a material that is absent from the palette: ' + material + '.');
      }
      if (shade === UNSET) throw new Error('Altitude pixel ' + position(i, doc.width) + ' has not been set.');
      if (!integer(shade) || shade < 0 || shade > 255) {
        throw new Error('Altitude pixel ' + position(i, doc.width) + ' must have an exact shade from 0 through 255.');
      }
    }
    var bytes = new Uint8Array(24 + count * 7);
    var writer = new DataView(bytes.buffer);
    // MapIO.ProjectMagic = 0x53544F55 (ASCII UOTS), version 1; all multibyte values are little endian.
    writer.setUint32(0, 0x53544f55, true);
    writer.setInt32(4, 1, true);
    writer.setInt32(8, doc.width, true);
    writer.setInt32(12, doc.height, true);
    writer.setInt32(16, count, true);
    writer.setInt32(20, 0, true); // No generated static placements or transitions.
    for (var pixel = 0, offset = 24; pixel < count; pixel++, offset += 7) {
      var id = doc.terrain[pixel];
      writer.setUint16(offset, byId[id].tileId, true);
      writer.setInt8(offset + 2, doc.altitude[pixel] - 128);
      writer.setInt32(offset + 3, id, true);
    }
    return bytes;
  }

  return { exportStudioProject: exportStudioProject };
});
