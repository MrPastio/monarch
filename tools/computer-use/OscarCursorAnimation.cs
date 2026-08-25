using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace MonarchComputerUse
{
    internal enum OscarCursorVisualState
    {
        Idle = 0,
        Hover = 1,
        Pressed = 2,
        Moving = 3,
        Busy = 4,
        Text = 5,
        Disabled = 6
    }

    internal sealed class OscarCursorAnimationMetrics
    {
        private readonly List<string> states = new List<string>();
        private readonly List<double> frameGaps = new List<double>();
        private double lastFrameAt = -1;

        internal int FrameCount;
        internal double MaxFrameGapMs;
        internal double MotionDurationMs;
        internal double PreClickLeadMs;
        internal int TransitionCount;
        internal int DirectionFrameCount;
        internal double LastDirectionDegrees;
        internal double MaxDirectionStepDegrees;
        internal double SystemCursorWidthPx;
        internal double MaxVisibleCursorExtentPx;

        internal void BeginState(string state)
        {
            if (states.Count > 0 && String.Equals(states[states.Count - 1], state, StringComparison.Ordinal)) return;
            states.Add(state);
            TransitionCount++;
        }

        internal void RecordFrame(double nowMs)
        {
            if (lastFrameAt >= 0)
            {
                double gap = nowMs - lastFrameAt;
                MaxFrameGapMs = Math.Max(MaxFrameGapMs, gap);
                frameGaps.Add(gap);
            }
            lastFrameAt = nowMs;
            FrameCount++;
        }

        internal void RecordDirection(float headingDegrees)
        {
            double normalized = NormalizeDegrees(headingDegrees);
            if (DirectionFrameCount > 0)
            {
                double delta = Math.Abs(normalized - LastDirectionDegrees);
                if (delta > 180) delta = 360 - delta;
                MaxDirectionStepDegrees = Math.Max(MaxDirectionStepDegrees, delta);
            }
            LastDirectionDegrees = normalized;
            DirectionFrameCount++;
        }

        internal Dictionary<string, object> ToDictionary()
        {
            return new Dictionary<string, object>
            {
                { "engine", "oscar-liquid-spring-v1" },
                { "targetFrameRate", 60 },
                { "frameCount", FrameCount },
                { "maxFrameGapMs", Math.Round(MaxFrameGapMs, 2) },
                { "p95FrameGapMs", Math.Round(Percentile(frameGaps, 0.95), 2) },
                { "framesOver33Ms", frameGaps.Count(delegate(double gap) { return gap > 33.34; }) },
                { "framesOver50Ms", frameGaps.Count(delegate(double gap) { return gap > 50.0; }) },
                { "motionDurationMs", Math.Round(MotionDurationMs, 2) },
                { "preClickLeadMs", Math.Round(PreClickLeadMs, 2) },
                { "transitionCount", TransitionCount },
                { "directionModel", "continuous-vector-360" },
                { "directionFrameCount", DirectionFrameCount },
                { "lastDirectionDegrees", Math.Round(LastDirectionDegrees, 2) },
                { "maxDirectionStepDegrees", Math.Round(MaxDirectionStepDegrees, 2) },
                { "systemCursorWidthPx", Math.Round(SystemCursorWidthPx, 2) },
                { "maxVisibleCursorExtentPx", Math.Round(MaxVisibleCursorExtentPx, 2) },
                { "sizePolicy", "entire-sprite-max-1.5x-system-cursor" },
                { "states", states.ToArray() }
            };
        }

        private static double NormalizeDegrees(double value)
        {
            value %= 360.0;
            return value < 0 ? value + 360.0 : value;
        }

        private static double Percentile(List<double> values, double percentile)
        {
            if (values.Count == 0) return 0;
            double[] ordered = values.OrderBy(delegate(double value) { return value; }).ToArray();
            int index = (int)Math.Ceiling(percentile * ordered.Length) - 1;
            return ordered[Math.Max(0, Math.Min(ordered.Length - 1, index))];
        }
    }

    internal sealed class OscarCursorSprite : IDisposable
    {
        internal readonly Bitmap Bitmap;
        internal readonly PointF Hotspot;
        internal readonly RectangleF BodyBounds;

        internal OscarCursorSprite(Bitmap bitmap, PointF hotspot, RectangleF bodyBounds)
        {
            Bitmap = bitmap;
            Hotspot = hotspot;
            BodyBounds = bodyBounds;
        }

        public void Dispose()
        {
            Bitmap.Dispose();
        }
    }

    internal sealed class OscarCursorAssets : IDisposable
    {
        private static readonly string[] ResourceNames = new[]
        {
            "MonarchComputerUse.OscarCursor.Idle.png",
            "MonarchComputerUse.OscarCursor.Hover.png",
            "MonarchComputerUse.OscarCursor.Pressed.png",
            "MonarchComputerUse.OscarCursor.Moving.png",
            "MonarchComputerUse.OscarCursor.Busy.png",
            "MonarchComputerUse.OscarCursor.Text.png",
            "MonarchComputerUse.OscarCursor.Disabled.png"
        };
        private readonly OscarCursorSprite[] sprites;

        internal OscarCursorAssets()
            : this(0)
        {
        }

        internal OscarCursorAssets(int maximumRuntimeExtentPx)
        {
            sprites = new OscarCursorSprite[ResourceNames.Length];
            for (int index = 0; index < ResourceNames.Length; index++)
            {
                string resourceName = ResourceNames[index];
                using (Stream stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(resourceName))
                {
                    if (stream == null) throw new NativeFailure("cursor-asset-missing", "Embedded Oscar cursor asset is unavailable: " + resourceName);
                    using (Bitmap source = new Bitmap(stream))
                    {
                        sprites[index] = ExtractSprite(source, resourceName, maximumRuntimeExtentPx);
                    }
                }
            }
        }

        internal OscarCursorSprite Get(OscarCursorVisualState state)
        {
            return sprites[(int)state];
        }

        public void Dispose()
        {
            foreach (OscarCursorSprite sprite in sprites) sprite.Dispose();
        }

        private static OscarCursorSprite ExtractSprite(Bitmap input, string resourceName, int maximumRuntimeExtentPx)
        {
            if (input.Width < 128 || input.Height < 128)
            {
                throw new NativeFailure("cursor-asset-invalid", "Oscar cursor asset is too small: " + resourceName);
            }
            using (Bitmap source = new Bitmap(input.Width, input.Height, PixelFormat.Format32bppArgb))
            using (Bitmap transparent = new Bitmap(input.Width, input.Height, PixelFormat.Format32bppPArgb))
            {
                using (Graphics graphics = Graphics.FromImage(source)) graphics.DrawImageUnscaled(input, 0, 0);
                Rectangle full = new Rectangle(0, 0, source.Width, source.Height);
                Color background = AverageCorners(source);
                BitmapData sourceData = source.LockBits(full, ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
                BitmapData outputData = transparent.LockBits(full, ImageLockMode.WriteOnly, PixelFormat.Format32bppPArgb);
                int outputStride = outputData.Stride;
                try
                {
                    int sourceStride = Math.Abs(sourceData.Stride);
                    byte[] sourceBytes = new byte[sourceStride * source.Height];
                    Marshal.Copy(sourceData.Scan0, sourceBytes, 0, sourceBytes.Length);
                    byte[] output = new byte[Math.Abs(outputData.Stride) * source.Height];
                    for (int y = 0; y < source.Height; y++)
                    {
                        int sourceRow = SourceRow(sourceData.Stride, source.Height, y);
                        int outputRow = SourceRow(outputData.Stride, source.Height, y);
                        for (int x = 0; x < source.Width; x++)
                        {
                            int sourceOffset = sourceRow + x * 4;
                            int outputOffset = outputRow + x * 4;
                            byte sourceBlue = sourceBytes[sourceOffset];
                            byte sourceGreen = sourceBytes[sourceOffset + 1];
                            byte sourceRed = sourceBytes[sourceOffset + 2];
                            int alpha = ChromaAlpha(sourceRed, sourceGreen, sourceBlue, background);
                            if (alpha <= 0) continue;
                            double normalizedAlpha = alpha / 255.0;
                            output[outputOffset] = PremultipliedChannel(sourceBlue, background.B, normalizedAlpha);
                            output[outputOffset + 1] = PremultipliedChannel(sourceGreen, background.G, normalizedAlpha);
                            output[outputOffset + 2] = PremultipliedChannel(sourceRed, background.R, normalizedAlpha);
                            output[outputOffset + 3] = (byte)alpha;
                        }
                    }
                    Marshal.Copy(output, 0, outputData.Scan0, output.Length);
                }
                finally
                {
                    source.UnlockBits(sourceData);
                    transparent.UnlockBits(outputData);
                }

                Rectangle visible = FindVisibleBounds(transparent);
                if (visible.Width <= 0 || visible.Height <= 0)
                {
                    throw new NativeFailure("cursor-asset-empty", "Oscar cursor asset contains no visible artwork: " + resourceName);
                }
                visible.Inflate(12, 12);
                visible.Intersect(new Rectangle(0, 0, transparent.Width, transparent.Height));
                Bitmap sprite = transparent.Clone(visible, PixelFormat.Format32bppPArgb);
                if (maximumRuntimeExtentPx > 0
                    && Math.Max(sprite.Width, sprite.Height) > maximumRuntimeExtentPx)
                {
                    Bitmap optimized = ResizeSprite(sprite, maximumRuntimeExtentPx);
                    sprite.Dispose();
                    sprite = optimized;
                }
                RectangleF bodyBounds;
                PointF hotspot;
                FindBodyGeometry(sprite, out bodyBounds, out hotspot);
                return new OscarCursorSprite(sprite, hotspot, bodyBounds);
            }
        }

        private static Bitmap ResizeSprite(Bitmap source, int maximumExtentPx)
        {
            float scale = maximumExtentPx / (float)Math.Max(source.Width, source.Height);
            int width = Math.Max(1, (int)Math.Round(source.Width * scale));
            int height = Math.Max(1, (int)Math.Round(source.Height * scale));
            Bitmap output = new Bitmap(width, height, PixelFormat.Format32bppPArgb);
            using (Graphics graphics = Graphics.FromImage(output))
            {
                graphics.Clear(Color.Transparent);
                graphics.CompositingMode = CompositingMode.SourceCopy;
                graphics.CompositingQuality = CompositingQuality.HighQuality;
                graphics.InterpolationMode = InterpolationMode.HighQualityBicubic;
                graphics.PixelOffsetMode = PixelOffsetMode.HighQuality;
                graphics.DrawImage(source, new Rectangle(0, 0, width, height));
            }
            return output;
        }

        private static Rectangle FindVisibleBounds(Bitmap bitmap)
        {
            Rectangle bounds = new Rectangle(0, 0, bitmap.Width, bitmap.Height);
            BitmapData data = bitmap.LockBits(bounds, ImageLockMode.ReadOnly, PixelFormat.Format32bppPArgb);
            try
            {
                int stride = Math.Abs(data.Stride);
                byte[] pixels = new byte[stride * bitmap.Height];
                Marshal.Copy(data.Scan0, pixels, 0, pixels.Length);
                int left = bitmap.Width;
                int top = bitmap.Height;
                int right = -1;
                int bottom = -1;
                for (int y = 0; y < bitmap.Height; y++)
                {
                    int row = SourceRow(data.Stride, bitmap.Height, y);
                    for (int x = 0; x < bitmap.Width; x++)
                    {
                        if (pixels[row + x * 4 + 3] <= 18) continue;
                        left = Math.Min(left, x);
                        top = Math.Min(top, y);
                        right = Math.Max(right, x);
                        bottom = Math.Max(bottom, y);
                    }
                }
                return right < left || bottom < top
                    ? Rectangle.Empty
                    : Rectangle.FromLTRB(left, top, right + 1, bottom + 1);
            }
            finally
            {
                bitmap.UnlockBits(data);
            }
        }

        private static int SourceRow(int stride, int height, int y)
        {
            return stride >= 0 ? y * stride : (height - 1 - y) * -stride;
        }

        private static Color AverageCorners(Bitmap bitmap)
        {
            Color[] values = new[]
            {
                bitmap.GetPixel(0, 0),
                bitmap.GetPixel(bitmap.Width - 1, 0),
                bitmap.GetPixel(0, bitmap.Height - 1),
                bitmap.GetPixel(bitmap.Width - 1, bitmap.Height - 1)
            };
            return Color.FromArgb(
                (int)values.Average(delegate(Color value) { return value.R; }),
                (int)values.Average(delegate(Color value) { return value.G; }),
                (int)values.Average(delegate(Color value) { return value.B; }));
        }

        private static int ChromaAlpha(byte red, byte green, byte blue, Color background)
        {
            double maximum = Math.Max(red, Math.Max(green, blue));
            double minimum = Math.Min(red, Math.Min(green, blue));
            double saturation = maximum <= 0 ? 0 : (maximum - minimum) / maximum;
            double hue = 0;
            if (maximum > minimum)
            {
                if (maximum == red) hue = 60.0 * (((green - blue) / (maximum - minimum)) % 6.0);
                else if (maximum == green) hue = 60.0 * (((blue - red) / (maximum - minimum)) + 2.0);
                else hue = 60.0 * (((red - green) / (maximum - minimum)) + 4.0);
                if (hue < 0) hue += 360.0;
            }
            // Image generation may introduce a subtle luminance texture even
            // when a flat chroma background is requested. Hue-key the full
            // magenta family first; keep red/orange glow and neutral black or
            // white cursor details untouched.
            if (saturation > 0.24 && hue >= 272.0 && hue <= 334.0) return 0;
            double deltaRed = red - background.R;
            double deltaGreen = green - background.G;
            double deltaBlue = blue - background.B;
            double distance = Math.Sqrt(deltaRed * deltaRed + deltaGreen * deltaGreen + deltaBlue * deltaBlue);
            if (distance <= 7) return 0;
            return Math.Max(0, Math.Min(255, (int)Math.Round((distance - 7) * 255.0 / 170.0)));
        }

        private static byte PremultipliedChannel(byte source, byte background, double alpha)
        {
            double value = source - background * (1.0 - alpha);
            return (byte)Math.Max(0, Math.Min(255, (int)Math.Round(value)));
        }

        private static void FindBodyGeometry(Bitmap bitmap, out RectangleF bodyBounds, out PointF hotspot)
        {
            Rectangle bounds = new Rectangle(0, 0, bitmap.Width, bitmap.Height);
            BitmapData data = bitmap.LockBits(bounds, ImageLockMode.ReadOnly, PixelFormat.Format32bppPArgb);
            byte[] pixels;
            int bitmapStride = data.Stride;
            try
            {
                pixels = new byte[Math.Abs(bitmapStride) * bitmap.Height];
                Marshal.Copy(data.Scan0, pixels, 0, pixels.Length);
            }
            finally
            {
                bitmap.UnlockBits(data);
            }
            int width = bitmap.Width;
            int height = bitmap.Height;
            bool[] mask = new bool[width * height];
            for (int y = 0; y < height; y++)
            {
                int row = SourceRow(bitmapStride, height, y);
                for (int x = 0; x < width; x++)
                {
                    int offset = row + x * 4;
                    int alpha = pixels[offset + 3];
                    if (alpha < 175) continue;
                    double unpremultiply = 255.0 / alpha;
                    double blue = Math.Min(255, pixels[offset] * unpremultiply);
                    double green = Math.Min(255, pixels[offset + 1] * unpremultiply);
                    double red = Math.Min(255, pixels[offset + 2] * unpremultiply);
                    double maximum = Math.Max(red, Math.Max(green, blue));
                    // The dark outer shell is shared by every state and is
                    // independent from glow, click rings and directional
                    // particles. Its bounding box therefore provides a stable
                    // physical body size for seamless cross-state morphing.
                    mask[y * width + x] = maximum <= 128;
                }
            }
            bool[] visited = new bool[mask.Length];
            int[] queue = new int[mask.Length];
            List<int> bodyComponent = new List<int>();
            int bodyScore = -1;
            for (int start = 0; start < mask.Length; start++)
            {
                if (!mask[start] || visited[start]) continue;
                List<int> component = new List<int>();
                int head = 0;
                int tail = 0;
                queue[tail++] = start;
                visited[start] = true;
                while (head < tail)
                {
                    int index = queue[head++];
                    component.Add(index);
                    int x = index % width;
                    int y = index / width;
                    AddNeighbor(x - 1, y, width, height, mask, visited, queue, ref tail);
                    AddNeighbor(x + 1, y, width, height, mask, visited, queue, ref tail);
                    AddNeighbor(x, y - 1, width, height, mask, visited, queue, ref tail);
                    AddNeighbor(x, y + 1, width, height, mask, visited, queue, ref tail);
                }
                int componentLeft = component.Min(delegate(int index) { return index % width; });
                int componentTop = component.Min(delegate(int index) { return index / width; });
                int componentRight = component.Max(delegate(int index) { return index % width; });
                int componentBottom = component.Max(delegate(int index) { return index / width; });
                int score = (componentRight - componentLeft + 1) * (componentBottom - componentTop + 1);
                if (score > bodyScore)
                {
                    bodyScore = score;
                    bodyComponent = component;
                }
            }
            if (bodyComponent.Count == 0)
            {
                bodyBounds = new RectangleF(0, 0, width, height);
                hotspot = new PointF(width - 1, height * 0.5f);
                return;
            }
            int left = bodyComponent.Min(delegate(int index) { return index % width; });
            int top = bodyComponent.Min(delegate(int index) { return index / width; });
            int right = bodyComponent.Max(delegate(int index) { return index % width; });
            int bottom = bodyComponent.Max(delegate(int index) { return index / width; });
            bodyBounds = RectangleF.FromLTRB(left, top, right + 1, bottom + 1);
            int tipBand = Math.Max(3, (right - left + 1) / 45);
            int[] tipPixels = bodyComponent.Where(delegate(int index) { return index % width >= right - tipBand; }).ToArray();
            float tipY = tipPixels.Length == 0
                ? bodyBounds.Top + bodyBounds.Height * 0.5f
                : (float)tipPixels.Average(delegate(int index) { return index / width; });
            float tipX = Math.Min(width - 1, right + Math.Max(2f, bodyBounds.Width * 0.045f));
            hotspot = new PointF(tipX, tipY);
        }

        private static void AddNeighbor(
            int x,
            int y,
            int width,
            int height,
            bool[] mask,
            bool[] visited,
            int[] queue,
            ref int tail)
        {
            if (x < 0 || y < 0 || x >= width || y >= height) return;
            int index = y * width + x;
            if (!mask[index] || visited[index]) return;
            visited[index] = true;
            queue[tail++] = index;
        }
    }

    internal static class OscarPersistentCursorHost
    {
        private sealed class ControlState
        {
            internal bool Enabled;
            internal string ActiveLeaseId;
            internal Point? LogicalPosition;
        }

        private sealed class VisualLease
        {
            internal string LeaseId;
            internal int ProcessId;
            internal Point Target;
        }

        internal static Dictionary<string, object> Run(
            string controlStatePath,
            string visualLeasePath,
            string readyPath,
            string stopPath,
            int ownerProcessId,
            string ownerHeartbeatPath)
        {
            ControlState initial = ReadControlState(controlStatePath);
            Point origin = initial != null && initial.LogicalPosition.HasValue
                ? initial.LogicalPosition.Value
                : DefaultOrigin();
            int handoffCount = 0;
            bool suppressed = false;
            Point handoffPosition = origin;
            using (OscarCursorOverlay overlay = OscarCursorOverlay.ShowPersistentAt(origin))
            {
                WriteMarker(readyPath, new Dictionary<string, object>
                {
                    { "ready", true },
                    { "persistent", true },
                    { "processId", Process.GetCurrentProcess().Id },
                    { "systemCursorWidthPx", Math.Max(24, NativeMethods.GetSystemMetrics(NativeMethods.SystemMetricCursorWidth)) },
                    { "sizePolicy", "entire-sprite-max-1.5x-system-cursor" },
                    { "startedAt", DateTime.UtcNow.ToString("o") }
                });
                double nextFrame = 0;
                double nextOwnerCheck = 0;
                Stopwatch clock = Stopwatch.StartNew();
                while (true)
                {
                    if (clock.Elapsed.TotalMilliseconds >= nextOwnerCheck)
                    {
                        nextOwnerCheck = clock.Elapsed.TotalMilliseconds + 250;
                        if (!OwnerRuntimeIsAlive(ownerProcessId, ownerHeartbeatPath))
                        {
                            if (!suppressed) overlay.DisabledAndFade(120);
                            break;
                        }
                    }
                    if (File.Exists(stopPath))
                    {
                        if (!suppressed) overlay.FadeOut(null, 120);
                        break;
                    }
                    ControlState state = ReadControlState(controlStatePath);
                    if (state == null)
                    {
                        Thread.Sleep(16);
                        continue;
                    }
                    VisualLease visualLease = ReadVisualLease(visualLeasePath);
                    if (!state.Enabled)
                    {
                        if (!suppressed) overlay.DisabledAndFade(140);
                        break;
                    }
                    if (visualLease != null && (
                        String.IsNullOrEmpty(state.ActiveLeaseId)
                        || String.Equals(state.ActiveLeaseId, visualLease.LeaseId, StringComparison.Ordinal)))
                    {
                        handoffPosition = visualLease.Target;
                        if (!suppressed)
                        {
                            overlay.SuppressPersistent(70);
                            suppressed = true;
                        }
                    }
                    else if (suppressed)
                    {
                        overlay.ResumePersistentAt(handoffPosition, 70);
                        suppressed = false;
                        handoffCount++;
                    }
                    else if (String.IsNullOrEmpty(state.ActiveLeaseId))
                    {
                        if (state.LogicalPosition.HasValue && Distance(overlay.Position, state.LogicalPosition.Value) > 2.0)
                        {
                            overlay.MovePersistentTo(state.LogicalPosition.Value);
                        }
                        overlay.PersistentIdleTick();
                    }
                    else
                    {
                        // Preflight is still running. Keep the idle cursor at
                        // its current position until the action overlay has
                        // actually appeared and acquired the visual lease.
                        overlay.PersistentIdleTick();
                    }
                    nextFrame += 1000.0 / 60.0;
                    double remaining = nextFrame - clock.Elapsed.TotalMilliseconds;
                    if (remaining > 1) Thread.Sleep((int)Math.Min(8, remaining));
                    else if (remaining < -250) nextFrame = clock.Elapsed.TotalMilliseconds;
                    Application.DoEvents();
                }
            }
            return new Dictionary<string, object>
            {
                { "stopped", true },
                { "persistent", true },
                { "handoffCount", handoffCount }
            };
        }

        private static bool OwnerRuntimeIsAlive(int processId, string heartbeatPath)
        {
            try
            {
                using (Process owner = Process.GetProcessById(processId))
                {
                    if (owner.HasExited) return false;
                }
                if (!File.Exists(heartbeatPath)) return false;
                return DateTime.UtcNow - File.GetLastWriteTimeUtc(heartbeatPath) <= TimeSpan.FromSeconds(5);
            }
            catch
            {
                return false;
            }
        }

        private static ControlState ReadControlState(string path)
        {
            try
            {
                if (!File.Exists(path)) return null;
                JavaScriptSerializer serializer = new JavaScriptSerializer();
                Dictionary<string, object> record = serializer.Deserialize<Dictionary<string, object>>(SharedFile.ReadUtf8Text(path));
                object enabledValue;
                object leaseValue;
                object cursorValue;
                bool enabled = record.TryGetValue("enabled", out enabledValue) && Convert.ToBoolean(enabledValue);
                string lease = record.TryGetValue("activeLeaseId", out leaseValue) && leaseValue != null
                    ? Convert.ToString(leaseValue)
                    : "";
                Point? logical = null;
                Dictionary<string, object> cursor = record.TryGetValue("logicalCursor", out cursorValue)
                    ? cursorValue as Dictionary<string, object>
                    : null;
                object xValue;
                object yValue;
                if (cursor != null
                    && cursor.TryGetValue("x", out xValue) && xValue != null
                    && cursor.TryGetValue("y", out yValue) && yValue != null)
                {
                    logical = new Point(Convert.ToInt32(xValue), Convert.ToInt32(yValue));
                }
                return new ControlState { Enabled = enabled, ActiveLeaseId = lease, LogicalPosition = logical };
            }
            catch
            {
                return null;
            }
        }

        private static VisualLease ReadVisualLease(string path)
        {
            try
            {
                if (!File.Exists(path)) return null;
                JavaScriptSerializer serializer = new JavaScriptSerializer();
                Dictionary<string, object> record = serializer.Deserialize<Dictionary<string, object>>(SharedFile.ReadUtf8Text(path));
                int processId = Convert.ToInt32(record["processId"]);
                using (Process process = Process.GetProcessById(processId))
                {
                    if (process.HasExited) return null;
                }
                return new VisualLease
                {
                    LeaseId = Convert.ToString(record["leaseId"]),
                    ProcessId = processId,
                    Target = new Point(Convert.ToInt32(record["targetX"]), Convert.ToInt32(record["targetY"]))
                };
            }
            catch
            {
                try { if (File.Exists(path)) File.Delete(path); }
                catch { }
                return null;
            }
        }

        private static Point DefaultOrigin()
        {
            NativeMethods.NativePoint cursor;
            if (NativeMethods.GetCursorPos(out cursor)) return new Point(cursor.X, cursor.Y);
            Rectangle working = Screen.PrimaryScreen.WorkingArea;
            return new Point(working.Left + working.Width / 2, working.Top + working.Height / 2);
        }

        private static double Distance(Point left, Point right)
        {
            double x = left.X - right.X;
            double y = left.Y - right.Y;
            return Math.Sqrt(x * x + y * y);
        }

        private static void WriteMarker(string path, Dictionary<string, object> value)
        {
            string parent = Path.GetDirectoryName(path);
            if (!String.IsNullOrWhiteSpace(parent)) Directory.CreateDirectory(parent);
            JavaScriptSerializer serializer = new JavaScriptSerializer();
            string temporary = path + ".tmp-" + Guid.NewGuid().ToString("N");
            File.WriteAllText(temporary, serializer.Serialize(value));
            if (File.Exists(path)) File.Delete(path);
            File.Move(temporary, path);
        }
    }

    internal sealed class OscarCursorOverlay : Form
    {
        private const int ExtendedLayered = 0x00080000;
        private const int ExtendedToolWindow = 0x00000080;
        private const int ExtendedTransparent = 0x00000020;
        private const int ExtendedNoActivate = 0x08000000;
        private const double FrameIntervalMs = 1000.0 / 60.0;

        private readonly OscarCursorAssets assets;
        private readonly Stopwatch clock = Stopwatch.StartNew();
        private readonly List<PointF> history = new List<PointF>();
        private readonly float dpiScale;
        private readonly int canvasWidth;
        private readonly int canvasHeight;
        private readonly PointF anchor;
        private readonly float cursorBodyWidth;
        private readonly OscarCursorAnimationMetrics metrics = new OscarCursorAnimationMetrics();
        private IntPtr screenDc;
        private IntPtr memoryDc;
        private IntPtr dibHandle;
        private IntPtr previousBitmap;
        private Bitmap frameCanvas;
        private Graphics frameGraphics;
        private readonly ImageAttributes frameImageAttributes = new ImageAttributes();
        private readonly ColorMatrix frameColorMatrix = new ColorMatrix();
        private Pen[] energyRingPens;
        private readonly ThreadPriority previousThreadPriority;
        private readonly bool timerResolutionRaised;
        private PointF position;
        private PointF velocity;
        private PointF vibration;
        private OscarCursorVisualState currentState = OscarCursorVisualState.Idle;
        private float opacity;
        private float bodyScale = 1f;
        private float rings;
        private float trailStrength;
        private float headingDegrees;
        private float headingVelocity;
        private float directionalStretch = 1f;
        private double preClickStartedAt = -1;

        private OscarCursorOverlay(Point origin, IntPtr targetWindow)
        {
            assets = new OscarCursorAssets(128);
            previousThreadPriority = Thread.CurrentThread.Priority;
            try { Thread.CurrentThread.Priority = ThreadPriority.AboveNormal; }
            catch { }
            timerResolutionRaised = NativeMethods.timeBeginPeriod(1) == 0;
            uint dpi = 96;
            try
            {
                if (targetWindow != IntPtr.Zero) dpi = NativeMethods.GetDpiForWindow(targetWindow);
                else
                {
                    using (Graphics screen = Graphics.FromHwnd(IntPtr.Zero)) dpi = (uint)Math.Round(screen.DpiX);
                }
            }
            catch (EntryPointNotFoundException) { dpi = 96; }
            dpiScale = Math.Max(0.8f, Math.Min(2.25f, (dpi <= 0 ? 96 : dpi) / 96f));
            cursorBodyWidth = Math.Max(24f, NativeMethods.GetSystemMetrics(NativeMethods.SystemMetricCursorWidth));
            metrics.SystemCursorWidthPx = cursorBodyWidth;
            metrics.MaxVisibleCursorExtentPx = cursorBodyWidth * 1.5f;
            canvasWidth = (int)Math.Round(150 * dpiScale);
            canvasHeight = (int)Math.Round(150 * dpiScale);
            anchor = new PointF(75 * dpiScale, 75 * dpiScale);
            InitializeFrameSurface();
            position = origin;
            history.Add(position);
            FormBorderStyle = FormBorderStyle.None;
            ShowInTaskbar = false;
            TopMost = true;
            StartPosition = FormStartPosition.Manual;
            Bounds = new Rectangle(-32000, -32000, canvasWidth, canvasHeight);
        }

        protected override bool ShowWithoutActivation { get { return true; } }

        protected override CreateParams CreateParams
        {
            get
            {
                CreateParams parameters = base.CreateParams;
                parameters.ExStyle |= ExtendedLayered | ExtendedToolWindow | ExtendedTransparent | ExtendedNoActivate;
                return parameters;
            }
        }

        internal OscarCursorAnimationMetrics Metrics { get { return metrics; } }
        internal Point Position { get { return Point.Round(position); } }

        internal static OscarCursorOverlay ShowAt(Point origin, IntPtr targetWindow, ControlGuard control)
        {
            OscarCursorOverlay overlay = new OscarCursorOverlay(origin, targetWindow);
            overlay.Show();
            Application.DoEvents();
            overlay.Appear(control);
            return overlay;
        }

        internal static OscarCursorOverlay ShowPersistentAt(Point origin)
        {
            OscarCursorOverlay overlay = new OscarCursorOverlay(origin, IntPtr.Zero);
            overlay.Show();
            Application.DoEvents();
            overlay.Appear(null);
            return overlay;
        }

        internal static Dictionary<string, object> RenderShowcase(string outputPath)
        {
            string directory = Path.GetDirectoryName(outputPath);
            if (String.IsNullOrWhiteSpace(directory)) throw new NativeFailure("cursor-showcase-path-invalid", "Cursor showcase path has no parent directory.");
            Directory.CreateDirectory(directory);
            using (OscarCursorAssets showcaseAssets = new OscarCursorAssets())
            using (Bitmap canvas = new Bitmap(1456, 1086, PixelFormat.Format32bppArgb))
            using (Graphics graphics = Graphics.FromImage(canvas))
            {
                graphics.Clear(Color.FromArgb(9, 10, 12));
                graphics.SmoothingMode = SmoothingMode.AntiAlias;
                graphics.InterpolationMode = InterpolationMode.HighQualityBicubic;
                graphics.PixelOffsetMode = PixelOffsetMode.HighQuality;
                using (Font title = new Font("Segoe UI", 42f, FontStyle.Regular, GraphicsUnit.Pixel))
                using (Font subtitle = new Font("Segoe UI", 21f, FontStyle.Bold, GraphicsUnit.Pixel))
                using (Font label = new Font("Segoe UI", 18f, FontStyle.Bold, GraphicsUnit.Pixel))
                using (SolidBrush white = new SolidBrush(Color.FromArgb(242, 246, 248)))
                using (SolidBrush muted = new SolidBrush(Color.FromArgb(92, 96, 103)))
                using (Pen divider = new Pen(Color.FromArgb(42, 255, 255, 255), 2f))
                {
                    graphics.DrawString("Oscar Cursor Set", title, white, 72, 50);
                    graphics.DrawString("FOR MONARCH COMPUTER USE", subtitle, muted, 76, 108);
                    graphics.DrawLine(divider, 48, 178, 1408, 178);
                    DrawShowcaseState(graphics, showcaseAssets.Get(OscarCursorVisualState.Idle), new PointF(292, 365), 176f, 1f);
                    DrawShowcaseState(graphics, showcaseAssets.Get(OscarCursorVisualState.Hover), new PointF(625, 365), 176f, 1f);
                    DrawShowcaseState(graphics, showcaseAssets.Get(OscarCursorVisualState.Pressed), new PointF(958, 365), 176f, 1f);
                    DrawShowcaseState(graphics, showcaseAssets.Get(OscarCursorVisualState.Moving), new PointF(1290, 365), 176f, 1f);
                    DrawShowcaseState(graphics, showcaseAssets.Get(OscarCursorVisualState.Busy), new PointF(494, 740), 208f, 1f);
                    DrawShowcaseState(graphics, showcaseAssets.Get(OscarCursorVisualState.Text), new PointF(856, 740), 208f, 1f);
                    DrawShowcaseState(graphics, showcaseAssets.Get(OscarCursorVisualState.Disabled), new PointF(1220, 740), 208f, 1f);
                    string[] labels = new[]
                    {
                        "1. DEFAULT / IDLE", "2. HOVER", "3. PRE-CLICK / PRESSED", "4. MOVING",
                        "5. BUSY / LOADING", "6. TEXT / PRECISION", "7. DISABLED / STOPPED"
                    };
                    PointF[] labelPoints = new[]
                    {
                        new PointF(86, 552), new PointF(432, 552), new PointF(746, 552), new PointF(1090, 552),
                        new PointF(218, 905), new PointF(600, 905), new PointF(980, 905)
                    };
                    for (int index = 0; index < labels.Length; index++) graphics.DrawString(labels[index], label, muted, labelPoints[index]);
                    graphics.DrawLine(divider, 48, 1012, 680, 1012);
                    graphics.DrawLine(divider, 776, 1012, 1408, 1012);
                }
                string temporary = outputPath + ".tmp-" + Guid.NewGuid().ToString("N") + ".png";
                canvas.Save(temporary, ImageFormat.Png);
                if (File.Exists(outputPath)) File.Delete(outputPath);
                File.Move(temporary, outputPath);
            }
            FileInfo output = new FileInfo(outputPath);
            return new Dictionary<string, object>
            {
                { "rendered", true },
                { "path", output.FullName },
                { "width", 1456 },
                { "height", 1086 },
                { "bytes", output.Length },
                { "engine", "oscar-liquid-spring-v1" }
            };
        }

        internal static Dictionary<string, object> RenderDirectionShowcase(string outputPath)
        {
            string directory = Path.GetDirectoryName(outputPath);
            if (String.IsNullOrWhiteSpace(directory)) throw new NativeFailure("cursor-showcase-path-invalid", "Cursor direction showcase path has no parent directory.");
            Directory.CreateDirectory(directory);
            using (OscarCursorAssets showcaseAssets = new OscarCursorAssets())
            using (Bitmap canvas = new Bitmap(1456, 900, PixelFormat.Format32bppArgb))
            using (Graphics graphics = Graphics.FromImage(canvas))
            {
                graphics.Clear(Color.FromArgb(9, 10, 12));
                graphics.SmoothingMode = SmoothingMode.AntiAlias;
                graphics.InterpolationMode = InterpolationMode.HighQualityBicubic;
                graphics.PixelOffsetMode = PixelOffsetMode.HighQuality;
                using (Font title = new Font("Segoe UI", 42f, FontStyle.Regular, GraphicsUnit.Pixel))
                using (Font subtitle = new Font("Segoe UI", 20f, FontStyle.Bold, GraphicsUnit.Pixel))
                using (Font label = new Font("Segoe UI", 18f, FontStyle.Bold, GraphicsUnit.Pixel))
                using (SolidBrush white = new SolidBrush(Color.FromArgb(242, 246, 248)))
                using (SolidBrush muted = new SolidBrush(Color.FromArgb(100, 106, 115)))
                using (Pen divider = new Pen(Color.FromArgb(42, 255, 255, 255), 2f))
                {
                    graphics.DrawString("Oscar Motion Directions", title, white, 72, 48);
                    graphics.DrawString("CONTINUOUS 360-DEGREE VELOCITY VECTOR · SPRING-INTERPOLATED", subtitle, muted, 76, 108);
                    graphics.DrawLine(divider, 48, 178, 1408, 178);
                    float[] directions = new[] { 0f, 45f, 90f, 135f, 180f, 225f, 270f, 315f };
                    string[] labels = new[]
                    {
                        "RIGHT · 0°", "DOWN-RIGHT · 45°", "DOWN · 90°", "DOWN-LEFT · 135°",
                        "LEFT · 180°", "UP-LEFT · 225°", "UP · 270°", "UP-RIGHT · 315°"
                    };
                    PointF[] points = new[]
                    {
                        new PointF(235, 350), new PointF(570, 350), new PointF(905, 350), new PointF(1240, 350),
                        new PointF(235, 690), new PointF(570, 690), new PointF(905, 690), new PointF(1240, 690)
                    };
                    for (int index = 0; index < directions.Length; index++)
                    {
                        DrawShowcaseState(
                            graphics,
                            showcaseAssets.Get(OscarCursorVisualState.Moving),
                            points[index],
                            105f,
                            1f,
                            directions[index],
                            1.11f,
                            0.96f);
                        SizeF labelSize = graphics.MeasureString(labels[index], label);
                        float labelY = index < 4 ? 490f : 535f;
                        graphics.DrawString(labels[index], label, muted, points[index].X - labelSize.Width / 2, labelY);
                    }
                    graphics.DrawLine(divider, 48, 856, 1408, 856);
                }
                string temporary = outputPath + ".tmp-" + Guid.NewGuid().ToString("N") + ".png";
                canvas.Save(temporary, ImageFormat.Png);
                if (File.Exists(outputPath)) File.Delete(outputPath);
                File.Move(temporary, outputPath);
            }
            FileInfo output = new FileInfo(outputPath);
            return new Dictionary<string, object>
            {
                { "rendered", true },
                { "path", output.FullName },
                { "width", 1456 },
                { "height", 900 },
                { "bytes", output.Length },
                { "engine", "oscar-liquid-spring-v1" },
                { "directionModel", "continuous-vector-360" }
            };
        }

        internal void MoveTo(Point target, ControlGuard control)
        {
            metrics.BeginState("moving");
            OscarCursorVisualState fromState = currentState;
            PointF targetPoint = target;
            double started = clock.Elapsed.TotalMilliseconds;
            double last = started;
            double distance = Distance(position, targetPoint);
            double minimumDuration = Math.Max(260, Math.Min(520, 240 + Math.Sqrt(distance) * 12));
            double maximumDuration = Math.Max(620, Math.Min(1200, 650 + Math.Sqrt(distance) * 20));
            double nextFrame = started;
            while (true)
            {
                if (control != null) control.Verify();
                double now = clock.Elapsed.TotalMilliseconds;
                double elapsed = now - started;
                double deltaSeconds = Math.Max(0.001, Math.Min(0.034, (now - last) / 1000.0));
                last = now;
                const float stiffness = 42f;
                const float damping = 12.961f;
                velocity = new PointF(
                    velocity.X + ((targetPoint.X - position.X) * stiffness - velocity.X * damping) * (float)deltaSeconds,
                    velocity.Y + ((targetPoint.Y - position.Y) * stiffness - velocity.Y * damping) * (float)deltaSeconds);
                position = new PointF(
                    position.X + velocity.X * (float)deltaSeconds,
                    position.Y + velocity.Y * (float)deltaSeconds);
                PushHistory(position);
                float transition = SmoothStep((float)Math.Min(1, elapsed / 180.0));
                float speed = (float)Math.Sqrt(velocity.X * velocity.X + velocity.Y * velocity.Y);
                UpdateDirectionalPhysics(deltaSeconds, speed);
                trailStrength = Math.Max(0.25f, Math.Min(1f, speed / 900f));
                bodyScale = 1f + Math.Min(0.045f, speed / 16000f);
                directionalStretch = 1f + Math.Min(0.14f, speed / 8000f);
                RenderFrame(fromState, OscarCursorVisualState.Moving, transition);
                double remaining = Distance(position, targetPoint);
                if ((elapsed >= minimumDuration && remaining < 0.65 && speed < 4.5f) || elapsed >= maximumDuration) break;
                nextFrame += FrameIntervalMs;
                WaitUntil(nextFrame);
            }
            position = targetPoint;
            velocity = PointF.Empty;
            PushHistory(position);
            trailStrength = 0.18f;
            bodyScale = 1f;
            directionalStretch = 1.025f;
            currentState = OscarCursorVisualState.Moving;
            RenderFrame(currentState, currentState, 1f);
            metrics.MotionDurationMs = clock.Elapsed.TotalMilliseconds - started;
        }

        internal void MovePersistentTo(Point target)
        {
            MoveTo(target, null);
            SettleIdle(null, 80);
        }

        internal void PersistentIdleTick()
        {
            currentState = OscarCursorVisualState.Idle;
            opacity = 1f;
            bodyScale = 1f + 0.006f * (float)Math.Sin(clock.Elapsed.TotalMilliseconds / 620.0);
            rings = 0f;
            trailStrength = 0f;
            headingDegrees = LerpAngle(headingDegrees, 0f, 0.14f);
            directionalStretch = Lerp(directionalStretch, 1f, 0.14f);
            RenderFrame(currentState, currentState, 1f);
        }

        internal void SuppressPersistent(int durationMs)
        {
            float startOpacity = opacity;
            TransitionTo(OscarCursorVisualState.Idle, "persistent-handoff-out", durationMs, null, delegate(float progress)
            {
                opacity = Lerp(startOpacity, 0f, SmoothStep(progress));
                bodyScale = Lerp(bodyScale, 0.985f, SmoothStep(progress));
            });
        }

        internal void ResumePersistentAt(Point target, int durationMs)
        {
            position = target;
            velocity = PointF.Empty;
            history.Clear();
            history.Add(position);
            currentState = OscarCursorVisualState.Idle;
            opacity = 0f;
            bodyScale = 0.985f;
            headingDegrees = 0f;
            headingVelocity = 0f;
            directionalStretch = 1f;
            TransitionTo(OscarCursorVisualState.Idle, "persistent-handoff-in", durationMs, null, delegate(float progress)
            {
                opacity = SmoothStep(progress);
                bodyScale = Lerp(0.985f, 1f, SmoothStep(progress));
            });
        }

        internal void SettleIdle(ControlGuard control, int durationMs)
        {
            float startScale = bodyScale;
            float startHeading = headingDegrees;
            float startStretch = directionalStretch;
            TransitionTo(OscarCursorVisualState.Idle, "idle-persistent", durationMs, control, delegate(float progress)
            {
                float eased = SmoothStep(progress);
                bodyScale = Lerp(startScale, 1f, eased);
                trailStrength = Lerp(trailStrength, 0f, eased);
                rings = Lerp(rings, 0f, eased);
                headingDegrees = LerpAngle(startHeading, 0f, eased);
                directionalStretch = Lerp(startStretch, 1f, eased);
                opacity = 1f;
            });
        }

        internal void Hover(ControlGuard control, int durationMs)
        {
            float startScale = bodyScale;
            float startHeading = headingDegrees;
            float startStretch = directionalStretch;
            TransitionTo(OscarCursorVisualState.Hover, "hover", durationMs, control, delegate(float progress)
            {
                float eased = SmoothStep(progress);
                bodyScale = Lerp(startScale, 1.055f, eased);
                trailStrength = Lerp(trailStrength, 0f, eased);
                headingDegrees = LerpAngle(startHeading, 0f, eased);
                directionalStretch = Lerp(startStretch, 1f, eased);
                rings = 0.04f * (float)Math.Sin(Math.PI * progress);
            });
            headingDegrees = 0f;
            headingVelocity = 0f;
            directionalStretch = 1f;
        }

        internal void PreClickVibration(ControlGuard control, int durationMs)
        {
            metrics.BeginState("pre-click-vibration");
            OscarCursorVisualState fromState = currentState;
            double started = clock.Elapsed.TotalMilliseconds;
            preClickStartedAt = started;
            double nextFrame = started;
            while (true)
            {
                if (control != null) control.Verify();
                double now = clock.Elapsed.TotalMilliseconds;
                float progress = Math.Max(0f, Math.Min(1f, (float)((now - started) / durationMs)));
                float ramp = SmoothStep(progress);
                float amplitude = (0.25f + 3.15f * ramp) * dpiScale;
                vibration = new PointF(
                    amplitude * (float)Math.Sin(Math.PI * 2 * 46 * progress),
                    amplitude * 0.72f * (float)Math.Sin(Math.PI * 2 * 62 * progress));
                rings = ramp;
                bodyScale = 1.055f + 0.018f * (float)Math.Sin(Math.PI * 2 * 6 * progress) * ramp;
                RenderFrame(fromState, OscarCursorVisualState.Pressed, SmoothStep(progress * 0.42f));
                if (progress >= 1f) break;
                nextFrame += FrameIntervalMs;
                WaitUntil(nextFrame);
            }
            vibration = PointF.Empty;
            rings = 1f;
            currentState = OscarCursorVisualState.Pressed;
        }

        internal void MarkMouseDown()
        {
            if (preClickStartedAt >= 0) metrics.PreClickLeadMs = clock.Elapsed.TotalMilliseconds - preClickStartedAt;
        }

        internal void PressDown(ControlGuard control, int durationMs)
        {
            float startScale = bodyScale;
            TransitionTo(OscarCursorVisualState.Pressed, "pressed", durationMs, control, delegate(float progress)
            {
                bodyScale = Lerp(startScale, 0.82f, EaseInOutCubic(progress));
                rings = Lerp(1f, 0.2f, SmoothStep(progress));
            });
        }

        internal void HoldPressedWhile(ControlGuard control, Func<bool> pending)
        {
            HoldWhile(
                control,
                pending,
                OscarCursorVisualState.Pressed,
                "pressed-dispatch",
                delegate(double elapsed)
                {
                    bodyScale = 0.82f + 0.012f * (float)Math.Sin(elapsed / 90.0);
                    rings = 0.16f + 0.035f * (float)Math.Sin(elapsed / 120.0);
                });
        }

        internal void Release(ControlGuard control, int durationMs)
        {
            float startScale = bodyScale;
            TransitionTo(OscarCursorVisualState.Hover, "released", durationMs, control, delegate(float progress)
            {
                float settled = Lerp(startScale, 1f, SmoothStep(progress));
                bodyScale = settled + 0.09f * (float)Math.Sin(Math.PI * progress) * (1f - progress * 0.35f);
                rings = Lerp(rings, 0f, SmoothStep(progress));
            });
        }

        internal void TextPrecision(ControlGuard control, int durationMs)
        {
            float startScale = bodyScale;
            TransitionTo(OscarCursorVisualState.Text, "text-precision", durationMs, control, delegate(float progress)
            {
                bodyScale = Lerp(startScale, 1.02f, SmoothStep(progress));
                trailStrength = Lerp(trailStrength, 0f, SmoothStep(progress));
                rings = 0.06f * (float)Math.Sin(Math.PI * progress);
            });
        }

        internal void Busy(ControlGuard control, int durationMs)
        {
            TransitionTo(OscarCursorVisualState.Busy, "busy", durationMs, control, delegate(float progress)
            {
                bodyScale = 1f + 0.025f * (float)Math.Sin(Math.PI * 2 * progress);
                rings = 0.12f + 0.08f * (float)Math.Sin(Math.PI * 2 * progress);
            });
        }

        internal void HoldBusyWhile(ControlGuard control, Func<bool> pending)
        {
            HoldWhile(
                control,
                pending,
                OscarCursorVisualState.Busy,
                "busy-dispatch",
                delegate(double elapsed)
                {
                    bodyScale = 1f + 0.018f * (float)Math.Sin(elapsed / 105.0);
                    rings = 0.14f + 0.07f * (float)Math.Sin(elapsed / 82.0);
                });
        }

        internal void MotionBurst(ControlGuard control, int durationMs)
        {
            TransitionTo(OscarCursorVisualState.Moving, "motion-burst", durationMs, control, delegate(float progress)
            {
                trailStrength = (float)Math.Sin(Math.PI * progress);
                bodyScale = 1f + 0.06f * (float)Math.Sin(Math.PI * progress);
            });
        }

        internal void FadeOut(ControlGuard control, int durationMs)
        {
            float startOpacity = opacity;
            float startScale = bodyScale;
            TransitionTo(OscarCursorVisualState.Idle, "idle-fade", durationMs, control, delegate(float progress)
            {
                opacity = Lerp(startOpacity, 0f, SmoothStep(progress));
                bodyScale = Lerp(startScale, 0.97f, SmoothStep(progress));
                trailStrength = Lerp(trailStrength, 0f, SmoothStep(progress));
                rings = Lerp(rings, 0f, SmoothStep(progress));
            });
        }

        internal void DisabledAndFade(int durationMs)
        {
            try
            {
                float startScale = bodyScale;
                TransitionTo(OscarCursorVisualState.Disabled, "disabled", Math.Min(120, durationMs / 2), null, delegate(float progress)
                {
                    bodyScale = Lerp(startScale, 0.94f, SmoothStep(progress));
                    rings = Lerp(rings, 0f, SmoothStep(progress));
                    vibration = PointF.Empty;
                });
                float startOpacity = opacity;
                TransitionTo(OscarCursorVisualState.Disabled, "disabled-fade", Math.Max(80, durationMs / 2), null, delegate(float progress)
                {
                    opacity = Lerp(startOpacity, 0f, SmoothStep(progress));
                });
            }
            catch
            {
                // Visual teardown must never mask the authority revocation.
            }
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                if (frameGraphics != null) frameGraphics.Dispose();
                if (frameCanvas != null) frameCanvas.Dispose();
                if (energyRingPens != null)
                {
                    foreach (Pen pen in energyRingPens) pen.Dispose();
                }
                frameImageAttributes.Dispose();
                if (memoryDc != IntPtr.Zero && previousBitmap != IntPtr.Zero)
                {
                    NativeMethods.SelectObject(memoryDc, previousBitmap);
                }
                if (dibHandle != IntPtr.Zero) NativeMethods.DeleteObject(dibHandle);
                if (memoryDc != IntPtr.Zero) NativeMethods.DeleteDC(memoryDc);
                if (screenDc != IntPtr.Zero) NativeMethods.ReleaseDC(IntPtr.Zero, screenDc);
                if (timerResolutionRaised) NativeMethods.timeEndPeriod(1);
                try { Thread.CurrentThread.Priority = previousThreadPriority; }
                catch { }
                assets.Dispose();
            }
            base.Dispose(disposing);
        }

        private void Appear(ControlGuard control)
        {
            metrics.BeginState("idle-appear");
            opacity = 0f;
            double started = clock.Elapsed.TotalMilliseconds;
            double nextFrame = started;
            while (true)
            {
                if (control != null) control.Verify();
                float progress = Math.Max(0f, Math.Min(1f, (float)((clock.Elapsed.TotalMilliseconds - started) / 180.0)));
                opacity = SmoothStep(progress);
                bodyScale = Lerp(0.94f, 1f, SmoothStep(progress));
                RenderFrame(OscarCursorVisualState.Idle, OscarCursorVisualState.Idle, 1f);
                if (progress >= 1f) break;
                nextFrame += FrameIntervalMs;
                WaitUntil(nextFrame);
            }
        }

        private void TransitionTo(
            OscarCursorVisualState targetState,
            string stateName,
            int durationMs,
            ControlGuard control,
            Action<float> update)
        {
            metrics.BeginState(stateName);
            OscarCursorVisualState sourceState = currentState;
            double started = clock.Elapsed.TotalMilliseconds;
            double nextFrame = started;
            while (true)
            {
                if (control != null) control.Verify();
                float progress = Math.Max(0f, Math.Min(1f, (float)((clock.Elapsed.TotalMilliseconds - started) / Math.Max(1, durationMs))));
                update(progress);
                RenderFrame(sourceState, targetState, SmoothStep(progress));
                if (progress >= 1f) break;
                nextFrame += FrameIntervalMs;
                WaitUntil(nextFrame);
            }
            currentState = targetState;
        }

        private void RenderFrame(OscarCursorVisualState fromState, OscarCursorVisualState toState, float blend)
        {
            Graphics graphics = frameGraphics;
            graphics.Clear(Color.Transparent);
            PointF visualPoint = new PointF(anchor.X + vibration.X, anchor.Y + vibration.Y);
            DrawTrails(graphics, visualPoint);
            DrawEnergyRings(graphics, visualPoint);
            float directionalSquash = 1f - (directionalStretch - 1f) * 0.36f;
            if (fromState == toState)
            {
                DrawSprite(graphics, assets.Get(toState), visualPoint, bodyScale, opacity, headingDegrees, directionalStretch, directionalSquash);
            }
            else
            {
                DrawSprite(graphics, assets.Get(fromState), visualPoint, bodyScale, opacity * (1f - blend), headingDegrees, directionalStretch, directionalSquash);
                DrawSprite(graphics, assets.Get(toState), visualPoint, bodyScale, opacity * blend, headingDegrees, directionalStretch, directionalSquash);
            }
            UpdateLayered(new Point(
                (int)Math.Round(position.X - anchor.X),
                (int)Math.Round(position.Y - anchor.Y)));
            metrics.RecordFrame(clock.Elapsed.TotalMilliseconds);
            Application.DoEvents();
        }

        private void DrawTrails(Graphics graphics, PointF visualPoint)
        {
            if (trailStrength <= 0.01f || history.Count < 2) return;
            int samples = Math.Min(7, history.Count - 1);
            for (int index = samples; index >= 1; index--)
            {
                PointF historical = history[history.Count - 1 - index];
                int historyIndex = history.Count - 1 - index;
                PointF next = history[Math.Min(history.Count - 1, historyIndex + 1)];
                PointF local = new PointF(
                    visualPoint.X + historical.X - position.X,
                    visualPoint.Y + historical.Y - position.Y);
                float recency = 1f - index / (samples + 1f);
                float historicalHeading = HeadingForVector(next.X - historical.X, next.Y - historical.Y, headingDegrees);
                DrawSprite(
                    graphics,
                    assets.Get(OscarCursorVisualState.Moving),
                    local,
                    bodyScale * (0.93f + recency * 0.05f),
                    opacity * trailStrength * recency * 0.16f,
                    historicalHeading,
                    1f + (directionalStretch - 1f) * recency,
                    1f - (directionalStretch - 1f) * recency * 0.32f);
            }
        }

        private void DrawEnergyRings(Graphics graphics, PointF visualPoint)
        {
            if (rings <= 0.005f) return;
            OscarCursorSprite sprite = assets.Get(currentState);
            float bodyWidth = cursorBodyWidth * bodyScale;
            float ratio = bodyWidth / Math.Max(1f, sprite.BodyBounds.Width);
            PointF centerOffset = new PointF(
                (sprite.BodyBounds.Left + sprite.BodyBounds.Width * 0.5f - sprite.Hotspot.X) * ratio,
                (sprite.BodyBounds.Top + sprite.BodyBounds.Height * 0.5f - sprite.Hotspot.Y) * ratio);
            PointF rotatedOffset = Rotate(centerOffset, headingDegrees);
            PointF center = new PointF(visualPoint.X + rotatedOffset.X, visualPoint.Y + rotatedOffset.Y);
            for (int index = 0; index < 3; index++)
            {
                float phase = Math.Max(0f, Math.Min(1f, rings - index * 0.14f));
                float radius = Math.Min(
                    cursorBodyWidth * 0.70f,
                    cursorBodyWidth * (0.48f + index * 0.17f + phase * 0.1f));
                int alpha = (int)Math.Round(opacity * phase * (74 - index * 14));
                Pen pen = energyRingPens[index];
                pen.Color = Color.FromArgb(Math.Max(0, Math.Min(255, alpha)), 255, 132, 0);
                graphics.DrawEllipse(pen, center.X - radius, center.Y - radius, radius * 2, radius * 2);
            }
        }

        private void DrawSprite(
            Graphics graphics,
            OscarCursorSprite sprite,
            PointF point,
            float scale,
            float alpha,
            float rotation,
            float stretchX,
            float stretchY)
        {
            if (alpha <= 0.001f) return;
            float bodyWidth = cursorBodyWidth * scale;
            float unitScale = bodyWidth / Math.Max(1f, sprite.BodyBounds.Width);
            float width = sprite.Bitmap.Width * unitScale * stretchX;
            float height = sprite.Bitmap.Height * unitScale * stretchY;
            // Keep the complete visible cursor footprint within 1.5x of the
            // Windows system cursor in every movement direction. Bounding the
            // image diagonal also covers the largest possible rotated AABB.
            float maximumVisibleExtent = cursorBodyWidth * 1.5f;
            float rotatedExtent = (float)Math.Sqrt(width * width + height * height);
            if (rotatedExtent > maximumVisibleExtent)
            {
                float limit = maximumVisibleExtent / rotatedExtent;
                width *= limit;
                height *= limit;
            }
            float ratioX = width / sprite.Bitmap.Width;
            float ratioY = height / sprite.Bitmap.Height;
            RectangleF destination = new RectangleF(
                point.X - sprite.Hotspot.X * ratioX,
                point.Y - sprite.Hotspot.Y * ratioY,
                width,
                height);
            GraphicsState saved = graphics.Save();
            if (Math.Abs(rotation) > 0.01f)
            {
                graphics.TranslateTransform(point.X, point.Y);
                graphics.RotateTransform(rotation);
                graphics.TranslateTransform(-point.X, -point.Y);
            }
            if (alpha >= 0.999f)
            {
                graphics.DrawImage(
                    sprite.Bitmap,
                    Rectangle.Round(destination),
                    0,
                    0,
                    sprite.Bitmap.Width,
                    sprite.Bitmap.Height,
                    GraphicsUnit.Pixel);
            }
            else
            {
                frameColorMatrix.Matrix33 = Math.Max(0f, Math.Min(1f, alpha));
                frameImageAttributes.SetColorMatrix(frameColorMatrix, ColorMatrixFlag.Default, ColorAdjustType.Bitmap);
                graphics.DrawImage(
                    sprite.Bitmap,
                    Rectangle.Round(destination),
                    0,
                    0,
                    sprite.Bitmap.Width,
                    sprite.Bitmap.Height,
                    GraphicsUnit.Pixel,
                    frameImageAttributes);
            }
            graphics.Restore(saved);
        }

        private static void DrawShowcaseState(
            Graphics graphics,
            OscarCursorSprite sprite,
            PointF hotspot,
            float width,
            float alpha,
            float rotation = 0f,
            float stretchX = 1f,
            float stretchY = 1f)
        {
            float unitScale = width / Math.Max(1f, sprite.BodyBounds.Width);
            float renderedWidth = sprite.Bitmap.Width * unitScale * stretchX;
            float renderedHeight = sprite.Bitmap.Height * unitScale * stretchY;
            float ratioX = renderedWidth / sprite.Bitmap.Width;
            float ratioY = renderedHeight / sprite.Bitmap.Height;
            Rectangle destination = Rectangle.Round(new RectangleF(
                hotspot.X - sprite.Hotspot.X * ratioX,
                hotspot.Y - sprite.Hotspot.Y * ratioY,
                renderedWidth,
                renderedHeight));
            GraphicsState saved = graphics.Save();
            if (Math.Abs(rotation) > 0.01f)
            {
                graphics.TranslateTransform(hotspot.X, hotspot.Y);
                graphics.RotateTransform(rotation);
                graphics.TranslateTransform(-hotspot.X, -hotspot.Y);
            }
            using (ImageAttributes attributes = new ImageAttributes())
            {
                ColorMatrix matrix = new ColorMatrix();
                matrix.Matrix33 = alpha;
                attributes.SetColorMatrix(matrix, ColorMatrixFlag.Default, ColorAdjustType.Bitmap);
                graphics.DrawImage(
                    sprite.Bitmap,
                    destination,
                    0,
                    0,
                    sprite.Bitmap.Width,
                    sprite.Bitmap.Height,
                    GraphicsUnit.Pixel,
                    attributes);
            }
            graphics.Restore(saved);
        }

        private void InitializeFrameSurface()
        {
            screenDc = NativeMethods.GetDC(IntPtr.Zero);
            memoryDc = NativeMethods.CreateCompatibleDC(screenDc);
            if (screenDc == IntPtr.Zero || memoryDc == IntPtr.Zero)
            {
                throw new NativeFailure("cursor-surface-create-failed", "Windows could not create the Oscar cursor animation surface.");
            }
            NativeMethods.BitmapInfo bitmapInfo = new NativeMethods.BitmapInfo
            {
                Header = new NativeMethods.BitmapInfoHeader
                {
                    Size = (uint)Marshal.SizeOf(typeof(NativeMethods.BitmapInfoHeader)),
                    Width = canvasWidth,
                    Height = -canvasHeight,
                    Planes = 1,
                    BitCount = 32,
                    Compression = NativeMethods.BitmapCompressionRgb,
                    SizeImage = (uint)(canvasWidth * canvasHeight * 4)
                }
            };
            IntPtr bits;
            dibHandle = NativeMethods.CreateDIBSection(
                memoryDc,
                ref bitmapInfo,
                NativeMethods.DibRgbColors,
                out bits,
                IntPtr.Zero,
                0);
            if (dibHandle == IntPtr.Zero || bits == IntPtr.Zero)
            {
                throw new NativeFailure("cursor-surface-create-failed", "Windows could not allocate the Oscar cursor animation surface.");
            }
            previousBitmap = NativeMethods.SelectObject(memoryDc, dibHandle);
            frameCanvas = new Bitmap(canvasWidth, canvasHeight, canvasWidth * 4, PixelFormat.Format32bppPArgb, bits);
            frameGraphics = Graphics.FromImage(frameCanvas);
            frameGraphics.SmoothingMode = SmoothingMode.AntiAlias;
            frameGraphics.InterpolationMode = InterpolationMode.HighQualityBilinear;
            frameGraphics.PixelOffsetMode = PixelOffsetMode.Half;
            frameGraphics.CompositingQuality = CompositingQuality.HighSpeed;
            energyRingPens = new[]
            {
                new Pen(Color.Transparent, Math.Max(1f, 1.1f * dpiScale)),
                new Pen(Color.Transparent, Math.Max(1f, 1.1f * dpiScale)),
                new Pen(Color.Transparent, Math.Max(1f, 1.1f * dpiScale))
            };
        }

        private void UpdateLayered(Point topLeft)
        {
            NativeMethods.NativeSize size = new NativeMethods.NativeSize { Width = canvasWidth, Height = canvasHeight };
            NativeMethods.NativePoint source = new NativeMethods.NativePoint { X = 0, Y = 0 };
            NativeMethods.NativePoint destination = new NativeMethods.NativePoint { X = topLeft.X, Y = topLeft.Y };
            NativeMethods.BlendFunction blend = new NativeMethods.BlendFunction
            {
                BlendOp = 0,
                BlendFlags = 0,
                SourceConstantAlpha = 255,
                AlphaFormat = 1
            };
            if (!NativeMethods.UpdateLayeredWindow(
                Handle,
                screenDc,
                ref destination,
                ref size,
                memoryDc,
                ref source,
                0,
                ref blend,
                2))
            {
                throw new NativeFailure("cursor-layer-update-failed", "Windows rejected the Oscar cursor animation frame.");
            }
        }

        private void PushHistory(PointF value)
        {
            history.Add(value);
            while (history.Count > 12) history.RemoveAt(0);
        }

        private void UpdateDirectionalPhysics(double deltaSeconds, float speed)
        {
            if (speed <= 0.5f) return;
            float targetHeading = HeadingForVector(velocity.X, velocity.Y, headingDegrees);
            float error = ShortestAngle(headingDegrees, targetHeading);
            const float angularStiffness = 58f;
            const float angularDamping = 15.23f;
            headingVelocity += (error * angularStiffness - headingVelocity * angularDamping) * (float)deltaSeconds;
            headingDegrees = NormalizeAngle(headingDegrees + headingVelocity * (float)deltaSeconds);
            metrics.RecordDirection(headingDegrees);
        }

        private void WaitUntil(double targetMs)
        {
            while (true)
            {
                double remaining = targetMs - clock.Elapsed.TotalMilliseconds;
                if (remaining <= 0) return;
                Application.DoEvents();
                if (remaining > 3) Thread.Sleep(1);
                else Thread.SpinWait(192);
            }
        }

        private void HoldWhile(
            ControlGuard control,
            Func<bool> pending,
            OscarCursorVisualState state,
            string metricState,
            Action<double> update)
        {
            metrics.BeginState(metricState);
            currentState = state;
            double started = clock.Elapsed.TotalMilliseconds;
            double nextFrame = started;
            while (pending())
            {
                if (control != null) control.Verify();
                double elapsed = clock.Elapsed.TotalMilliseconds - started;
                update(elapsed);
                RenderFrame(state, state, 1f);
                nextFrame += FrameIntervalMs;
                WaitUntil(nextFrame);
            }
            if (control != null) control.Verify();
        }

        private static double Distance(PointF left, PointF right)
        {
            double x = left.X - right.X;
            double y = left.Y - right.Y;
            return Math.Sqrt(x * x + y * y);
        }

        private static float SmoothStep(float value)
        {
            value = Math.Max(0f, Math.Min(1f, value));
            return value * value * (3f - 2f * value);
        }

        private static float EaseInOutCubic(float value)
        {
            value = Math.Max(0f, Math.Min(1f, value));
            return value < 0.5f
                ? 4f * value * value * value
                : 1f - (float)Math.Pow(-2f * value + 2f, 3) / 2f;
        }

        private static float Lerp(float from, float to, float progress)
        {
            return from + (to - from) * progress;
        }

        private static float LerpAngle(float from, float to, float progress)
        {
            return NormalizeAngle(from + ShortestAngle(from, to) * progress);
        }

        private static float HeadingForVector(float x, float y, float fallback)
        {
            if (Math.Abs(x) + Math.Abs(y) < 0.001f) return fallback;
            return NormalizeAngle((float)(Math.Atan2(y, x) * 180.0 / Math.PI));
        }

        private static float ShortestAngle(float from, float to)
        {
            float delta = NormalizeAngle(to) - NormalizeAngle(from);
            if (delta > 180f) delta -= 360f;
            if (delta < -180f) delta += 360f;
            return delta;
        }

        private static float NormalizeAngle(float value)
        {
            value %= 360f;
            return value < 0 ? value + 360f : value;
        }

        private static PointF Rotate(PointF value, float degrees)
        {
            double radians = degrees * Math.PI / 180.0;
            double cosine = Math.Cos(radians);
            double sine = Math.Sin(radians);
            return new PointF(
                (float)(value.X * cosine - value.Y * sine),
                (float)(value.X * sine + value.Y * cosine));
        }
    }
}
