using System;

namespace TerrainStudio
{
    /// <summary>Small source fixtures for inspecting existing transition rules, without widening or inventing terrain.</summary>
    public static class TransitionLab
    {
        public const int Size = 32;
        public const int Padding = 4;
        public static readonly string[] Shapes = {
            "Isolated square", "Horizontal strip", "Vertical strip", "Diagonal strip",
            "L-bend", "Ring", "Hole", "Checkerboard"
        };

        public static MapDocument Create(TerrainDefinition background, TerrainDefinition foreground,
            string shape, int width, int backgroundZ, int foregroundZ)
        {
            ValidateTerrain(background, "background");
            ValidateTerrain(foreground, "foreground");
            if (width < 1 || width > 8) throw new ArgumentOutOfRangeException("width", "Test width must be from 1 to 8 cells.");
            if (backgroundZ < -128 || backgroundZ > 127) throw new ArgumentOutOfRangeException("backgroundZ", "Height must be from -128 to 127.");
            if (foregroundZ < -128 || foregroundZ > 127) throw new ArgumentOutOfRangeException("foregroundZ", "Height must be from -128 to 127.");
            if (shape == null) throw new ArgumentNullException("shape");
            string kind = shape.Trim().ToLowerInvariant();
            if (kind != "isolated square" && kind != "horizontal strip" && kind != "vertical strip" &&
                kind != "diagonal strip" && kind != "l-bend" && kind != "ring" && kind != "hole" && kind != "checkerboard")
                throw new ArgumentException("Unknown transition test shape: " + shape, "shape");

            var map = new MapDocument(Size, Size);
            int end = Size - Padding, start = (Size - width) / 2;
            for (int y = 0; y < Size; y++) for (int x = 0; x < Size; x++)
            {
                bool inside = x >= Padding && x < end && y >= Padding && y < end;
                bool centerX = x >= start && x < start + width;
                bool centerY = y >= start && y < start + width;
                bool selected = false;
                if (inside)
                {
                    switch (kind)
                    {
                        case "isolated square": selected = centerX && centerY; break;
                        case "horizontal strip": selected = centerY; break;
                        case "vertical strip": selected = centerX; break;
                        // Width is the number of cells per row of the diagonal band, not a Euclidean distance.
                        // Width 1 deliberately tests corner-only connectivity. Padding clips both endpoints.
                        case "diagonal strip": selected = x - y >= -(width / 2) && x - y < width - width / 2; break;
                        case "l-bend": selected = x < Padding + width || y >= end - width; break;
                        case "ring": selected = x < Padding + width || x >= end - width || y < Padding + width || y >= end - width; break;
                        // A small background hole in a padded foreground island, so neither map-edge policy
                        // nor an unbounded foreground region conceals the hole's immediate neighbors.
                        case "hole": selected = !(centerX && centerY); break;
                        case "checkerboard": selected = (((x - Padding) / width + (y - Padding) / width) & 1) == 0; break;
                    }
                }
                TerrainDefinition terrain = selected ? foreground : background;
                int index = y * Size + x;
                map.Materials[index] = terrain.Id;
                map.Land[index] = terrain.TileId;
                map.Elevation[index] = (sbyte)(selected ? foregroundZ : backgroundZ);
            }
            return map;
        }

        static void ValidateTerrain(TerrainDefinition terrain, string name)
        {
            if (terrain == null) throw new ArgumentNullException(name);
            if (terrain.Id < 0 || terrain.Id > 255) throw new ArgumentException("Catalog material IDs must be from 0 to 255.", name);
            if (terrain.TileId > 0x3FFF) throw new ArgumentException("Land IDs must be from 0 to 16383.", name);
        }
    }
}
