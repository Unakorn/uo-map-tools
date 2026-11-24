using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace TerrainStudio
{
    public sealed class MapBuildOptions
    {
        public string TerrainPath, AltitudePath, OutputDirectory, ClientPath;
        public bool ApplyLegacyZOffsets, AllowLegacyAutocorrect;
        public bool RequireTerrainTextures = true;
        public bool AnimatedShorelines = true;
        public int Facet;
    }

    public sealed class MapBuildResult
    {
        public int Width, Height, Matched, Missing, AutocorrectSkipped, GeneratedStatics, Facet;
        public int TextureWaterCells, TextureWaterCorrections;
        public string OutputDirectory, ReportPath, Report;
    }

    // One job: two exact images in, completed map files and a report out.
    public static class MapBuildJob
    {
        public static MapBuildResult Run(Catalog catalog, MapBuildOptions options, Action<string> progress = null)
        {
            if (catalog == null) throw new ArgumentNullException("catalog");
            if (options == null) throw new ArgumentNullException("options");
            int facet = options.Facet;
            if (facet < 0 || facet > 5) throw new ArgumentOutOfRangeException("Facet", "Map file number must be from 0 through 5.");
            string[] outputNames = { "map" + facet + ".mul", "statics" + facet + ".mul", "staidx" + facet + ".mul", "build-report.txt" };
            string terrainPath = InputPath(options.TerrainPath, "terrain image");
            string altitudePath = InputPath(options.AltitudePath, "altitude image");
            if (String.IsNullOrWhiteSpace(options.OutputDirectory)) throw new ArgumentException("Choose an output folder.");
            string outputParent = Path.GetFullPath(options.OutputDirectory);
            if (File.Exists(outputParent)) throw new IOException("The output folder path is an existing file.");
            string clientPath = String.IsNullOrWhiteSpace(options.ClientPath) ? null : Path.GetFullPath(options.ClientPath);
            bool offsets = options.ApplyLegacyZOffsets, autocorrect = options.AllowLegacyAutocorrect;
            bool texturesOnly = options.RequireTerrainTextures;
            if (texturesOnly && clientPath == null)
                throw new ArgumentException("Select the UO client folder to verify texture-backed terrain output.");
            if (clientPath != null && !Directory.Exists(clientPath)) throw new DirectoryNotFoundException("The selected UO client folder does not exist.");
            // Resolve junctions/symbolic links without changing either directory.
            string physicalParent = ResolveFolderLocation(outputParent);
            string physicalClient = clientPath == null ? null : ResolveFolderLocation(clientPath);
            if (physicalClient != null && IsWithin(physicalParent, physicalClient))
                throw new IOException("Choose an output folder outside the UO client folder. This builder does not write into the client installation.");

            Notify(progress, "Reading terrain and altitude images...");
            MapDocument source;
            using (Bitmap terrain = ReadImage(terrainPath, "terrain"))
            using (Bitmap altitude = ReadImage(altitudePath, "altitude"))
            {
                if (terrain.Width != altitude.Width || terrain.Height != altitude.Height)
                    throw new InvalidDataException(String.Format("The two images must have the same dimensions. Terrain is {0} x {1}; altitude is {2} x {3}. No image was resized.", terrain.Width, terrain.Height, altitude.Width, altitude.Height));
                MapDocument.CheckedTileCount(terrain.Width, terrain.Height);
                if ((terrain.Width & 7) != 0 || (terrain.Height & 7) != 0)
                    throw new InvalidDataException("Image width and height must both be divisible by 8 for a UO map. No cropping or padding was performed.");
                source = TerrainImages.Import(terrain, catalog);
                source.Elevation = HeightImages.Import(altitude, false, null);
            }

            HashSet<int> availableLand = null, availableStatics = null;
            WaterTexturePolicy waterPolicy = null;
            AnimatedShorelinePolicy shorePolicy = null;
            SandCornerPolicy cornerPolicy = null;
            var clientNotes = new List<string>();
            if (clientPath != null)
            {
                using (ClientAssets assets = ClientAssets.Open(clientPath))
                {
                    availableLand = new HashSet<int>(); availableStatics = new HashSet<int>();
                    for (int id = 0; id < 16384; id++)
                    {
                        int texture = assets.LandTextureId(id);
                        bool hasTexture = texture != 0 && assets.HasTexture(texture);
                        if (hasTexture || (!texturesOnly && assets.HasLandArt(id))) availableLand.Add(id);
                    }
                    // Static-art bank pieces do not satisfy texture-backed terrain output.
                    if (!texturesOnly) for (int id = 0; id < 65536; id++) if (assets.HasStaticArt(id)) availableStatics.Add(id);
                    // An absent archive cannot establish that its entire namespace is unavailable.
                    if (!texturesOnly && availableLand.Count == 0) availableLand = null;
                    if (!texturesOnly && availableStatics.Count == 0) availableStatics = null;
                    if (texturesOnly) waterPolicy = WaterTexturePolicy.Inspect(assets);
                    if (texturesOnly && options.AnimatedShorelines) {shorePolicy=AnimatedShorelinePolicy.Inspect(assets,clientPath);cornerPolicy=SandCornerPolicy.Inspect(catalog,assets);}
                    clientNotes.Add(assets.Summary); clientNotes.AddRange(assets.Warnings);
                }
            }
            Notify(progress, "Building map and transitions...");
            CompileResult compiled = catalog.Compile(source, offsets, 0, availableLand, availableStatics, false, autocorrect, texturesOnly);
            WaterTextureCorrection waterCorrection = null;

            if (texturesOnly)
            {
                waterCorrection = waterPolicy.Apply(catalog, source, compiled.Map);
                for (int i = 0; i < compiled.Map.Land.Length; i++) if (!availableLand.Contains(compiled.Map.Land[i]))
                {
                    string material = source.Materials[i].ToString();
                    foreach (TerrainDefinition terrain in catalog.Terrains) if (terrain.Id == source.Materials[i]) { material = terrain.Name + " [" + terrain.Id + "]"; break; }
                    throw new InvalidDataException(String.Format("Texture-backed output rejected at ({0}, {1}): land ID {2} (0x{2:X4}), material {3}, has no indexed associated terrain texture. No output files were written.", i % source.Width, i / source.Width, compiled.Map.Land[i], material));
                }
                if (compiled.Map.Statics.Count != 0) throw new InvalidDataException("Texture-backed output cannot contain generated static artwork. No output files were written.");
            }

            int shorelineCount=0,shorelineSkipped=0,cornerCount=0,sideBankCount=0;
            if (texturesOnly && options.AnimatedShorelines) {shorelineCount=shorePolicy.Apply(source,compiled.Map,out shorelineSkipped);cornerCount=cornerPolicy.Apply(source,compiled.Map);sideBankCount=cornerPolicy.ApplySides(source,compiled.Map);}
            string decoPath=Path.Combine(Path.GetDirectoryName(terrainPath),"Decorations.png");
            int decoCount=0,decoAnchors=0,roofPieces=0,skippedRoofs=0;
            if(File.Exists(decoPath)) {
                if(clientPath==null)throw new InvalidDataException("Client data is required to validate decorations.");
                Notify(progress,"Reading Decorations.png and placing exact static artwork...");
                using(var assets=ClientAssets.Open(clientPath))decoCount=DecorationImages.Apply(decoPath,source,compiled.Map,assets,out decoAnchors,out roofPieces,out skippedRoofs);
            }
            string token = Guid.NewGuid().ToString("N");
            string completed = Path.Combine(outputParent, "map-" + DateTime.Now.ToString("yyyyMMdd-HHmmss") + "-" + token.Substring(0, 8));
            string staging = Path.Combine(outputParent, ".uo-map-build-" + token);
            var result = new MapBuildResult {
                Width = source.Width, Height = source.Height, Matched = compiled.Matched, Missing = compiled.Missing,
                AutocorrectSkipped = compiled.AutocorrectSkipped, GeneratedStatics = compiled.Map.Statics.Count,
                Facet = facet,
                TextureWaterCells = waterCorrection == null ? 0 : waterCorrection.WaterCells,
                TextureWaterCorrections = waterCorrection == null ? 0 : waterCorrection.CorrectedCells,
                OutputDirectory = completed, ReportPath = Path.Combine(completed, "build-report.txt")
            };
            var report = new StringBuilder();
            report.AppendLine("UO MAP BUILDER - completed image build");
            report.AppendLine("Terrain image: " + terrainPath); report.AppendLine("Altitude image: " + altitudePath);
            report.AppendLine("Output: " + completed); report.AppendLine("Dimensions: " + source.Width + " x " + source.Height);
            report.AppendLine("Map file number: " + facet + "; files: " + String.Join(", ", outputNames));
            report.AppendLine("Input altitude: exact grayscale; Z = shade - 128.");
            report.AppendLine("Apply legacy Z offsets: " + offsets + "; allow legacy autocorrect: " + autocorrect + "; seed: 0.");
            report.AppendLine("Client availability: " + (clientPath ?? "not connected; catalog candidates were not filtered against client art"));
            report.AppendLine("Generated statics: " + result.GeneratedStatics);
            report.AppendLine("Flat stone roofs: "+roofPieces+" pieces; "+skippedRoofs+" incomplete, non-paver, uneven or over-height wall groups skipped. Wall130 metadata height; roof art1306. Ground unchanged.");
            report.AppendLine("Decoration image: "+(File.Exists(decoPath)?decoPath:"none")+"; anchors: "+decoAnchors+"; static pieces: "+decoCount+". Exact source tile Z; no random placements or height changes.");
            if (texturesOnly)
            {
                report.AppendLine("Texture-backed terrain IDs verified; this does not force the client renderer to use textures on flat ground.");
                report.AppendLine("Automatic land candidates require a nonzero terrain texture association with an available indexed texture. Static-art transition candidates are deliberately excluded; unresolved static-art portions count as missing.");
                report.AppendLine(waterCorrection.ToString());
                if(cornerPolicy!=null)report.AppendLine("Missing side patterns completed: "+cornerPolicy.CompletedSides+"; existing bank placements retained.");
                if(cornerPolicy!=null)report.AppendLine("Missing corner orientations completed: "+cornerPolicy.CompletedCorners+"; prior catalog corner placements retained.");
                report.AppendLine("Sand side-bank pass: "+sideBankCount+" partial shoreline pieces from Sand/Shallow Water and compatible Sand/High Coast rules. Only single-side water boundaries at equal bank/water Z; existing waves/corners and all map heights retained.");
                report.AppendLine("Sand corner artwork: "+cornerCount+" catalog-matched bank-side pieces at equal bank/water Z; straight animated waves retained. Corner artwork is not animated. Unsupported or uneven corners left unchanged.");
                report.AppendLine(String.Format("Animated shoreline exception: {0:N0} N/E/S/W wave pieces placed on flat water-side edges at exact water Z; {1:N0} sloped-water edges skipped. Corners combine their adjoining directional pieces. No inland decoration or legacy statics copied.",shorelineCount,shorelineSkipped));
            }
            report.AppendLine(String.Join(Environment.NewLine, compiled.Notes));
            report.AppendLine(catalog.Summary);
            if (clientNotes.Count > 0) report.AppendLine(String.Join(Environment.NewLine, clientNotes));
            report.AppendLine("Unresolved transitions keep base terrain. A completed build is not proof of correct in-game seam, bank or slope appearance.");
            report.AppendLine("Client/server facet dimensions must match these output dimensions. No input image or client installation file was changed.");
            result.Report = report.ToString();

            Notify(progress, "Writing completed map files...");
            // No output is created until image validation, client inspection and compilation succeed.
            // Resolve once more immediately before writing, in case the chosen directory changed.
            if (!String.Equals(physicalParent, ResolveFolderLocation(outputParent), StringComparison.OrdinalIgnoreCase))
                throw new IOException("The output folder location changed during the build. Choose the folder again.");
            Directory.CreateDirectory(outputParent);
            if (Directory.Exists(staging) || File.Exists(staging) || Directory.Exists(completed) || File.Exists(completed))
                throw new IOException("The generated build folder already exists. Please build again.");
            bool ownsStaging = false;
            try
            {
                Directory.CreateDirectory(staging); ownsStaging = true;
                MapIO.SaveMul(compiled.Map, staging, facet);
                using (var stream = new FileStream(Path.Combine(staging, "build-report.txt"), FileMode.CreateNew, FileAccess.Write))
                using (var writer = new StreamWriter(stream, new UTF8Encoding(false))) writer.Write(result.Report);
                Directory.Move(staging, completed);
                ownsStaging = false;
                return result;
            }
            finally
            {
                // Delete only our four known files in this exact, newly created staging directory.
                // Never recursively delete an output directory or follow a substituted junction.
                if (ownsStaging)
                {
                    try
                    {
                        if (Directory.Exists(staging) && String.Equals(ResolveFolderLocation(staging), Path.Combine(physicalParent, Path.GetFileName(staging)), StringComparison.OrdinalIgnoreCase))
                        {
                            foreach (string name in outputNames) { try { File.Delete(Path.Combine(staging, name)); } catch { } }
                            try { Directory.Delete(staging, false); } catch { }
                        }
                    }
                    catch { /* Cleanup must not hide the build error or follow an unverified path. */ }
                }
            }
        }

        static void Notify(Action<string> progress, string message) { if (progress != null) progress(message); }
        static string InputPath(string path, string label)
        {
            if (String.IsNullOrWhiteSpace(path)) throw new ArgumentException("Choose a " + label + ".");
            string full = Path.GetFullPath(path);
            if (!File.Exists(full)) throw new FileNotFoundException("The " + label + " does not exist.", full);
            return full;
        }
        static Bitmap ReadImage(string path, string label)
        {
            using (var source = new Bitmap(path))
            {
                if (source.RawFormat.Guid != ImageFormat.Png.Guid && source.RawFormat.Guid != ImageFormat.Bmp.Guid)
                    throw new InvalidDataException("The " + label + " image must be a PNG or BMP with exact colors.");
                MapDocument.CheckedTileCount(source.Width, source.Height);
                var result = new Bitmap(source.Width, source.Height, PixelFormat.Format32bppArgb);
                try
                {
                    using (Graphics graphics = Graphics.FromImage(result)) { graphics.CompositingMode = CompositingMode.SourceCopy; graphics.DrawImageUnscaled(source, 0, 0); }
                    return result;
                }
                catch { result.Dispose(); throw; }
            }
        }
        static bool IsWithin(string path, string parent)
        {
            string root = parent.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            return String.Equals(path.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar), root, StringComparison.OrdinalIgnoreCase) || path.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase);
        }
        static string ResolveFolderLocation(string path)
        {
            var suffix = new Stack<string>();
            string existing = Path.GetFullPath(path);
            while (!Directory.Exists(existing))
            {
                if (File.Exists(existing)) throw new IOException("A folder path component is an existing file: " + existing);
                string parent = Path.GetDirectoryName(existing);
                if (String.IsNullOrEmpty(parent)) throw new DirectoryNotFoundException("Cannot find the output drive or folder: " + path);
                suffix.Push(Path.GetFileName(existing)); existing = parent;
            }
            using (SafeFileHandle handle = CreateFile(existing, 0, 7, IntPtr.Zero, 3, 0x02000000, IntPtr.Zero))
            {
                if (handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not inspect folder: " + existing);
                var buffer = new StringBuilder(32768);
                uint size = GetFinalPathNameByHandle(handle, buffer, (uint)buffer.Capacity, 0);
                if (size == 0 || size >= buffer.Capacity) throw new IOException("Could not resolve folder location: " + existing);
                existing = buffer.ToString();
                if (existing.StartsWith(@"\\?\UNC\", StringComparison.OrdinalIgnoreCase)) existing = @"\\" + existing.Substring(8);
                else if (existing.StartsWith(@"\\?\", StringComparison.Ordinal)) existing = existing.Substring(4);
            }
            while (suffix.Count > 0) existing = Path.Combine(existing, suffix.Pop());
            existing = Path.GetFullPath(existing);
            return existing.Length > Path.GetPathRoot(existing).Length ? existing.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar) : existing;
        }
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern SafeFileHandle CreateFile(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern uint GetFinalPathNameByHandle(SafeFileHandle handle, StringBuilder path, uint length, uint flags);
    }
}
