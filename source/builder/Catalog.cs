using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;
using System.Xml;

namespace TerrainStudio
{
    public sealed class TerrainDefinition
    {
        public int Id;
        public string Name;
        public ushort TileId;
        public Color Color;
        public override string ToString() { return Name + "  [" + Id + "]"; }
    }

    public enum CellResolution : byte { Manual, Matched, MissingRule, Conflict, UnavailableCandidate, LegacyAutocorrect, AutocorrectSkipped }

    public sealed class CompileResult
    {
        public MapDocument Map;
        // Allocated only for diagnostic previews; ordinary large-map builds retain their memory footprint.
        public CellResolution[] States;
        public int Matched, Missing, Conflicts;
        public int AutocorrectSkipped;
        public List<string> Notes = new List<string>();
    }

    /// <summary>A detached, immutable snapshot of one imported valid rule; no artwork or inferred transitions.</summary>
    public sealed class CatalogRuleInfo
    {
        public string Key { get; private set; }
        public string Source { get; private set; }
        public int CenterMaterialId { get { return Materials[4]; } }
        public ReadOnlyCollection<int> Materials { get; private set; }
        public ReadOnlyCollection<ushort> LandTileIds { get; private set; }
        public ReadOnlyCollection<ushort> StaticTileIds { get; private set; }
        internal CatalogRuleInfo(string key, string source, IEnumerable<ushort> land, IEnumerable<ushort> statics)
        {
            Key = key; Source = source;
            var materials = new List<int>();
            for (int i = 0; i < 18; i += 2) materials.Add(Int32.Parse(key.Substring(i, 2), NumberStyles.HexNumber, CultureInfo.InvariantCulture));
            Materials = materials.AsReadOnly();
            LandTileIds = new List<ushort>(land).AsReadOnly();
            StaticTileIds = new List<ushort>(statics).AsReadOnly();
        }
    }

    public sealed class Catalog
    {
        public readonly List<TerrainDefinition> Terrains = new List<TerrainDefinition>();
        public readonly Dictionary<int, int> LegacyAltitudes = new Dictionary<int, int>();
        public readonly List<string> Warnings = new List<string>();
        public int RuleCount { get { return rules.Count; } }
        public int ConflictCount { get { return conflicts.Count; } }
        public int QuarantinedCount { get; private set; }
        public int TransitionFileCount { get; private set; }
        public string Summary
        {
            get
            {
                return String.Format(CultureInfo.InvariantCulture,
                    "{0} terrain materials; {1:N0} valid transition rules from {2} XML files; {3} legacy altitude colors. " +
                    "{4} malformed/empty rules quarantined; {5} conflicting keys quarantined. Identical duplicate rules are shared. " +
                    "This is the supplied legacy catalog, not a complete game-art or transition inventory.",
                    Terrains.Count, RuleCount, TransitionFileCount, LegacyAltitudes.Count, QuarantinedCount, ConflictCount);
            }
        }

        sealed class Candidate
        {
            public ushort Id;
            public int Offset;
            public string Signature { get { return Id.ToString(CultureInfo.InvariantCulture) + ":" + Offset.ToString(CultureInfo.InvariantCulture); } }
        }
        sealed class Rule
        {
            public string Key, Source;
            public bool Autocorrect;
            public List<Candidate> Land = new List<Candidate>();
            public List<Candidate> Statics = new List<Candidate>();
            public string Signature
            {
                get { return String.Join(",", Land.Select(c => c.Signature)) + "|" + String.Join(",", Statics.Select(c => c.Signature)); }
            }
        }
        sealed class FilteredRule
        {
            public List<Candidate> Land, Statics;
            public List<int> RejectedLand, RejectedStatics;
            public FilteredRule(Rule rule, ISet<int> availableLand, ISet<int> availableStatics)
            {
                Land = availableLand == null ? rule.Land : rule.Land.Where(c => availableLand.Contains(c.Id)).ToList();
                Statics = availableStatics == null ? rule.Statics : rule.Statics.Where(c => availableStatics.Contains(c.Id)).ToList();
                RejectedLand = availableLand == null ? new List<int>() : rule.Land.Where(c => !availableLand.Contains(c.Id)).Select(c => (int)c.Id).ToList();
                RejectedStatics = availableStatics == null ? new List<int>() : rule.Statics.Where(c => !availableStatics.Contains(c.Id)).Select(c => (int)c.Id).ToList();
            }
        }
        readonly Dictionary<int, TerrainDefinition> terrainById = new Dictionary<int, TerrainDefinition>();
        readonly Dictionary<string, Rule> rules = new Dictionary<string, Rule>(StringComparer.Ordinal);
        readonly HashSet<string> conflicts = new HashSet<string>(StringComparer.Ordinal);
        static readonly Regex ValidKey = new Regex("\\A[0-9a-fA-F]{18}\\z", RegexOptions.CultureInvariant);

