using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;

namespace TerrainStudio
{
    /// <summary>Writes metadata and coverage reports only. It never copies or modifies client artwork.</summary>
    public static class ClientAudit
    {
        sealed class Reference
        {
            public int Id, Rules, TextureId, ArtSourceId;
            public bool Land, IndexedArt, DirectArt, TexturePresent;
            public string Name;
            public readonly List<int> BaseMaterials = new List<int>();
            public PixelFacts Art, Texture;
            public bool HasDecodedVisual { get { return (Art != null && Art.NonTransparent > 0) || (Texture != null && Texture.NonTransparent > 0); } }
        }
        sealed class PixelFacts
        {
            public bool Decoded;
            public int Width, Height, NonTransparent, NonBlack;
            public bool MultipleColors;
            public string Error = "";
        }
        sealed class MaterialFacts
        {
            public int CenterRules, MixedCenterRules, ReferencedRules;
            public bool CommonRule;
        }
        static StreamWriter Writer(string folder, string name)
        {
            return new StreamWriter(Path.Combine(folder, name), false, new UTF8Encoding(true));
        }
        static string Escape(object value)
        {
            string s = Convert.ToString(value, CultureInfo.InvariantCulture) ?? "";
            return "\"" + s.Replace("\"", "\"\"") + "\"";
        }
        static void Row(StreamWriter writer, params object[] values) { writer.WriteLine(String.Join(",", values.Select(Escape))); }
        static string Ids<T>(IEnumerable<T> values) { return String.Join(";", values); }
        static PixelFacts Pixels(Func<Bitmap> load)
        {
            var facts = new PixelFacts();
            try
            {
                using (Bitmap bitmap = load())
                {
                    if (bitmap == null) return facts;
                    facts.Decoded = true; facts.Width = bitmap.Width; facts.Height = bitmap.Height;
                    var rect = new Rectangle(0, 0, bitmap.Width, bitmap.Height);
                    var data = bitmap.LockBits(rect, ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
                    try
                    {
                        int? first = null;
                        int[] row = new int[bitmap.Width];
                        for (int y = 0; y < bitmap.Height; y++)
                        {
                            Marshal.Copy(IntPtr.Add(data.Scan0, y * data.Stride), row, 0, row.Length);
                            foreach (int pixel in row)
                            {
                                if (((uint)pixel >> 24) == 0) continue;
                                facts.NonTransparent++;
                                if ((pixel & 0xFFFFFF) != 0) facts.NonBlack++;
                                if (first.HasValue && first.Value != (pixel & 0xFFFFFF)) facts.MultipleColors = true;
                                else if (!first.HasValue) first = pixel & 0xFFFFFF;
                            }
                        }
                    }
                    finally { bitmap.UnlockBits(data); }
                }
            }
            catch (Exception ex)
            {
                if (!(ex is IOException || ex is ArgumentException || ex is InvalidOperationException || ex is ExternalException)) throw;
                facts.Error = ex.Message;
            }
            return facts;
        }
        static Reference Get(Dictionary<int, Reference> refs, int id, bool land)
        {
            Reference r;
            if (!refs.TryGetValue(id, out r)) { r = new Reference { Id = id, Land = land }; refs.Add(id, r); }
            return r;
        }
        static void AssetHeader(StreamWriter writer)
        {
            Row(writer, "kind", "id_decimal", "id_hex", "name", "base_material_ids", "valid_rule_reference_count", "direct_indexed_art_present", "effective_indexed_art_present", "effective_art_source_tile_id", "associated_texture_id", "effective_texture_present", "art_decoded", "art_width", "art_height", "art_nontransparent_pixels", "art_nonblack_pixels", "art_multiple_rgb_colors", "texture_decoded", "texture_nontransparent_pixels", "has_decoded_visible_pixels", "decode_error");
        }
        static void AssetRow(StreamWriter writer, Reference r)
        {
            var art = r.Art ?? new PixelFacts(); var texture = r.Texture ?? new PixelFacts();
            Row(writer, r.Land ? "land" : "static", r.Id, "0x" + r.Id.ToString("X4"), r.Name, Ids(r.BaseMaterials), r.Rules, r.DirectArt, r.IndexedArt, r.ArtSourceId,
                r.Land ? r.TextureId.ToString(CultureInfo.InvariantCulture) : "", r.TexturePresent,
                art.Decoded, art.Width, art.Height, art.NonTransparent, art.NonBlack, art.MultipleColors,
                texture.Decoded, texture.NonTransparent, r.HasDecodedVisual, art.Error + texture.Error);
        }

        public static string Write(Catalog catalog, ClientAssets assets, string outputFolder)
        {
            if (catalog == null) throw new ArgumentNullException("catalog");
            if (assets == null) throw new ArgumentNullException("assets");
            string destination = Path.GetFullPath(outputFolder);
            string client = Path.GetFullPath(assets.Folder).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            if (String.Equals(destination, client, StringComparison.OrdinalIgnoreCase) || destination.StartsWith(client + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
                throw new ArgumentException("Choose a report folder outside the installed client directory.");
            foreach (string name in new[] { "catalog-referenced-assets.csv", "catalog-missing-assets.csv", "catalog-materials.csv", "catalog-rules.csv", "client-land-slots.csv", "client-static-slots.csv", "client-texture-slots.csv", "client-files.csv", "client-art-def.csv", "summary.txt", "warnings.txt" })
                if (File.Exists(Path.Combine(destination, name)) || Directory.Exists(Path.Combine(destination, name)))
                    throw new IOException("An audit report already exists in this folder. Choose a fresh output folder to preserve existing files: " + destination);
            Directory.CreateDirectory(destination);
            var rules = catalog.RuleInventory().ToList();
            var materialIds = new HashSet<int>(catalog.Terrains.Select(t => t.Id));
            var materialFacts = catalog.Terrains.ToDictionary(t => t.Id, t => new MaterialFacts());
            var land = new Dictionary<int, Reference>(); var statics = new Dictionary<int, Reference>();
            foreach (var t in catalog.Terrains) Get(land, t.TileId, true).BaseMaterials.Add(t.Id);
            var undefined = new SortedSet<int>();
            int unreachable = 0, common = 0;
            foreach (var rule in rules)
            {
                int[] distinct = rule.Materials.Distinct().ToArray();
                if (distinct.Length == 1) common++;
                if (distinct.Any(id => !materialIds.Contains(id))) unreachable++;
                foreach (int id in distinct)
                {
                    MaterialFacts facts;
                    if (!materialFacts.TryGetValue(id, out facts)) undefined.Add(id);
                    else facts.ReferencedRules++;
                }
                MaterialFacts center;
                if (materialFacts.TryGetValue(rule.CenterMaterialId, out center))
                {
                    center.CenterRules++;
                    if (distinct.Length > 1) center.MixedCenterRules++; else center.CommonRule = true;
                }
                foreach (ushort id in rule.LandTileIds.Distinct()) Get(land, id, true).Rules++;
                foreach (ushort id in rule.StaticTileIds.Distinct()) Get(statics, id, false).Rules++;
            }
            var textureFacts = new Dictionary<int, PixelFacts>();
            foreach (var r in land.Values)
            {
                r.Name = assets.LandName(r.Id); r.IndexedArt = assets.HasLandArt(r.Id);
                r.DirectArt = assets.HasDirectLandArt(r.Id); r.ArtSourceId = assets.LandArtSourceId(r.Id);
                r.TextureId = assets.LandTextureId(r.Id);
                r.TexturePresent = r.TextureId != 0 && assets.HasTexture(r.TextureId);
                int id = r.Id;
                r.Art = Pixels(() => assets.LandArtPreview(id));
                if (r.TexturePresent)
                {
                    PixelFacts pixels;
                    if (!textureFacts.TryGetValue(r.TextureId, out pixels))
                    {
                        int textureId = r.TextureId;
                        pixels = Pixels(() => assets.TexturePreview(textureId)); textureFacts.Add(textureId, pixels);
                    }
                    r.Texture = pixels;
                }
            }
            foreach (var r in statics.Values)
            {
                r.Name = assets.StaticName(r.Id); r.IndexedArt = assets.HasStaticArt(r.Id);
                r.DirectArt = assets.HasDirectStaticArt(r.Id); r.ArtSourceId = assets.StaticArtSourceId(r.Id);
                int id = r.Id; r.Art = Pixels(() => assets.StaticPreview(id));
            }
            using (var writer = Writer(destination, "catalog-referenced-assets.csv"))
            using (var missing = Writer(destination, "catalog-missing-assets.csv"))
            {
                AssetHeader(writer); AssetHeader(missing);
                foreach (var r in land.Values.OrderBy(r => r.Id).Concat(statics.Values.OrderBy(r => r.Id)))
                { AssetRow(writer, r); if (!r.HasDecodedVisual) AssetRow(missing, r); }
            }
            using (var writer = Writer(destination, "catalog-materials.csv"))
            {
                Row(writer, "material_id", "name", "rgb", "base_land_id", "base_visual_decodes", "common_rule_present", "center_rule_count", "mixed_center_rule_count", "all_rule_reference_count");
                foreach (var t in catalog.Terrains.OrderBy(t => t.Id))
                {
                    var facts = materialFacts[t.Id];
                    Row(writer, t.Id, t.Name, "#" + (t.Color.ToArgb() & 0xFFFFFF).ToString("X6"), t.TileId, land[t.TileId].HasDecodedVisual,
                        facts.CommonRule, facts.CenterRules, facts.MixedCenterRules, facts.ReferencedRules);
                }
            }
            using (var writer = Writer(destination, "catalog-rules.csv"))
            {
                Row(writer, "hash_key", "source_xml", "center_material_id", "distinct_material_ids", "all_materials_defined", "undefined_material_ids", "land_candidates", "static_candidates", "land_candidates_without_decoded_visual", "static_candidates_without_decoded_visual");
                foreach (var rule in rules)
                {
                    var ids = rule.Materials.Distinct().OrderBy(x => x).ToArray();
                    Row(writer, rule.Key, rule.Source, rule.CenterMaterialId, Ids(ids), ids.All(materialIds.Contains), Ids(ids.Where(id => !materialIds.Contains(id))),
                        Ids(rule.LandTileIds), Ids(rule.StaticTileIds), Ids(rule.LandTileIds.Where(id => !land[id].HasDecodedVisual)), Ids(rule.StaticTileIds.Where(id => !statics[id].HasDecodedVisual)));
                }
            }
            int landIndexed = 0, staticIndexed = 0, directLand = 0, directStatic = 0, landWithTexture = 0, availableTextures = 0, directTextures = 0;
            var associatedTextures = new HashSet<int>();
            using (var writer = Writer(destination, "client-land-slots.csv"))
            {
                Row(writer, "land_id", "hex", "name_or_numeric_fallback", "direct_indexed_art_present", "effective_indexed_art_present", "effective_art_source_land_id", "associated_texture_id", "effective_associated_texture_present", "catalog_base_material_ids", "catalog_rule_reference_count");
                for (int id = 0; id < 0x4000; id++)
                {
                    bool art = assets.HasLandArt(id); if (art) landIndexed++;
                    bool direct = assets.HasDirectLandArt(id); if (direct) directLand++;
                    int texture = assets.LandTextureId(id); bool hasTexture = texture != 0 && assets.HasTexture(texture);
                    if (texture != 0) associatedTextures.Add(texture);
                    if (hasTexture) landWithTexture++;
                    Reference reference; land.TryGetValue(id, out reference);
                    Row(writer, id, "0x" + id.ToString("X4"), assets.LandName(id), direct, art, assets.LandArtSourceId(id), texture, hasTexture, reference == null ? "" : Ids(reference.BaseMaterials), reference == null ? 0 : reference.Rules);
                }
            }
            using (var writer = Writer(destination, "client-static-slots.csv"))
            {
                Row(writer, "static_id", "hex", "name_or_numeric_fallback", "direct_indexed_art_present", "effective_indexed_art_present", "effective_art_source_static_id", "catalog_rule_reference_count");
                for (int id = 0; id < 0x10000; id++)
                {
                    bool art = assets.HasStaticArt(id); if (art) staticIndexed++;
                    bool direct = assets.HasDirectStaticArt(id); if (direct) directStatic++;
                    Reference reference; statics.TryGetValue(id, out reference);
                    Row(writer, id, "0x" + id.ToString("X4"), assets.StaticName(id), direct, art, assets.StaticArtSourceId(id), reference == null ? 0 : reference.Rules);
                }
            }
            using (var writer = Writer(destination, "client-texture-slots.csv"))
            {
                Row(writer, "texture_id", "direct_indexed_present", "effective_indexed_present", "effective_source_texture_id", "associated_with_any_land", "decoded_for_catalog", "decoded_nontransparent_pixels");
                for (int id = 0; id < assets.TextureCount; id++)
                {
                    bool present = assets.HasTexture(id), direct = assets.HasDirectTexture(id);
                    if (present) availableTextures++; if (direct) directTextures++;
                    PixelFacts pixels; textureFacts.TryGetValue(id, out pixels);
                    Row(writer, id, direct, present, assets.TextureSourceId(id), associatedTextures.Contains(id), pixels != null && pixels.Decoded, pixels == null ? "" : pixels.NonTransparent.ToString(CultureInfo.InvariantCulture));
                }
            }
            string version = "unavailable";
            using (var writer = Writer(destination, "client-files.csv"))
            {
                Row(writer, "file", "bytes", "last_write_utc", "file_version");
                foreach (string name in new[] { "client.exe", "tiledata.mul", "artLegacyMUL.uop", "artidx.mul", "art.mul", "art.def", "texidx.mul", "texmaps.mul", "TexTerr.def", "verdata.mul" })
                {
                    string path = Path.Combine(assets.Folder, name);
                    if (!File.Exists(path)) continue;
                    var file = new FileInfo(path);
                    string fileVersion = name == "client.exe" ? FileVersionInfo.GetVersionInfo(path).FileVersion : "";
                    if (name == "client.exe") version = fileVersion;
                    Row(writer, name, file.Length, file.LastWriteTimeUtc.ToString("O", CultureInfo.InvariantCulture), fileVersion);
                }
            }
            int defCount = WriteArtDef(assets, destination);
            int missingLand = land.Values.Count(r => !r.HasDecodedVisual), missingStatics = statics.Values.Count(r => !r.HasDecodedVisual);
            var summary = new StringBuilder();
            summary.AppendLine("UO Terrain Studio — client and transition catalog audit");
            summary.AppendLine("Generated UTC: " + DateTime.UtcNow.ToString("O", CultureInfo.InvariantCulture));
            summary.AppendLine("Client: " + assets.Folder);
            summary.AppendLine("Client executable file version (metadata only, not executed): " + version);
            summary.AppendLine(assets.Summary);
            summary.AppendLine();
            summary.AppendLine(String.Format(CultureInfo.InvariantCulture, "Numeric land slots: 16,384. Directly indexed land art: {0:N0}; effective available after art aliases: {1:N0}. Land slots with an available associated terrain texture: {2:N0}.", directLand, landIndexed, landWithTexture));
            summary.AppendLine(String.Format(CultureInfo.InvariantCulture, "Numeric static slots: 65,536. Directly indexed static art: {0:N0}; effective available after art aliases: {1:N0}.", directStatic, staticIndexed));
            summary.AppendLine(String.Format(CultureInfo.InvariantCulture, "Texture index slots: {0:N0}; directly available: {1:N0}; effective available after texture remaps: {2:N0}; distinct nonzero texture IDs associated with land: {3:N0}.", assets.TextureCount, directTextures, availableTextures, associatedTextures.Count));
            summary.AppendLine("Indexed availability checks entry metadata and supported storage. It does not prove that artwork decodes, contains useful pixels, or represents a particular material or transition.");
            summary.AppendLine();
            summary.AppendLine(catalog.Summary);
            summary.AppendLine(String.Format(CultureInfo.InvariantCulture, "Rule inventory: {0:N0} common single-material patterns; {1:N0} mixed-material patterns. {2:N0} rules reference at least one undefined material ({3}) and cannot be produced solely from the configured material palette.", common, rules.Count - common, unreachable, Ids(undefined)));
            summary.AppendLine(String.Format(CultureInfo.InvariantCulture, "Unique referenced land IDs (base materials and valid rules combined): {0:N0}; referenced transition-static IDs: {1:N0}. Every one of these references was decoded for this audit.", land.Count, statics.Count));
            summary.AppendLine(String.Format(CultureInfo.InvariantCulture, "Referenced land IDs without any decoded visible land-art or associated-texture pixels: {0:N0}. Referenced static IDs without decoded visible pixels: {1:N0}.", missingLand, missingStatics));
            if (missingLand > 0) summary.AppendLine("Missing land references: " + String.Join(", ", land.Values.Where(r => !r.HasDecodedVisual).OrderBy(r => r.Id).Select(r => r.Id + " (0x" + r.Id.ToString("X4") + ", " + r.Rules + " rules)")) + ".");
            if (missingStatics > 0) summary.AppendLine("Missing static references: " + String.Join(", ", statics.Values.Where(r => !r.HasDecodedVisual).OrderBy(r => r.Id).Select(r => r.Id + " (0x" + r.Id.ToString("X4") + ", " + r.Rules + " rules)")) + ".");
            summary.AppendLine(String.Format(CultureInfo.InvariantCulture, "Referenced land diamonds with only black or transparent pixels: {0:N0}; referenced static images with only black or transparent pixels: {1:N0}. These measurements are reported for review, not treated as proof of meaningless art.", land.Values.Count(r => r.Art.Decoded && r.Art.NonBlack == 0), statics.Values.Count(r => r.Art.Decoded && r.Art.NonBlack == 0)));
            summary.AppendLine("No semantic 'meaningful art' count is asserted. Names, nontransparent pixels, multicolor images and nonblack pixels are measurable clues; placeholder, special-purpose and real game art can share those properties.");
            summary.AppendLine("No new transition definitions or material-pair compatibility are inferred from artwork. The archive's rules remain the only automatic transition catalog, with missing combinations reported by compilation.");
            summary.AppendLine("Transition static candidates are alternative choices; decorative Data/Statics groups are outside this catalog audit.");
            summary.AppendLine("art.def parsed records: " + defCount + ". The adapter fills missing geometry from same-kind replacement candidates; direct artwork is retained. Hues and tiledata metadata fallback are not applied. The CSV records original combined indices/groups; source-ID columns show effective geometry aliases. This report does not independently replace artwork or metadata.");
            summary.AppendLine("Reports contain metadata only; no client artwork was copied. Installed client files were opened read-only.");
            summary.AppendLine();
            summary.AppendLine("FILES: client-*-slots.csv enumerate numeric ranges and indexed availability. catalog-referenced-assets.csv contains decoded pixel checks for references; catalog-missing-assets.csv is its unavailable/nonrendering subset. catalog-rules.csv lists actual imported patterns and missing material/art references. catalog-materials.csv lists base materials and actual rule counts. client-files.csv records inspected inputs. warnings.txt records importer/decoder limitations.");
            File.WriteAllText(Path.Combine(destination, "summary.txt"), summary.ToString(), new UTF8Encoding(true));
            File.WriteAllLines(Path.Combine(destination, "warnings.txt"), catalog.Warnings.Select(w => "CATALOG: " + w).Concat(assets.Warnings.Select(w => "CLIENT: " + w)), new UTF8Encoding(true));
            return summary.ToString();
        }
        static int WriteArtDef(ClientAssets assets, string destination)
        {
            string path = Path.Combine(assets.Folder, "art.def"); int count = 0;
            using (var writer = Writer(destination, "client-art-def.csv"))
            {
                Row(writer, "line_number", "combined_art_index", "kind", "tile_id", "replacement_combined_indices", "third_column", "parse_status");
                if (!File.Exists(path)) return 0;
                int lineNumber = 0;
                foreach (string raw in File.ReadLines(path))
                {
                    lineNumber++; string line = raw.Split('#')[0].Trim(); if (line.Length == 0) continue;
                    Match m = Regex.Match(line, @"^\s*(\d+)\s*\{\s*([^}]*)\}\s*(.*?)\s*$");
                    int id;
                    if (!m.Success || !Int32.TryParse(m.Groups[1].Value, NumberStyles.None, CultureInfo.InvariantCulture, out id))
                    { Row(writer, lineNumber, "", "", "", "", "", "unparsed: " + line); continue; }
                    count++;
                    Row(writer, lineNumber, id, id < 0x4000 ? "land" : "static", id < 0x4000 ? id : id - 0x4000, m.Groups[2].Value, m.Groups[3].Value, "recorded only; consult adapter warnings for applied behavior");
                }
            }
            return count;
        }
    }
}
