using System;
using System.IO;

namespace TerrainStudio
{
    public static class MapBuildCommand
    {
        public static int Main(string[] args)
        {
            if (args.Length < 3 || args.Length > 5)
            {
                Console.Error.WriteLine("Usage: MapBuild.exe terrain.png altitude.png output-folder [client-data-folder [map-file-number 0-5]]");
                return 2;
            }
            int facet = 0;
            if (args.Length == 5 && (!Int32.TryParse(args[4], out facet) || facet < 0 || facet > 5))
            { Console.Error.WriteLine("Map file number must be from 0 through 5."); return 2; }
            try
            {
                var options = new MapBuildOptions { TerrainPath = args[0], AltitudePath = args[1], OutputDirectory = args[2], ClientPath = args.Length >= 4 ? args[3] : MapBuildDefaults.ClientPath(), RequireTerrainTextures = true, Facet = facet };
                var result = MapBuildJob.Run(Catalog.Load(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "Data")), options, Console.WriteLine);
                Console.WriteLine(result.Report); Console.WriteLine("Output: " + result.OutputDirectory); return 0;
            }
            catch (Exception ex) { Console.Error.WriteLine("Build failed: " + ex.Message); return 1; }
        }
    }
}