        public IEnumerable<CatalogRuleInfo> RuleInventory()
        {
            foreach (var rule in rules.Values.OrderBy(r => r.Key, StringComparer.Ordinal))
                yield return new CatalogRuleInfo(rule.Key, rule.Source, rule.Land.Select(c => c.Id), rule.Statics.Select(c => c.Id));
        }

        static XmlDocument ReadXml(string path)
        {
            var settings = new XmlReaderSettings { DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null };
            var doc = new XmlDocument { XmlResolver = null };
            using (var reader = XmlReader.Create(path, settings)) doc.Load(reader);
            return doc;
        }
        static string Attribute(XmlElement e, string name)
        {
            if (!e.HasAttribute(name)) throw new FormatException("Missing " + name + " attribute.");
            return e.GetAttribute(name);
        }
        static int Number(string value, int min, int max, string name)
        {
            int result;
            if (!Int32.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out result) || result < min || result > max)
                throw new FormatException(name + " out of range or invalid: " + value + ".");
            return result;
        }
        ushort TileNumber(string value, int max, string source)
        {
            int n;
            if (Int32.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out n))
            {
                if (n < 0 || n > max) throw new FormatException("Tile ID out of range: " + value);
                return (ushort)n;
            }
            string hex = value.StartsWith("0x", StringComparison.OrdinalIgnoreCase) ? value.Substring(2) : value;
            if (Regex.IsMatch(hex, "\\A[0-9a-fA-F]+\\z") && Regex.IsMatch(hex, "[a-fA-F]") &&
                Int32.TryParse(hex, NumberStyles.HexNumber, CultureInfo.InvariantCulture, out n) && n >= 0 && n <= max)
            {
                string warning = source + ": interpreted legacy hexadecimal tile ID '" + value + "' as " + n + ".";
                if (!Warnings.Contains(warning)) Warnings.Add(warning);
                return (ushort)n;
            }
            throw new FormatException("Invalid tile ID: " + value);
        }

        public static Catalog Load(string dataDir)
        {
            if (!Directory.Exists(dataDir)) throw new DirectoryNotFoundException("Legacy Data folder not found: " + dataDir);
            var c = new Catalog();
            string terrainFile = Path.Combine(dataDir, "System", "Terrain.xml");
            var terrainXml = ReadXml(terrainFile);
            var duplicateIds = new HashSet<int>();
            var colors = new Dictionary<int, TerrainDefinition>();
            foreach (XmlElement e in terrainXml.SelectNodes("/Terrains/Terrain"))
            {
                try
                {
                    var t = new TerrainDefinition();
                    t.Id = Number(Attribute(e, "ID"), 0, 255, "Terrain ID");
                    t.Name = Attribute(e, "Name");
                    t.TileId = c.TileNumber(Attribute(e, "TileID"), 0x3FFF, "Terrain.xml");
                    t.Color = Color.FromArgb(Number(Attribute(e, "R"), 0, 255, "R"), Number(Attribute(e, "G"), 0, 255, "G"), Number(Attribute(e, "B"), 0, 255, "B"));
                    if (duplicateIds.Contains(t.Id)) throw new FormatException("Duplicate terrain ID " + t.Id + " remains quarantined.");
                    TerrainDefinition old;
                    if (c.terrainById.TryGetValue(t.Id, out old))
                    {
                        c.Terrains.Remove(old); c.terrainById.Remove(t.Id); colors.Remove(old.Color.ToArgb() & 0xFFFFFF); duplicateIds.Add(t.Id);
                        throw new FormatException("Duplicate terrain ID " + t.Id + "; both definitions quarantined.");
                    }
                    int rgb = t.Color.ToArgb() & 0xFFFFFF;
                    if (colors.ContainsKey(rgb)) c.Warnings.Add("Terrain.xml: RGB #" + rgb.ToString("X6") + " is ambiguous; exact palette-image import will reject it.");
                    else colors.Add(rgb, t);
                    c.Terrains.Add(t); c.terrainById.Add(t.Id, t);
                }
                catch (Exception ex) { c.Warnings.Add("Terrain.xml: " + ex.Message); }
            }
            c.Terrains.Sort((a, b) => StringComparer.OrdinalIgnoreCase.Compare(a.Name, b.Name));
            string altitudeFile = Path.Combine(dataDir, "System", "Altitude.xml");
            if (File.Exists(altitudeFile))
            {
                var duplicateColors = new HashSet<int>();
                foreach (XmlElement e in ReadXml(altitudeFile).SelectNodes("/Altitudes/Altitude"))
                {
                    try
                    {
                        int z = Number(Attribute(e, "Altitude"), -128, 127, "Altitude");
                        int rgb = (Number(Attribute(e, "R"), 0, 255, "R") << 16) | (Number(Attribute(e, "G"), 0, 255, "G") << 8) | Number(Attribute(e, "B"), 0, 255, "B");
                        int old;
                        if (duplicateColors.Contains(rgb)) continue;
                        if (c.LegacyAltitudes.TryGetValue(rgb, out old) && old != z)
                        {
                            c.LegacyAltitudes.Remove(rgb); duplicateColors.Add(rgb);
                            c.Warnings.Add("Altitude.xml: conflicting RGB #" + rgb.ToString("X6") + " quarantined.");
                        }
                        else c.LegacyAltitudes[rgb] = z;
                    }
                    catch (Exception ex) { c.Warnings.Add("Altitude.xml: " + ex.Message); }
                }
            }
            string transitions = Path.Combine(dataDir, "Transitions");
            if (Directory.Exists(transitions))
            {
                string[] paths = Directory.GetFiles(transitions, "*.xml", SearchOption.AllDirectories);
                Array.Sort(paths, StringComparer.OrdinalIgnoreCase);
                foreach (string path in paths)
                {
                    c.TransitionFileCount++;
                    string source = path.Substring(dataDir.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar).Length + 1);
                    XmlDocument doc;
                    try { doc = ReadXml(path); }
                    catch (Exception ex) { c.Warnings.Add(source + ": XML quarantined: " + ex.Message); c.QuarantinedCount++; continue; }
                    foreach (XmlElement e in doc.SelectNodes("//TransInfo"))
                    {
                        try
                        {
                            if (e.ParentNode.Name != "Trans") throw new FormatException("Nested TransInfo is structurally invalid.");
                            if (e.SelectNodes("TransInfo").Count > 0) throw new FormatException("TransInfo contains a nested rule.");
                            string key = Attribute(e, "HashKey");
                            if (!ValidKey.IsMatch(key)) throw new FormatException("HashKey must contain nine two-digit hexadecimal terrain IDs: '" + key + "'.");
                            var rule = new Rule { Key = key.ToUpperInvariant(), Source = source,
                                Autocorrect = Regex.IsMatch(e.GetAttribute("Description"), @"\b(?:AC|Auto\s*correct(?:ion)?)\b", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant) };
                            foreach (XmlElement item in e.SelectNodes("MapTiles/MapTile")) rule.Land.Add(c.ReadCandidate(item, 0x3FFF, source));
                            foreach (XmlElement item in e.SelectNodes("StaticTiles/StaticTile")) rule.Statics.Add(c.ReadCandidate(item, 0xFFFF, source));
                            if (rule.Land.Count == 0 && rule.Statics.Count == 0) throw new FormatException("Empty transition rule " + key + ".");
                            if (c.conflicts.Contains(rule.Key)) continue;
                            Rule old;
                            if (c.rules.TryGetValue(rule.Key, out old))
                            {
                                if (old.Signature != rule.Signature)
                                {
                                    c.rules.Remove(rule.Key); c.conflicts.Add(rule.Key);
                                    c.Warnings.Add("Conflicting key " + rule.Key + " quarantined: " + old.Source + " and " + source + ".");
                                }
                                else old.Autocorrect |= rule.Autocorrect;
                            }
                            else c.rules.Add(rule.Key, rule);
                        }
                        catch (Exception ex) { c.QuarantinedCount++; c.Warnings.Add(source + ": " + ex.Message); }
                    }
                }
            }
            else c.Warnings.Add("No Transitions folder found; material cells will retain base tiles.");
            var unknown = new SortedSet<int>();
            foreach (string key in c.rules.Keys) for (int i = 0; i < 18; i += 2)
            {
                int id = Int32.Parse(key.Substring(i, 2), NumberStyles.HexNumber, CultureInfo.InvariantCulture);
                if (!c.terrainById.ContainsKey(id)) unknown.Add(id);
            }
            if (unknown.Count > 0) c.Warnings.Add("Rules reference terrain IDs absent from Terrain.xml: " + String.Join(", ", unknown) + ". They remain imported, but no material is invented for them.");
            c.Warnings.Add("Transition static lists are alternative candidates: one deterministic candidate is placed per matching cell. Random decorative groups in Data/Statics are not generated.");
            return c;
        }
        Candidate ReadCandidate(XmlElement e, int max, string source)
        {
            return new Candidate { Id = TileNumber(Attribute(e, "TileID"), max, source), Offset = Number(Attribute(e, "AltIDMod"), -65535, 65535, "AltIDMod") };
        }
        static uint Mix(uint value)
        {
            unchecked { value ^= value >> 16; value *= 0x7feb352dU; value ^= value >> 15; value *= 0x846ca68bU; return value ^ (value >> 16); }
        }
        static int Variant(int seed, int x, int y, int count, uint salt)
        {
            unchecked { return (int)(Mix((uint)seed ^ Mix((uint)x) ^ (Mix((uint)y) * 0x9e3779b9U) ^ salt) % (uint)count); }
        }
        static sbyte ExactZ(int z, int x, int y, string kind)
        {
            if (z < -128 || z > 127) throw new InvalidOperationException(String.Format("Legacy {0} altitude offset at ({1}, {2}) produces Z={3}, outside -128..127. Compilation rejected; the source map is unchanged.", kind, x, y, z));
            return (sbyte)z;
        }
        static string StaticKey(StaticPlacement s)
        {
            return s.X + "," + s.Y + "," + s.Id + "," + s.Z + "," + s.Hue;
        }

        // Explicit visual families, never numeric palette proximity. Two levels keep
        // forest/dirt variants close before borrowing general grass boundaries.
        static int Family(int id, bool broad)
        {
            switch(id) {
                case 61: case 62: case 72: case 128: return 1;
                case 63: case 65: case 66: case 131: return broad ? 1 : 11;
                case 10: case 11: return broad ? 1 : id;
                case 67: case 129: return 4;
                default: return id;
            }
        }
        string CompatibleKey(string key, ISet<int> available)
        {
            Rule original;
            // Never replace an exact available land choice, autocorrect, or conflict.
            if (conflicts.Contains(key)) return null;
            if (rules.TryGetValue(key, out original) &&
                (original.Autocorrect || original.Land.Any(c => available.Contains(c.Id)))) return null;
            int[] ids=new int[9];
            for(int i=0;i<9;i++) {
                ids[i]=Int32.Parse(key.Substring(i*2,2), NumberStyles.HexNumber, CultureInfo.InvariantCulture);
                if(ids[i]==5 || ids[i]==6 || ids[i]==9 || !terrainById.ContainsKey(ids[i])) return null;
            }
            if(ids.All(v=>v==ids[4])) return null;
            for(int pass=0;pass<2;pass++) {
                int[] mapped=ids.Select(v=>Family(v,pass==1)).ToArray();
                if(mapped.All(v=>v==mapped[4])) continue;
                string candidate=String.Concat(mapped.Select(v=>v.ToString("X2")));
                Rule fallback;
                if(candidate!=key && rules.TryGetValue(candidate,out fallback) && !fallback.Autocorrect &&
                    fallback.Statics.Count==0 && fallback.Land.Any(c=>available.Contains(c.Id))) return candidate;
            }
            return null;
        }

        public CompileResult Compile(MapDocument source, bool applyLegacyZOffsets = false, int seed = 0)
        {
            return Compile(source, applyLegacyZOffsets, seed, null, null);
        }

        /// <summary>
        /// Optional client availability sets filter automatic alternatives only. Callers should provide stable snapshots.
        /// Null means no filtering for that kind; an empty set means no automatic candidates of that kind are available.
        /// Matched/Missing partition material cells. A cell missing any required candidate kind is counted Missing once,
        /// even when the other kind can be produced. Source/manual placements and fallback base tiles are not filtered.
        /// </summary>
        public CompileResult Compile(MapDocument source, bool applyLegacyZOffsets, int seed, ISet<int> availableLand, ISet<int> availableStatics, bool captureDiagnostics = false, bool allowLegacyAutocorrect = true, bool compatibleFallbacks = false)
        {
            if (source == null) throw new ArgumentNullException("source");
            source.Validate();
            var result = new CompileResult { Map = source.Clone() };
            if (captureDiagnostics) result.States = new CellResolution[source.Materials.Length];
            result.Notes.Add(applyLegacyZOffsets ? "Legacy altitude offsets applied to land and transition statics; any out-of-range Z rejects compilation." : "Exact height mode: every source Z is preserved. Legacy land and transition-static altitude offsets are ignored.");
            result.Notes.Add("Neighborhood order: NW,N,NE,W,C,E,SW,S,SE (verified against UOMapMake IL). Map edges clamp to the nearest cell.");
            result.Notes.Add("Manual tile cells (material -1) and manual statics are preserved. Missing or conflicting rules retain the material's base tile and exact source Z. Transition statics use one deterministic alternative; decorative vegetation groups are not generated.");
            var existingStatics = new HashSet<string>();
            foreach (var s in source.Statics) existingStatics.Add(StaticKey(s));
            var examples = new HashSet<string>();
            var keyChars = new char[18];
            const string hex = "0123456789ABCDEF";
            int generated = 0, familyFallbackCells = 0;
            var familyCache = new Dictionary<string, string>();
            bool filterEnabled = availableLand != null || availableStatics != null;
            var filteredRules = new Dictionary<string, FilteredRule>(StringComparer.Ordinal);
            var rejectedLandIds = new SortedSet<int>(); var rejectedStaticIds = new SortedSet<int>();
            int exhaustedLandCells = 0, exhaustedStaticCells = 0, exhaustedAnyCells = 0;
            long rejectedLandChoices = 0, rejectedStaticChoices = 0;
            for (int y = 0; y < source.Height; y++) for (int x = 0; x < source.Width; x++)
            {
                int index = y * source.Width + x;
                int material = source.Materials[index];
                if (material == -1) continue;
                TerrainDefinition definition;
                if (terrainById.TryGetValue(material, out definition)) result.Map.Land[index] = definition.TileId;
                bool valid = true;
                int position = 0;
                for (int dy = -1; dy <= 1; dy++) for (int dx = -1; dx <= 1; dx++)
                {
                    int nx = Math.Max(0, Math.Min(source.Width - 1, x + dx));
                    int ny = Math.Max(0, Math.Min(source.Height - 1, y + dy));
                    int id = source.Materials[ny * source.Width + nx];
                    if (id < 0 || id > 255) { valid = false; id = 0; }
                    keyChars[position++] = hex[id >> 4]; keyChars[position++] = hex[id & 15];
                }
                string key = valid ? new string(keyChars) : null;
                Rule rule;
                if (compatibleFallbacks && key != null && availableLand != null)
                {
                    string replacement;
                    if (!familyCache.TryGetValue(key, out replacement))
                    {
                        replacement = CompatibleKey(key, availableLand);
                        familyCache[key] = replacement;
                    }
                    if (replacement != null) { key = replacement; familyFallbackCells++; }
                }
                if (key != null && rules.TryGetValue(key, out rule))
                {
                    if (rule.Autocorrect && !allowLegacyAutocorrect)
                    {
                        result.AutocorrectSkipped++; result.Missing++;
                        if (result.States != null) result.States[index] = CellResolution.AutocorrectSkipped;
                        continue;
                    }
                    List<Candidate> landChoices = rule.Land, staticChoices = rule.Statics;
                    if (filterEnabled)
                    {
                        FilteredRule filtered;
                        if (!filteredRules.TryGetValue(key, out filtered))
                        {
                            filtered = new FilteredRule(rule, availableLand, availableStatics);
                            filteredRules.Add(key, filtered);
                        }
                        landChoices = filtered.Land; staticChoices = filtered.Statics;
                        rejectedLandChoices += filtered.RejectedLand.Count; rejectedStaticChoices += filtered.RejectedStatics.Count;
                        rejectedLandIds.UnionWith(filtered.RejectedLand); rejectedStaticIds.UnionWith(filtered.RejectedStatics);
                    }
                    bool noLandCandidate = rule.Land.Count > 0 && landChoices.Count == 0;
                    bool noStaticCandidate = rule.Statics.Count > 0 && staticChoices.Count == 0;
                    if (noLandCandidate) exhaustedLandCells++;
                    if (noStaticCandidate) exhaustedStaticCells++;
                    if (noLandCandidate || noStaticCandidate)
                    {
                        exhaustedAnyCells++; result.Missing++;
                        if (result.States != null) result.States[index] = CellResolution.UnavailableCandidate;
                        if (examples.Count < 8) examples.Add("(" + x + ", " + y + "): " + key + " has no available " + (noLandCandidate && noStaticCandidate ? "land or static" : noLandCandidate ? "land" : "static") + " candidate");
                    }
                    else { result.Matched++; if (result.States != null) result.States[index] = rule.Autocorrect ? CellResolution.LegacyAutocorrect : CellResolution.Matched; }
                    if (landChoices.Count > 0)
                    {
                        Candidate tile = landChoices[Variant(seed, x, y, landChoices.Count, 0xa43b8e21U)];
                        result.Map.Land[index] = tile.Id;
                        if (applyLegacyZOffsets) result.Map.Elevation[index] = ExactZ(source.Elevation[index] + tile.Offset, x, y, "land");
                    }
                    if (staticChoices.Count > 0)
                    {
                        Candidate tile = staticChoices[Variant(seed, x, y, staticChoices.Count, 0x61c88647U)];
                        var placement = new StaticPlacement { X = x, Y = y, Id = tile.Id, Hue = 0, Z = ExactZ(source.Elevation[index] + (applyLegacyZOffsets ? tile.Offset : 0), x, y, "static") };
                        if (existingStatics.Add(StaticKey(placement))) { result.Map.Statics.Add(placement); generated++; }
                    }
                }
                else
                {
                    result.Missing++;
                    if (key != null && conflicts.Contains(key)) result.Conflicts++;
                    if (result.States != null) result.States[index] = key != null && conflicts.Contains(key) ? CellResolution.Conflict : CellResolution.MissingRule;
                    if (examples.Count < 8) examples.Add("(" + x + ", " + y + "): " + (key ?? "manual/unrepresentable material in neighborhood"));
                }
            }
            result.Notes.Add(String.Format("Matched {0:N0} cells; missing {1:N0} (including {2:N0} conflicting keys); added {3:N0} transition statics. Seed {4}.", result.Matched, result.Missing, result.Conflicts, generated, seed));
            result.Notes.Add(allowLegacyAutocorrect ? "Legacy autocorrect is enabled: explicitly labeled AC / Autocorrect rules may replace narrow features with surrounding terrain." : String.Format("Legacy autocorrect is disabled: {0:N0} explicitly labeled AC / Autocorrect cells retained their base terrain and source Z, with no generated statics at those cells. These cells count as unresolved/missing; no replacement transition was invented.", result.AutocorrectSkipped));
            if (filterEnabled)
            {
                result.Notes.Add("Automatic client availability filter: land " + (availableLand == null ? "not checked" : "checked") + "; statics " + (availableStatics == null ? "not checked" : "checked") + ". Manual placements and fallback base tiles are retained even when artwork is unavailable.");
                result.Notes.Add(String.Format("Unavailable alternatives excluded across visited cells: {0:N0} land choices and {1:N0} static choices. Exhausted candidate lists: {2:N0} land cells, {3:N0} static cells; {4:N0} distinct cells counted missing once. Other available candidate kinds may still compile on those cells.", rejectedLandChoices, rejectedStaticChoices, exhaustedLandCells, exhaustedStaticCells, exhaustedAnyCells));
                if (rejectedLandIds.Count > 0) result.Notes.Add("Excluded automatic land IDs: " + String.Join(", ", rejectedLandIds) + ".");
                if (rejectedStaticIds.Count > 0) result.Notes.Add("Excluded automatic static IDs: " + String.Join(", ", rejectedStaticIds) + ".");
            }
            if (examples.Count > 0) result.Notes.Add("Missing examples: " + String.Join("; ", examples));
            if (compatibleFallbacks) result.Notes.Add(String.Format("Compatible-family fallback: {0:N0} boundary cells borrowed texture-backed dry-land rules. Original interiors, material image and heights preserved. Exact available land rules take priority; no static-art or water substitutes. Missing shoreline textures remain unresolved.", familyFallbackCells));
            result.Map.Validate();
            return result;
        }
    }
}
