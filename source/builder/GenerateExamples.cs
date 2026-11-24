using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Linq;
using System.Text;
using TerrainStudio;

public static class GenerateExamples
{
    public static void Main(string[] args)
    {
        var catalog = Catalog.Load(Path.Combine(args[0], "Data"));
        var grass = catalog.Terrains.First(t => t.Name == "Grass");
        var folder = Path.Combine(args[0], "examples"); Directory.CreateDirectory(folder);
        var full = new MapDocument(256, 8);
        for (int y = 0; y < full.Height; y++) for (int x = 0; x < full.Width; x++) { int i = y * full.Width + x; full.Land[i] = grass.TileId; full.Materials[i] = grass.Id; full.Elevation[i] = (sbyte)(x - 128); }
        using (var bmp = HeightImages.Export(full)) bmp.Save(Path.Combine(folder, "all-256-heights.png"), ImageFormat.Png);
        MapIO.SaveProject(full, Path.Combine(folder, "all-256-heights.uostudio"));
        var slopes = new MapDocument(64, 64);
        for (int y = 0; y < slopes.Height; y++) for (int x = 0; x < slopes.Width; x++) { int i = y * slopes.Width + x; slopes.Land[i] = grass.TileId; slopes.Materials[i] = grass.Id; slopes.Elevation[i] = (sbyte)(y < 32 ? x : x * 2); }
        using (var bmp = HeightImages.Export(slopes)) bmp.Save(Path.Combine(folder, "one-step-and-two-step-height.png"), ImageFormat.Png);
        using (var bmp = TerrainImages.Export(slopes, catalog)) bmp.Save(Path.Combine(folder, "one-step-and-two-step-terrain.png"), ImageFormat.Png);
        MapIO.SaveProject(slopes, Path.Combine(folder, "one-step-and-two-step.uostudio"));
        File.WriteAllText(Path.Combine(folder, "READ-ME.txt"), "Open either .uostudio file in the editor.\r\n\r\nall-256-heights: X 0..255 stores Z -128..127. Every shade is represented.\r\none-step-and-two-step: top 32 rows rise by Z+1 per pixel; bottom 32 rows rise by Z+2.\r\nThe height PNG still maps each gray shade to ONE elevation.\r\nThe steep slope skips shades; it does not change the encoding.\r\n\r\nTo test the image workflow, import the terrain PNG then its matching height PNG\r\nusing the grayscale height option.\r\n");
        File.WriteAllText(Path.Combine(args[0], "CATALOG-AUDIT.txt"), catalog.Summary + "\r\n\r\n" + String.Join("\r\n", catalog.Warnings), Encoding.UTF8);
    }
}
