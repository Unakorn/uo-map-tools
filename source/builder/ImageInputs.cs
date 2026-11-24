using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

namespace TerrainStudio
{
    public static class TerrainImages
    {
        public static MapDocument Import(Bitmap source, Catalog catalog)
        {
            var byColor = new Dictionary<int, TerrainDefinition>();
            var ambiguous = new HashSet<int>();
            foreach (var terrain in catalog.Terrains)
            {
                int rgb = terrain.Color.ToArgb() & 0xFFFFFF;
                if (byColor.ContainsKey(rgb)) ambiguous.Add(rgb);
                else byColor.Add(rgb, terrain);
            }
            var map = new MapDocument(source.Width, source.Height);
            using (var bitmap = new Bitmap(source.Width, source.Height, PixelFormat.Format32bppArgb))
            {
                using (var g = Graphics.FromImage(bitmap)) { g.CompositingMode = System.Drawing.Drawing2D.CompositingMode.SourceCopy; g.DrawImageUnscaled(source, 0, 0); }
                var data = bitmap.LockBits(new Rectangle(0, 0, bitmap.Width, bitmap.Height), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
                try
                {
                    var row = new int[bitmap.Width];
                    for (int y = 0; y < bitmap.Height; y++)
                    {
                        Marshal.Copy(IntPtr.Add(data.Scan0, y * data.Stride), row, 0, row.Length);
                        for (int x = 0; x < row.Length; x++)
                        {
                            TerrainDefinition terrain;
                            if (ambiguous.Contains(row[x] & 0xFFFFFF))
                                throw new ArgumentException(String.Format("Ambiguous terrain color at ({0}, {1}): #{2:X6}. This legacy color belongs to more than one material. Paint the material in the editor instead, or correct the catalog palette.", x, y, row[x] & 0xFFFFFF));
                            if ((uint)row[x] >> 24 != 255 || !byColor.TryGetValue(row[x] & 0xFFFFFF, out terrain))
                                throw new ArgumentException(String.Format("Unknown terrain color at ({0}, {1}): #{2:X8}. Use an opaque, exact palette color; no antialiasing or color blending.", x, y, row[x]));
                            int i = y * map.Width + x;
                            map.Land[i] = terrain.TileId;
                            map.Materials[i] = terrain.Id;
                        }
                    }
                }
                finally { bitmap.UnlockBits(data); }
            }
            return map;
        }

        public static Bitmap Export(MapDocument map, Catalog catalog)
        {
            var colors = new Dictionary<int, Color>();
            var counts = new Dictionary<int, int>();
            foreach (var terrain in catalog.Terrains) colors[terrain.Id] = terrain.Color;
            foreach (var color in colors.Values) { int rgb = color.ToArgb() & 0xFFFFFF; counts[rgb] = counts.ContainsKey(rgb) ? counts[rgb] + 1 : 1; }
            var bitmap = new Bitmap(map.Width, map.Height, PixelFormat.Format32bppArgb);
            try
            {
                // Validate before locking or writing any image data.
                var row = new int[map.Width];
                foreach (int material in map.Materials)
                {
                    Color color;
                    if (!colors.TryGetValue(material, out color))
                        throw new InvalidOperationException("A terrain palette image cannot preserve manually selected tile IDs. Save a .uostudio project or export MUL to keep exact tiles.");
                    if (counts[color.ToArgb() & 0xFFFFFF] > 1)
                        throw new InvalidOperationException("A material uses an ambiguous legacy palette color. Save a .uostudio project to preserve material identity, or correct the catalog palette.");
                }
                var data = bitmap.LockBits(new Rectangle(0, 0, bitmap.Width, bitmap.Height), ImageLockMode.WriteOnly, PixelFormat.Format32bppArgb);
                try
                {
                    for (int y = 0; y < map.Height; y++)
                    {
                        for (int x = 0; x < map.Width; x++) row[x] = colors[map.Materials[y * map.Width + x]].ToArgb();
                        Marshal.Copy(row, 0, IntPtr.Add(data.Scan0, y * data.Stride), row.Length);
                    }
                }
                finally { bitmap.UnlockBits(data); }
                return bitmap;
            }
            catch { bitmap.Dispose(); throw; }
        }
    }
}
