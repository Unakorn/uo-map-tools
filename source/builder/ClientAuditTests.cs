using System;
using System.IO;
using System.Linq;
using TerrainStudio;

public static class ClientAuditTests
{
    static void Check(bool condition, string message) { if (!condition) throw new Exception(message); }
    public static int Main(string[] args)
    {
        if (args.Length != 3) { Console.Error.WriteLine("Usage: ClientAuditTests.exe <Data folder> <client folder> <report output folder>"); return 2; }
        try
        {
            var catalog = Catalog.Load(args[0]);
            using (var assets = ClientAssets.Open(args[1]))
            {
                var first = catalog.RuleInventory().First();
                Check(first.Materials.Count == 9 && first.Key.Length == 18, "Rule inventory preserves all nine material positions.");
                bool readOnly = false;
                try { ((System.Collections.Generic.IList<int>)first.Materials)[0] = -1; } catch (NotSupportedException) { readOnly = true; }
                Check(readOnly, "Rule inventory snapshots must be immutable.");
                string summary = ClientAudit.Write(catalog, assets, args[2]);
                Check(File.ReadLines(Path.Combine(args[2], "client-land-slots.csv")).Count() == 16385, "All 16,384 numerical land slots reported exactly once.");
                Check(File.ReadLines(Path.Combine(args[2], "client-static-slots.csv")).Count() == 65537, "All 65,536 numerical static slots reported exactly once.");
                Check(File.ReadLines(Path.Combine(args[2], "client-texture-slots.csv")).Count() == assets.TextureCount + 1, "All texture index slots reported.");
                Check(File.ReadLines(Path.Combine(args[2], "catalog-rules.csv")).Count() == catalog.RuleCount + 1, "Every actual valid rule reported.");
                Check(File.ReadLines(Path.Combine(args[2], "catalog-materials.csv")).Count() == catalog.Terrains.Count + 1, "Every catalog material reported.");
                Check(summary.Contains("No semantic 'meaningful art' count is asserted") && summary.Contains("No new transition definitions"), "Reports distinguish measurable artwork from semantic completeness.");
                Check(!Directory.GetFiles(args[2]).Any(p => p.EndsWith(".png") || p.EndsWith(".bmp") || p.EndsWith(".mul") || p.EndsWith(".uop")), "Audit writes no artwork copies.");
                bool protectedClient = false;
                try { ClientAudit.Write(catalog, assets, assets.Folder); } catch (ArgumentException) { protectedClient = true; }
                Check(protectedClient, "Audit must reject a client-installation output folder before writes.");
                bool protectedReport = false;
                try { ClientAudit.Write(catalog, assets, args[2]); } catch (IOException) { protectedReport = true; }
                Check(protectedReport && File.ReadAllText(Path.Combine(args[2], "summary.txt")) == summary, "Audit must preserve existing report contents.");
                Console.WriteLine(summary);
                Console.WriteLine("PASS: client audit inventory, immutability, report completeness and no-client-write checks.");
            }
            return 0;
        }
        catch (Exception ex) { Console.Error.WriteLine(ex); return 1; }
    }
}
