using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Automation;
using System.Windows.Forms;

namespace MonarchComputerUse
{
    internal sealed class NativeFailure : Exception
    {
        internal readonly string Code;

        internal NativeFailure(string code, string message) : base(message)
        {
            Code = code;
        }
    }

    internal static class SharedFile
    {
        internal static string ReadUtf8Text(string path)
        {
            using (FileStream stream = new FileStream(
                path,
                FileMode.Open,
                FileAccess.Read,
                FileShare.ReadWrite | FileShare.Delete))
            using (StreamReader reader = new StreamReader(stream, Encoding.UTF8, true))
            {
                return reader.ReadToEnd();
            }
        }
    }

    internal sealed class ElementSnapshot
    {
        internal AutomationElement Element;
        internal string ElementId;
        internal string Name;
        internal string Value;
        internal string AutomationId;
        internal string ClassName;
        internal string ControlType;
        internal Rectangle Bounds;
        internal bool Enabled;
        internal bool Offscreen;
        internal bool Focusable;
        internal bool Focused;
        internal bool Password;
        internal List<string> Patterns;

        internal Dictionary<string, object> ToDictionary()
        {
            return new Dictionary<string, object>
            {
                { "elementId", ElementId },
                { "name", Name },
                { "value", Value },
                { "automationId", AutomationId },
                { "className", ClassName },
                { "controlType", ControlType },
                { "bounds", NativeMethods.BoundsDictionary(Bounds) },
                { "enabled", Enabled },
                { "offscreen", Offscreen },
                { "focusable", Focusable },
                { "focused", Focused },
                { "password", Password },
                { "patterns", Patterns }
            };
        }

        internal string FingerprintLine()
        {
            return string.Join("|", new[]
            {
                ElementId,
                AutomationId,
                ClassName,
                ControlType,
                Name,
                Value,
                Bounds.X.ToString(CultureInfo.InvariantCulture),
                Bounds.Y.ToString(CultureInfo.InvariantCulture),
                Bounds.Width.ToString(CultureInfo.InvariantCulture),
                Bounds.Height.ToString(CultureInfo.InvariantCulture),
                Enabled ? "1" : "0",
                Offscreen ? "1" : "0",
                Password ? "1" : "0",
                string.Join(",", Patterns.ToArray())
            });
        }
    }

    internal sealed class AutomationSnapshot
    {
        internal readonly List<ElementSnapshot> Elements = new List<ElementSnapshot>();
        internal string StateFingerprint;
        internal string FocusedElementId;
        internal bool Truncated;
    }

    internal sealed class ScreenshotSnapshot
    {
        internal string Path;
        internal string Sha256;
        internal string PerceptualHash;
        internal int Width;
        internal int Height;
        internal string CaptureMethod;
        internal bool OcclusionSafe;

        internal Dictionary<string, object> ToDictionary()
        {
            return new Dictionary<string, object>
            {
                { "path", Path },
                { "sha256", Sha256 },
                { "perceptualHash", PerceptualHash },
                { "width", Width },
                { "height", Height },
                { "captureMethod", CaptureMethod },
                { "occlusionSafe", OcclusionSafe }
            };
        }
    }

    internal sealed class ControlGuard
    {
        internal readonly string StatePath;
        internal readonly string CursorVisualLeasePath;
        internal readonly string CursorTakeoverSignalPath;
        internal readonly int Epoch;
        internal readonly string InputLeaseId;

        internal ControlGuard(
            string statePath,
            string cursorVisualLeasePath,
            string cursorTakeoverSignalPath,
            int epoch,
            string inputLeaseId)
        {
            StatePath = statePath;
            CursorVisualLeasePath = cursorVisualLeasePath;
            CursorTakeoverSignalPath = cursorTakeoverSignalPath;
            Epoch = epoch;
            InputLeaseId = inputLeaseId;
        }

        internal void Verify()
        {
            if (File.Exists(CursorTakeoverSignalPath))
            {
                throw new NativeFailure("user-cursor-takeover", "The local desktop signaled immediate user takeover of Computer Use.");
            }
            if (!File.Exists(StatePath))
            {
                throw new NativeFailure("computer-control-revoked", "Computer Use control state is unavailable.");
            }
            try
            {
                JavaScriptSerializer serializer = new JavaScriptSerializer();
                Dictionary<string, object> state = serializer.Deserialize<Dictionary<string, object>>(SharedFile.ReadUtf8Text(StatePath));
                object enabledValue;
                object epochValue;
                object activeLeaseValue;
                bool enabled = state.TryGetValue("enabled", out enabledValue) && Convert.ToBoolean(enabledValue, CultureInfo.InvariantCulture);
                int epoch = state.TryGetValue("controlEpoch", out epochValue)
                    ? Convert.ToInt32(epochValue, CultureInfo.InvariantCulture)
                    : -1;
                string activeLease = state.TryGetValue("activeLeaseId", out activeLeaseValue)
                    ? Convert.ToString(activeLeaseValue, CultureInfo.InvariantCulture)
                    : "";
                if (!enabled || epoch != Epoch || !String.Equals(activeLease, InputLeaseId, StringComparison.Ordinal))
                {
                    throw new NativeFailure("computer-control-revoked", "Computer Use was stopped or its control epoch changed.");
                }
            }
            catch (NativeFailure)
            {
                throw;
            }
            catch
            {
                throw new NativeFailure("computer-control-revoked", "Computer Use control state could not be verified.");
            }
        }
    }

    internal sealed class CursorVisualLease : IDisposable
    {
        private readonly string path;
        private readonly string leaseId;

        private CursorVisualLease(string path, string leaseId)
        {
            this.path = path;
            this.leaseId = leaseId;
        }

        internal static CursorVisualLease Acquire(ControlGuard control, Point target)
        {
            control.Verify();
            string parent = Path.GetDirectoryName(control.CursorVisualLeasePath);
            if (!String.IsNullOrWhiteSpace(parent)) Directory.CreateDirectory(parent);
            JavaScriptSerializer serializer = new JavaScriptSerializer();
            string payload = serializer.Serialize(new Dictionary<string, object>
            {
                { "schemaVersion", 1 },
                { "leaseId", control.InputLeaseId },
                { "processId", Process.GetCurrentProcess().Id },
                { "targetX", target.X },
                { "targetY", target.Y },
                { "startedAt", DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture) }
            });
            string temporary = control.CursorVisualLeasePath + ".tmp-" + Guid.NewGuid().ToString("N");
            File.WriteAllText(temporary, payload, new UTF8Encoding(false));
            if (File.Exists(control.CursorVisualLeasePath)) File.Delete(control.CursorVisualLeasePath);
            File.Move(temporary, control.CursorVisualLeasePath);
            return new CursorVisualLease(control.CursorVisualLeasePath, control.InputLeaseId);
        }

        public void Dispose()
        {
            try
            {
                if (!File.Exists(path)) return;
                JavaScriptSerializer serializer = new JavaScriptSerializer();
                Dictionary<string, object> current = serializer.Deserialize<Dictionary<string, object>>(SharedFile.ReadUtf8Text(path));
                object value;
                string currentLease = current.TryGetValue("leaseId", out value)
                    ? Convert.ToString(value, CultureInfo.InvariantCulture)
                    : "";
                if (String.Equals(currentLease, leaseId, StringComparison.Ordinal)) File.Delete(path);
            }
            catch
            {
                // The control epoch still revokes input if visual cleanup races.
            }
        }
    }

    internal sealed class CursorTakeoverMonitor : IDisposable
    {
        private readonly NativeMethods.NativePoint baseline;
        private readonly int tolerance;
        private readonly Thread worker;
        private volatile bool stopped;
        private volatile bool detected;

        internal CursorTakeoverMonitor(NativeMethods.NativePoint baseline, bool enabled, int tolerance)
        {
            this.baseline = baseline;
            this.tolerance = tolerance;
            if (!enabled) return;
            worker = new Thread(Run);
            worker.IsBackground = true;
            worker.Name = "Monarch Computer Use cursor takeover monitor";
            worker.Start();
        }

        internal bool Detected { get { return detected; } }

        private void Run()
        {
            while (!stopped)
            {
                NativeMethods.NativePoint current;
                if (NativeMethods.GetCursorPos(out current)
                    && (Math.Abs(current.X - baseline.X) > tolerance
                        || Math.Abs(current.Y - baseline.Y) > tolerance))
                {
                    detected = true;
                    return;
                }
                Thread.Sleep(10);
            }
        }

        public void Dispose()
        {
            stopped = true;
            if (worker != null && worker.IsAlive) worker.Join(100);
        }
    }

    internal sealed class NativeActionWorker
    {
        private readonly ManualResetEvent completed = new ManualResetEvent(false);
        private Exception failure;

        private NativeActionWorker(Action action)
        {
            Thread thread = new Thread(delegate()
            {
                try
                {
                    action();
                }
                catch (Exception error)
                {
                    failure = error;
                }
                finally
                {
                    completed.Set();
                }
            });
            thread.IsBackground = true;
            thread.Name = "Monarch exact semantic dispatch";
            thread.SetApartmentState(ApartmentState.MTA);
            thread.Start();
        }

        internal static NativeActionWorker Start(Action action)
        {
            if (action == null) throw new ArgumentNullException("action");
            return new NativeActionWorker(action);
        }

        internal bool IsCompleted
        {
            get { return completed.WaitOne(0); }
        }

        internal void ThrowIfFailed()
        {
            completed.WaitOne();
            if (failure != null) throw failure;
        }
    }

    internal static class Program
    {
        private const int MaxRequestBytes = 1024 * 1024;

        [STAThread]
        private static int Main(string[] args)
        {
            if (args.Length != 2)
            {
                Console.Error.WriteLine("Usage: monarch-computer-use <request.json> <result.json>");
                return 2;
            }

            string resultPath = Path.GetFullPath(args[1]);
            try
            {
                string requestPath = Path.GetFullPath(args[0]);
                FileInfo requestInfo = new FileInfo(requestPath);
                if (!requestInfo.Exists || requestInfo.Length <= 0 || requestInfo.Length > MaxRequestBytes)
                {
                    throw new NativeFailure("request-invalid", "Computer Use request file is missing or oversized.");
                }
                JavaScriptSerializer serializer = new JavaScriptSerializer();
                serializer.MaxJsonLength = 8 * 1024 * 1024;
                Dictionary<string, object> request = serializer.Deserialize<Dictionary<string, object>>(File.ReadAllText(requestPath, Encoding.UTF8));
                object result = Execute(request);
                WriteResult(resultPath, serializer.Serialize(new Dictionary<string, object>
                {
                    { "ok", true },
                    { "result", result }
                }));
                return 0;
            }
            catch (NativeFailure failure)
            {
                WriteFailure(resultPath, failure.Code, failure.Message);
                return 3;
            }
            catch (Exception error)
            {
                WriteFailure(resultPath, "native-provider-failed", SafeMessage(error));
                return 4;
            }
        }

        private static object Execute(Dictionary<string, object> request)
        {
            string command = RequiredString(request, "command", 80);
            if (command == "list-windows")
            {
                return ListWindows(ReadInteger(request, "limit", 40, 1, 100));
            }
            if (command == "observe")
            {
                IntPtr window = ResolveWindow(RequiredString(request, "windowRef", 80));
                string screenshotPath = RequiredAbsolutePath(request, "screenshotPath");
                return Observe(window, screenshotPath);
            }
            if (command == "act")
            {
                return Act(request);
            }
            if (command == "render-cursor-showcase")
            {
                string outputPath = RequiredAbsolutePath(request, "outputPath");
                return OscarCursorOverlay.RenderShowcase(outputPath);
            }
            if (command == "render-cursor-directions")
            {
                string outputPath = RequiredAbsolutePath(request, "outputPath");
                return OscarCursorOverlay.RenderDirectionShowcase(outputPath);
            }
            if (command == "cursor-host")
            {
                return OscarPersistentCursorHost.Run(
                    RequiredAbsolutePath(request, "controlStatePath"),
                    RequiredAbsolutePath(request, "cursorVisualLeasePath"),
                    RequiredAbsolutePath(request, "readyPath"),
                    RequiredAbsolutePath(request, "stopPath"),
                    ReadInteger(request, "ownerProcessId", 0, 1, Int32.MaxValue),
                    RequiredAbsolutePath(request, "ownerHeartbeatPath"));
            }
            throw new NativeFailure("command-unsupported", "Unsupported Computer Use command.");
        }

        private static List<Dictionary<string, object>> ListWindows(int limit)
        {
            List<Dictionary<string, object>> windows = new List<Dictionary<string, object>>();
            NativeMethods.EnumWindows(delegate(IntPtr handle, IntPtr parameter)
            {
                if (windows.Count >= limit) return false;
                Dictionary<string, object> summary;
                if (TryReadWindow(handle, out summary)) windows.Add(summary);
                return true;
            }, IntPtr.Zero);
            return windows;
        }

        private static Dictionary<string, object> Observe(IntPtr window, string screenshotPath)
        {
            Dictionary<string, object> summary = RequireWindow(window);
            Rectangle bounds = WindowBounds(window);
            AutomationSnapshot automation = ReadAutomation(window, bounds);
            ScreenshotSnapshot screenshot = CaptureWindow(window, bounds, screenshotPath);
            return ObservationDictionary(summary, automation, screenshot);
        }

        private static Dictionary<string, object> Act(Dictionary<string, object> request)
        {
            string windowRef = RequiredString(request, "windowRef", 80);
            ControlGuard control = new ControlGuard(
                RequiredAbsolutePath(request, "controlStatePath"),
                RequiredAbsolutePath(request, "cursorVisualLeasePath"),
                RequiredAbsolutePath(request, "cursorTakeoverSignalPath"),
                ReadInteger(request, "controlEpoch", -1, 1, Int32.MaxValue),
                RequiredString(request, "inputLeaseId", 200));
            control.Verify();
            IntPtr window = ResolveWindow(windowRef);
            Dictionary<string, object> current = RequireWindow(window);
            int expectedProcessId = ReadInteger(request, "expectedProcessId", -1, 1, Int32.MaxValue);
            string expectedTitle = RequiredString(request, "expectedTitle", 4096);
            Rectangle expectedBounds = ReadBounds(RequiredRecord(request, "expectedBounds"));
            Rectangle currentBounds = WindowBounds(window);
            if (Convert.ToInt32(current["processId"], CultureInfo.InvariantCulture) != expectedProcessId
                || !String.Equals(Convert.ToString(current["title"], CultureInfo.InvariantCulture), expectedTitle, StringComparison.Ordinal)
                || !SameBounds(expectedBounds, currentBounds))
            {
                throw new NativeFailure("observation-stale-window", "The exact window identity, title, or bounds changed after observation.");
            }

            AutomationSnapshot automation = ReadAutomation(window, currentBounds);
            string expectedState = RequiredString(request, "expectedStateFingerprint", 256);
            if (!FixedEquals(expectedState, automation.StateFingerprint))
            {
                throw new NativeFailure("observation-stale-uia", "The semantic window state changed after observation.");
            }

            Dictionary<string, object> action = RequiredRecord(request, "action");
            string kind = RequiredString(action, "kind", 40);
            string afterPath = RequiredAbsolutePath(request, "afterScreenshotPath");
            string preflightPath = afterPath + ".preflight.png";
            ScreenshotSnapshot preflight = null;
            try
            {
                preflight = CaptureWindow(window, currentBounds, preflightPath);
                string expectedPerceptual = RequiredString(request, "expectedPerceptualHash", 32);
                if (PerceptualDistance(expectedPerceptual, preflight.PerceptualHash) > 10)
                {
                    throw new NativeFailure("observation-stale-visual", "The visual window state changed materially after observation.");
                }
            }
            finally
            {
                TryDelete(preflightPath);
            }

            control.Verify();
            NativeMethods.NativePoint actionCursorBaseline = new NativeMethods.NativePoint();
            bool actionCursorBaselineKnown = kind == "type"
                && NativeMethods.GetCursorPos(out actionCursorBaseline);
            bool semanticDispatch = false;
            if (!ActivateExactWindow(window))
            {
                semanticDispatch = CanUseExactSemanticDispatch(action, kind, automation);
                if (!semanticDispatch)
                {
                    throw new NativeFailure("window-focus-rejected", "Windows did not grant foreground focus to the exact target window and this action has no exact semantic fallback.");
                }
                PrepareExactWindowForSemanticDispatch(window);
            }
            if (actionCursorBaselineKnown && SystemCursorMovedByUser(actionCursorBaseline, 8))
            {
                throw new NativeFailure("user-cursor-takeover", "The user moved the system cursor while Oscar was acquiring the exact target window; the action was cancelled.");
            }

            Dictionary<string, object> cursorOriginRecord = RequiredRecord(request, "cursorOrigin");
            Point cursorOrigin = new Point(
                ReadInteger(cursorOriginRecord, "x", 0, -100000, 100000),
                ReadInteger(cursorOriginRecord, "y", 0, -100000, 100000));

            Dictionary<string, object> cursor = null;
            if (kind == "click")
            {
                cursor = DispatchClick(window, currentBounds, action, automation, control, cursorOrigin, semanticDispatch);
            }
            else if (kind == "close")
            {
                cursor = DispatchClose(window, control, cursorOrigin);
            }
            else if (kind == "type")
            {
                cursor = DispatchType(window, currentBounds, action, automation, control, cursorOrigin, semanticDispatch);
            }
            else if (kind == "key")
            {
                cursor = DispatchKey(window, currentBounds, action, automation, control, cursorOrigin, semanticDispatch);
            }
            else if (kind == "scroll")
            {
                cursor = DispatchScroll(window, currentBounds, action, automation, control, cursorOrigin);
            }
            else
            {
                throw new NativeFailure("action-unsupported", "Unsupported Computer Use action kind.");
            }

            string dispatchedAt = DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture);
            if (kind == "close")
            {
                bool closed = WaitForWindowClosed(window, control, 2500);
                if (!closed)
                {
                    throw new NativeFailure("window-close-not-verified", "Windows accepted the exact close request, but the observed top-level window remained visible.");
                }
                bool closeForegroundVerified = cursor != null
                    && ReadBoolean(cursor, "foregroundVerifiedAtDispatch", false);
                bool closeTargetVerified = cursor != null
                    && ReadBoolean(cursor, "exactTargetVerifiedAtDispatch", false);
                Dictionary<string, object> closeReceipt = new Dictionary<string, object>
                {
                    { "dispatchedAt", dispatchedAt },
                    { "actionKind", kind },
                    { "foregroundVerified", closeForegroundVerified },
                    { "exactTargetVerified", closeTargetVerified },
                    { "dispatchMode", "windows-message" },
                    { "inputLeaseId", control.InputLeaseId },
                    { "controlEpoch", control.Epoch },
                    { "closed", true },
                    { "closedWindowRef", windowRef }
                };
                if (cursor != null) closeReceipt["cursor"] = cursor;
                return closeReceipt;
            }
            Thread.Sleep(kind == "type" ? 350 : 250);
            Dictionary<string, object> after = Observe(window, afterPath);
            bool foregroundVerifiedAtDispatch = cursor != null
                && ReadBoolean(cursor, "foregroundVerifiedAtDispatch", false);
            bool exactTargetVerifiedAtDispatch = cursor != null
                && ReadBoolean(cursor, "exactTargetVerifiedAtDispatch", false);
            string dispatchMode = cursor == null
                ? "none"
                : OptionalString(cursor, "dispatchMode", "windows-input", 40);
            Dictionary<string, object> receipt = new Dictionary<string, object>
            {
                { "dispatchedAt", dispatchedAt },
                { "actionKind", kind },
                { "foregroundVerified", foregroundVerifiedAtDispatch },
                { "exactTargetVerified", exactTargetVerifiedAtDispatch },
                { "dispatchMode", dispatchMode },
                { "foregroundRetainedAfterObservation", IsExactWindowForeground(window) },
                { "inputLeaseId", control.InputLeaseId },
                { "controlEpoch", control.Epoch },
                { "after", after }
            };
            if (cursor != null) receipt["cursor"] = cursor;
            return receipt;
        }

        private static Dictionary<string, object> DispatchClose(
            IntPtr window,
            ControlGuard control,
            Point cursorOrigin)
        {
            Rectangle bounds = WindowBounds(window);
            int closeWidth = Math.Max(24, NativeMethods.GetSystemMetrics(NativeMethods.SystemMetricCaptionButtonWidth));
            int captionHeight = Math.Max(24, NativeMethods.GetSystemMetrics(NativeMethods.SystemMetricCaptionHeight));
            Point point = new Point(
                Math.Max(bounds.Left, bounds.Right - closeWidth / 2),
                Math.Min(bounds.Bottom - 1, bounds.Top + captionHeight / 2));
            NativeMethods.NativePoint original;
            bool originalKnown = NativeMethods.GetCursorPos(out original);
            bool systemCursorRestored = false;
            bool userTakeoverDetected = false;
            bool foregroundVerifiedAtDispatch = false;
            using (OscarCursorOverlay overlay = OscarCursorOverlay.ShowAt(cursorOrigin, window, control))
            using (CursorVisualLease visualLease = CursorVisualLease.Acquire(control, point))
            {
                try
                {
                    overlay.MoveTo(point, control);
                    overlay.Hover(control, 120);
                    overlay.PreClickVibration(control, 500);
                    if (originalKnown && SystemCursorMovedByUser(original, 8))
                    {
                        userTakeoverDetected = true;
                        overlay.DisabledAndFade(220);
                        throw new NativeFailure("user-cursor-takeover", "The user moved the system cursor before Oscar closed the window; the action was cancelled.");
                    }
                    control.Verify();
                    RequireExactForeground(window);
                    if (!NativeMethods.SetCursorPos(point.X, point.Y))
                    {
                        throw new NativeFailure("cursor-move-failed", "Windows rejected cursor movement.");
                    }
                    overlay.MarkMouseDown();
                    overlay.PressDown(control, 70);
                    foregroundVerifiedAtDispatch = IsExactWindowForeground(window);
                    if (!NativeMethods.PostMessage(window, NativeMethods.WindowCloseMessage, IntPtr.Zero, IntPtr.Zero))
                    {
                        throw new NativeFailure("window-close-state-uncertain", "Windows rejected the exact native close dispatch.");
                    }
                    overlay.Release(control, 130);
                    NativeMethods.NativePoint current;
                    if (originalKnown && NativeMethods.GetCursorPos(out current))
                    {
                        if (current.X == point.X && current.Y == point.Y)
                        {
                            systemCursorRestored = NativeMethods.SetCursorPos(original.X, original.Y);
                        }
                        else
                        {
                            userTakeoverDetected = true;
                        }
                    }
                    if (userTakeoverDetected) overlay.DisabledAndFade(220);
                    else overlay.SettleIdle(control, 110);
                }
                catch (NativeFailure)
                {
                    if (!userTakeoverDetected) overlay.DisabledAndFade(220);
                    throw;
                }
                Dictionary<string, object> cursor = CursorDictionary(
                    point,
                    systemCursorRestored,
                    userTakeoverDetected,
                    foregroundVerifiedAtDispatch,
                    overlay.Metrics);
                cursor["dispatchMode"] = "windows-message";
                cursor["exactTargetVerifiedAtDispatch"] = true;
                return cursor;
            }
        }

        private static bool WaitForWindowClosed(IntPtr window, ControlGuard control, int timeoutMs)
        {
            Stopwatch stopwatch = Stopwatch.StartNew();
            while (stopwatch.ElapsedMilliseconds < timeoutMs)
            {
                control.Verify();
                if (!NativeMethods.IsWindow(window) || !NativeMethods.IsWindowVisible(window)) return true;
                Thread.Sleep(50);
            }
            return !NativeMethods.IsWindow(window) || !NativeMethods.IsWindowVisible(window);
        }

        private static Dictionary<string, object> DispatchClick(
            IntPtr window,
            Rectangle windowBounds,
            Dictionary<string, object> action,
            AutomationSnapshot automation,
            ControlGuard control,
            Point cursorOrigin,
            bool semanticDispatch)
        {
            Point point = ResolveActionPoint(action, automation, windowBounds, true);
            EnsurePointTargetsWindow(window, point);
            NativeMethods.NativePoint original;
            bool originalKnown = NativeMethods.GetCursorPos(out original);
            bool systemCursorRestored = false;
            bool userTakeoverDetected = false;
            bool foregroundVerifiedAtDispatch = true;
            using (OscarCursorOverlay overlay = OscarCursorOverlay.ShowAt(cursorOrigin, window, control))
            using (CursorVisualLease visualLease = CursorVisualLease.Acquire(control, point))
            {
                try
                {
                    overlay.MoveTo(point, control);
                    overlay.Hover(control, 120);
                    overlay.PreClickVibration(control, 500);
                    if (originalKnown && SystemCursorMovedByUser(original, 8))
                    {
                        userTakeoverDetected = true;
                        overlay.DisabledAndFade(220);
                        throw new NativeFailure("user-cursor-takeover", "The user moved the system cursor before Oscar clicked; the action was cancelled.");
                    }
                    control.Verify();
                    if (!semanticDispatch)
                    {
                        RequireExactForeground(window);
                        if (!NativeMethods.SetCursorPos(point.X, point.Y))
                        {
                            throw new NativeFailure("cursor-move-failed", "Windows rejected cursor movement.");
                        }
                    }
                    string button = OptionalString(action, "button", "left", 20);
                    int clicks = ReadInteger(action, "clicks", 1, 1, 2);
                    uint down;
                    uint up;
                    if (button == "left")
                    {
                        down = NativeMethods.MouseEventLeftDown;
                        up = NativeMethods.MouseEventLeftUp;
                    }
                    else if (button == "right")
                    {
                        down = NativeMethods.MouseEventRightDown;
                        up = NativeMethods.MouseEventRightUp;
                    }
                    else if (button == "middle")
                    {
                        down = NativeMethods.MouseEventMiddleDown;
                        up = NativeMethods.MouseEventMiddleUp;
                    }
                    else
                    {
                        throw new NativeFailure("mouse-button-invalid", "Unsupported mouse button.");
                    }
                    for (int index = 0; index < clicks; index++)
                    {
                        control.Verify();
                        if (index == 0) overlay.MarkMouseDown();
                        if (semanticDispatch)
                        {
                            overlay.PressDown(control, 70);
                            NativeActionWorker dispatch = NativeActionWorker.Start(delegate
                            {
                                DispatchExactSemanticClick(action, automation);
                            });
                            overlay.HoldPressedWhile(control, delegate { return !dispatch.IsCompleted; });
                            dispatch.ThrowIfFailed();
                            overlay.Release(control, 130);
                            foregroundVerifiedAtDispatch = false;
                            systemCursorRestored = true;
                        }
                        else
                        {
                            RequireExactForeground(window);
                            SendMouse(down, 0);
                            try
                            {
                                overlay.PressDown(control, 70);
                                SendMouse(up, 0);
                                foregroundVerifiedAtDispatch = foregroundVerifiedAtDispatch
                                    && IsExactWindowForeground(window);
                            }
                            catch
                            {
                                TryReleaseMouse(up);
                                throw;
                            }
                            overlay.Release(control, 130);
                        }
                    }
                    NativeMethods.NativePoint current;
                    if (!semanticDispatch && originalKnown && NativeMethods.GetCursorPos(out current))
                    {
                        if (current.X == point.X && current.Y == point.Y)
                        {
                            systemCursorRestored = NativeMethods.SetCursorPos(original.X, original.Y);
                        }
                        else
                        {
                            userTakeoverDetected = true;
                        }
                    }
                    if (userTakeoverDetected) overlay.DisabledAndFade(220);
                    else overlay.SettleIdle(control, 110);
                }
                catch (NativeFailure)
                {
                    if (!userTakeoverDetected) overlay.DisabledAndFade(220);
                    throw;
                }
                Dictionary<string, object> cursor = CursorDictionary(point, systemCursorRestored, userTakeoverDetected, foregroundVerifiedAtDispatch, overlay.Metrics);
                cursor["dispatchMode"] = semanticDispatch ? "uia-semantic" : "windows-input";
                cursor["exactTargetVerifiedAtDispatch"] = semanticDispatch;
                return cursor;
            }
        }

        private static Dictionary<string, object> DispatchType(
            IntPtr window,
            Rectangle windowBounds,
            Dictionary<string, object> action,
            AutomationSnapshot automation,
            ControlGuard control,
            Point cursorOrigin,
            bool semanticDispatch)
        {
            ElementSnapshot target = ResolveTarget(action, automation);
            if (target.Password)
            {
                throw new NativeFailure("password-field-blocked", "Computer Use does not type credentials into password fields.");
            }
            string text = RequiredString(action, "text", 4000);
            NativeMethods.NativePoint original;
            bool originalKnown = NativeMethods.GetCursorPos(out original);
            bool userTakeoverDetected = false;
            if (!semanticDispatch) try
            {
                target.Element.SetFocus();
            }
            catch (Exception error)
            {
                throw new NativeFailure("element-focus-failed", "The exact observed UI element could not receive focus: " + SafeMessage(error));
            }
            if (!semanticDispatch) Thread.Sleep(100);
            if (!semanticDispatch && !IsExactWindowForeground(window))
            {
                throw new NativeFailure("window-focus-lost", "The exact target window lost focus before keyboard dispatch.");
            }
            Point point = new Point(
                windowBounds.Left + target.Bounds.Left + target.Bounds.Width / 2,
                windowBounds.Top + target.Bounds.Top + target.Bounds.Height / 2);
            if (semanticDispatch) EnsurePointTargetsWindow(window, point);
            bool foregroundVerifiedAtDispatch = false;
            using (CursorTakeoverMonitor takeoverMonitor = new CursorTakeoverMonitor(original, originalKnown, 8))
            using (OscarCursorOverlay overlay = OscarCursorOverlay.ShowAt(cursorOrigin, window, control))
            using (CursorVisualLease visualLease = CursorVisualLease.Acquire(control, point))
            {
                try
                {
                    overlay.MoveTo(point, control);
                    overlay.TextPrecision(control, 280);
                    overlay.Busy(control, 120);
                    if (takeoverMonitor.Detected || (originalKnown && SystemCursorMovedByUser(original, 8)))
                    {
                        userTakeoverDetected = true;
                        overlay.DisabledAndFade(160);
                        throw new NativeFailure("user-cursor-takeover", "The user moved the system cursor before Oscar typed; the action was cancelled.");
                    }
                    if (semanticDispatch)
                    {
                        NativeActionWorker dispatch = NativeActionWorker.Start(delegate
                        {
                            DispatchExactSemanticType(target, text, control, original, originalKnown);
                        });
                        overlay.HoldBusyWhile(control, delegate { return !dispatch.IsCompleted; });
                        dispatch.ThrowIfFailed();
                    }
                    else
                    {
                        RequireExactForeground(window);
                        SendUnicodeText(text, control, window, original, originalKnown);
                        foregroundVerifiedAtDispatch = IsExactWindowForeground(window);
                    }
                    overlay.TextPrecision(control, 150);
                    userTakeoverDetected = takeoverMonitor.Detected
                        || (originalKnown && SystemCursorMovedByUser(original, 8));
                    if (userTakeoverDetected) overlay.DisabledAndFade(160);
                    else overlay.SettleIdle(control, 100);
                }
                catch (NativeFailure)
                {
                    if (!userTakeoverDetected) overlay.DisabledAndFade(220);
                    throw;
                }
                Dictionary<string, object> cursor = CursorDictionary(point, semanticDispatch, userTakeoverDetected, foregroundVerifiedAtDispatch, overlay.Metrics);
                cursor["dispatchMode"] = semanticDispatch ? "uia-semantic" : "windows-input";
                cursor["exactTargetVerifiedAtDispatch"] = semanticDispatch;
                return cursor;
            }
        }

        private static Dictionary<string, object> DispatchKey(
            IntPtr window,
            Rectangle windowBounds,
            Dictionary<string, object> action,
            AutomationSnapshot automation,
            ControlGuard control,
            Point cursorOrigin,
            bool semanticDispatch)
        {
            string key = RequiredString(action, "key", 20).ToLowerInvariant();
            List<string> modifiers = ReadStringList(action, "modifiers", 3);
            if (modifiers.Contains("ctrl") && modifiers.Contains("alt") && key == "delete")
            {
                throw new NativeFailure("secure-shortcut-blocked", "Secure-desktop keyboard shortcuts are not available to Computer Use.");
            }
            ushort virtualKey = VirtualKey(key);
            List<ushort> modifierKeys = new List<ushort>();
            foreach (string modifier in modifiers)
            {
                if (modifier == "ctrl") modifierKeys.Add(0x11);
                else if (modifier == "alt") modifierKeys.Add(0x12);
                else if (modifier == "shift") modifierKeys.Add(0x10);
                else throw new NativeFailure("modifier-invalid", "Unsupported keyboard modifier.");
            }
            ElementSnapshot semanticTarget = semanticDispatch
                ? ResolveSemanticKeyTarget(key, automation)
                : null;
            Point point = semanticTarget == null
                ? FocusedOrCenterPoint(windowBounds, automation)
                : new Point(
                    windowBounds.Left + semanticTarget.Bounds.Left + semanticTarget.Bounds.Width / 2,
                    windowBounds.Top + semanticTarget.Bounds.Top + semanticTarget.Bounds.Height / 2);
            NativeMethods.NativePoint original;
            bool originalKnown = NativeMethods.GetCursorPos(out original);
            bool userTakeoverDetected = false;
            bool foregroundVerifiedAtDispatch = false;
            using (OscarCursorOverlay overlay = OscarCursorOverlay.ShowAt(cursorOrigin, window, control))
            using (CursorVisualLease visualLease = CursorVisualLease.Acquire(control, point))
            {
                try
                {
                    overlay.MoveTo(point, control);
                    overlay.Hover(control, 190);
                    if (originalKnown && SystemCursorMovedByUser(original, 8))
                    {
                        userTakeoverDetected = true;
                        overlay.DisabledAndFade(160);
                        throw new NativeFailure("user-cursor-takeover", "The user moved the system cursor before Oscar pressed a key; the action was cancelled.");
                    }
                    List<ushort> pressed = new List<ushort>();
                    if (semanticDispatch)
                    {
                        control.Verify();
                        overlay.PressDown(control, 92);
                        NativeActionWorker dispatch = NativeActionWorker.Start(delegate
                        {
                            DispatchExactSemanticInvoke(semanticTarget, control);
                        });
                        overlay.HoldPressedWhile(control, delegate { return !dispatch.IsCompleted; });
                        dispatch.ThrowIfFailed();
                        overlay.Release(control, 170);
                        foregroundVerifiedAtDispatch = false;
                        userTakeoverDetected = originalKnown && SystemCursorMovedByUser(original, 8);
                        if (userTakeoverDetected) overlay.DisabledAndFade(160);
                        else overlay.SettleIdle(control, 100);
                        Dictionary<string, object> semanticCursor = CursorDictionary(point, true, userTakeoverDetected, false, overlay.Metrics);
                        semanticCursor["dispatchMode"] = "uia-semantic";
                        semanticCursor["exactTargetVerifiedAtDispatch"] = true;
                        return semanticCursor;
                    }
                    try
                    {
                        foreach (ushort modifier in modifierKeys)
                        {
                            control.Verify();
                            RequireExactForeground(window);
                            SendVirtualKey(modifier, false);
                            pressed.Add(modifier);
                        }
                        control.Verify();
                        RequireExactForeground(window);
                        SendVirtualKey(virtualKey, false);
                        pressed.Add(virtualKey);
                        overlay.PressDown(control, 92);
                        SendVirtualKey(virtualKey, true);
                        foregroundVerifiedAtDispatch = IsExactWindowForeground(window);
                        pressed.Remove(virtualKey);
                    }
                    finally
                    {
                        pressed.Reverse();
                        foreach (ushort pressedKey in pressed) TryReleaseVirtualKey(pressedKey);
                    }
                    overlay.Release(control, 170);
                    userTakeoverDetected = originalKnown && SystemCursorMovedByUser(original, 8);
                    if (userTakeoverDetected) overlay.DisabledAndFade(160);
                    else overlay.SettleIdle(control, 100);
                }
                catch (NativeFailure)
                {
                    if (!userTakeoverDetected) overlay.DisabledAndFade(220);
                    throw;
                }
                Dictionary<string, object> cursor = CursorDictionary(point, false, userTakeoverDetected, foregroundVerifiedAtDispatch, overlay.Metrics);
                cursor["dispatchMode"] = "windows-input";
                cursor["exactTargetVerifiedAtDispatch"] = false;
                return cursor;
            }
        }

        private static Dictionary<string, object> DispatchScroll(
            IntPtr window,
            Rectangle windowBounds,
            Dictionary<string, object> action,
            AutomationSnapshot automation,
            ControlGuard control,
            Point cursorOrigin)
        {
            Point point = ResolveActionPoint(action, automation, windowBounds, false);
            EnsurePointTargetsWindow(window, point);
            NativeMethods.NativePoint original;
            bool originalKnown = NativeMethods.GetCursorPos(out original);
            bool systemCursorRestored = false;
            bool userTakeoverDetected = false;
            bool foregroundVerifiedAtDispatch = false;
            using (OscarCursorOverlay overlay = OscarCursorOverlay.ShowAt(cursorOrigin, window, control))
            using (CursorVisualLease visualLease = CursorVisualLease.Acquire(control, point))
            {
                try
                {
                    overlay.MoveTo(point, control);
                    overlay.Hover(control, 190);
                    if (originalKnown && SystemCursorMovedByUser(original, 8))
                    {
                        userTakeoverDetected = true;
                        overlay.DisabledAndFade(220);
                        throw new NativeFailure("user-cursor-takeover", "The user moved the system cursor before Oscar scrolled; the action was cancelled.");
                    }
                    control.Verify();
                    RequireExactForeground(window);
                    if (!NativeMethods.SetCursorPos(point.X, point.Y))
                    {
                        throw new NativeFailure("cursor-move-failed", "Windows rejected cursor movement.");
                    }
                    int delta = ReadInteger(action, "deltaY", 0, -1200, 1200);
                    if (delta == 0) throw new NativeFailure("scroll-delta-invalid", "Scroll delta must be non-zero.");
                    control.Verify();
                    RequireExactForeground(window);
                    SendMouse(NativeMethods.MouseEventWheel, delta);
                    foregroundVerifiedAtDispatch = IsExactWindowForeground(window);
                    overlay.MotionBurst(control, 240);
                    NativeMethods.NativePoint current;
                    if (originalKnown && NativeMethods.GetCursorPos(out current))
                    {
                        if (current.X == point.X && current.Y == point.Y)
                        {
                            systemCursorRestored = NativeMethods.SetCursorPos(original.X, original.Y);
                        }
                        else
                        {
                            userTakeoverDetected = true;
                        }
                    }
                    if (userTakeoverDetected) overlay.DisabledAndFade(220);
                    else overlay.SettleIdle(control, 100);
                }
                catch (NativeFailure)
                {
                    if (!userTakeoverDetected) overlay.DisabledAndFade(220);
                    throw;
                }
                return CursorDictionary(point, systemCursorRestored, userTakeoverDetected, foregroundVerifiedAtDispatch, overlay.Metrics);
            }
        }

        private static Point ResolveActionPoint(
            Dictionary<string, object> action,
            AutomationSnapshot automation,
            Rectangle windowBounds,
            bool requireExplicitTarget)
        {
            Dictionary<string, object> targetRecord = OptionalRecord(action, "target");
            string elementId = targetRecord == null ? "" : OptionalString(targetRecord, "elementId", "", 100);
            if (elementId.Length > 0)
            {
                ElementSnapshot element = ResolveTarget(action, automation);
                if (element.Offscreen || element.Bounds.Width <= 0 || element.Bounds.Height <= 0)
                {
                    throw new NativeFailure("element-not-visible", "The exact observed UI element is not currently visible.");
                }
                return new Point(
                    windowBounds.Left + element.Bounds.Left + element.Bounds.Width / 2,
                    windowBounds.Top + element.Bounds.Top + element.Bounds.Height / 2);
            }
            bool hasX = action.ContainsKey("x");
            bool hasY = action.ContainsKey("y");
            if (hasX != hasY || (!hasX && requireExplicitTarget))
            {
                throw new NativeFailure("action-target-invalid", "Supply exactly one semantic elementId or one x/y coordinate pair.");
            }
            int relativeX = hasX ? ReadInteger(action, "x", -1, 0, Math.Max(0, windowBounds.Width - 1)) : windowBounds.Width / 2;
            int relativeY = hasY ? ReadInteger(action, "y", -1, 0, Math.Max(0, windowBounds.Height - 1)) : windowBounds.Height / 2;
            return new Point(windowBounds.Left + relativeX, windowBounds.Top + relativeY);
        }

        private static ElementSnapshot ResolveTarget(Dictionary<string, object> action, AutomationSnapshot automation)
        {
            Dictionary<string, object> expectedTarget = RequiredRecord(action, "target");
            string elementId = RequiredString(expectedTarget, "elementId", 100);
            ElementSnapshot target = automation.Elements.FirstOrDefault(delegate(ElementSnapshot item)
            {
                return String.Equals(item.ElementId, elementId, StringComparison.Ordinal);
            });
            if (target == null)
            {
                throw new NativeFailure("element-stale-or-missing", "The exact observed UI element is no longer uniquely available.");
            }
            if (!TargetMatches(target, expectedTarget))
            {
                throw new NativeFailure("element-identity-mismatch", "The UI element no longer matches its observation receipt.");
            }
            return target;
        }

        private static bool CanUseExactSemanticDispatch(
            Dictionary<string, object> action,
            string kind,
            AutomationSnapshot automation)
        {
            if (kind == "key")
            {
                string key = OptionalString(action, "key", "", 20).ToLowerInvariant();
                return ResolveSemanticKeyTarget(key, automation) != null;
            }
            Dictionary<string, object> target = OptionalRecord(action, "target");
            if (target == null || OptionalString(target, "elementId", "", 100).Length == 0) return false;
            if (kind == "type") return true;
            return kind == "click"
                && OptionalString(action, "button", "left", 20) == "left";
        }

        private static ElementSnapshot ResolveSemanticKeyTarget(string key, AutomationSnapshot automation)
        {
            string automationId;
            if (key.Length == 1 && key[0] >= '0' && key[0] <= '9') automationId = "num" + key + "Button";
            else if (key == "escape") automationId = "clearButton";
            else if (key == "add") automationId = "plusButton";
            else if (key == "subtract") automationId = "minusButton";
            else if (key == "multiply") automationId = "multiplyButton";
            else if (key == "divide") automationId = "divideButton";
            else if (key == "decimal") automationId = "decimalSeparatorButton";
            else if (key == "enter") automationId = "equalButton";
            else return null;
            List<ElementSnapshot> matches = automation.Elements.Where(delegate(ElementSnapshot item)
            {
                return item.Enabled
                    && !item.Offscreen
                    && String.Equals(item.AutomationId, automationId, StringComparison.Ordinal)
                    && item.Patterns.Contains("invoke");
            }).ToList();
            return matches.Count == 1 ? matches[0] : null;
        }

        private static void DispatchExactSemanticInvoke(ElementSnapshot target, ControlGuard control)
        {
            if (target == null) throw new NativeFailure("semantic-key-target-missing", "The exact semantic key target is unavailable.");
            control.Verify();
            object pattern;
            if (!target.Element.TryGetCurrentPattern(InvokePattern.Pattern, out pattern) || !(pattern is InvokePattern))
            {
                throw new NativeFailure("semantic-invoke-unavailable", "The exact observed key target does not expose a UI Automation Invoke pattern.");
            }
            ((InvokePattern)pattern).Invoke();
            control.Verify();
        }

        private static void PrepareExactWindowForSemanticDispatch(IntPtr window)
        {
            if (NativeMethods.IsIconic(window)) NativeMethods.ShowWindowAsync(window, NativeMethods.ShowRestore);
            if (!NativeMethods.SetWindowPos(
                window,
                NativeMethods.WindowTop,
                0,
                0,
                0,
                0,
                NativeMethods.SetWindowNoMove
                    | NativeMethods.SetWindowNoSize
                    | NativeMethods.SetWindowNoActivate
                    | NativeMethods.SetWindowShow))
            {
                throw new NativeFailure("window-z-order-rejected", "Windows did not expose the exact target window for semantic dispatch.");
            }
            Thread.Sleep(80);
        }

        private static void DispatchExactSemanticClick(
            Dictionary<string, object> action,
            AutomationSnapshot automation)
        {
            ElementSnapshot target = ResolveTarget(action, automation);
            object pattern;
            if (!target.Element.TryGetCurrentPattern(InvokePattern.Pattern, out pattern) || !(pattern is InvokePattern))
            {
                throw new NativeFailure("semantic-invoke-unavailable", "The exact observed element does not expose a UI Automation Invoke pattern.");
            }
            ((InvokePattern)pattern).Invoke();
        }

        private static void DispatchExactSemanticType(
            ElementSnapshot target,
            string text,
            ControlGuard control,
            NativeMethods.NativePoint originalCursor,
            bool originalCursorKnown)
        {
            control.Verify();
            object pattern;
            if (!target.Element.TryGetCurrentPattern(ValuePattern.Pattern, out pattern) || !(pattern is ValuePattern))
            {
                throw new NativeFailure("semantic-value-unavailable", "The exact observed element does not expose a writable UI Automation Value pattern.");
            }
            ValuePattern value = (ValuePattern)pattern;
            if (value.Current.IsReadOnly)
            {
                throw new NativeFailure("semantic-value-read-only", "The exact observed UI Automation Value target is read-only.");
            }
            control.Verify();
            if (originalCursorKnown && SystemCursorMovedByUser(originalCursor, 8))
            {
                throw new NativeFailure("user-cursor-takeover", "The user moved the system cursor before Oscar completed semantic typing; the action was cancelled.");
            }
            value.SetValue(text);
            control.Verify();
        }

        private static bool TargetMatches(ElementSnapshot actual, Dictionary<string, object> expected)
        {
            return String.Equals(actual.ElementId, RequiredString(expected, "elementId", 100), StringComparison.Ordinal)
                && String.Equals(actual.Name, OptionalString(expected, "name", "", 4096), StringComparison.Ordinal)
                && String.Equals(actual.AutomationId, OptionalString(expected, "automationId", "", 4096), StringComparison.Ordinal)
                && String.Equals(actual.ClassName, OptionalString(expected, "className", "", 4096), StringComparison.Ordinal)
                && String.Equals(actual.ControlType, OptionalString(expected, "controlType", "", 256), StringComparison.Ordinal)
                && SameBounds(actual.Bounds, ReadBounds(RequiredRecord(expected, "bounds")))
                && actual.Password == ReadBoolean(expected, "password", false);
        }

        private static void EnsurePointTargetsWindow(IntPtr window, Point point)
        {
            IntPtr hit = NativeMethods.WindowFromPoint(new NativeMethods.NativePoint { X = point.X, Y = point.Y });
            IntPtr root = hit == IntPtr.Zero ? IntPtr.Zero : NativeMethods.GetAncestor(hit, NativeMethods.GetAncestorRoot);
            if (root != window)
            {
                throw new NativeFailure("window-occluded", "The cursor target is not currently owned by the exact foreground window.");
            }
        }

        private static bool ActivateExactWindow(IntPtr window)
        {
            uint currentThread = NativeMethods.GetCurrentThreadId();
            uint targetThread = NativeMethods.GetWindowThreadProcessId(window, IntPtr.Zero);
            for (int activationAttempt = 0; activationAttempt < 5; activationAttempt++)
            {
                if (IsExactWindowForeground(window)) return true;
                if (NativeMethods.IsIconic(window)) NativeMethods.ShowWindowAsync(window, NativeMethods.ShowRestore);
                try
                {
                    AutomationElement exactRoot = AutomationElement.FromHandle(window);
                    if (exactRoot != null) exactRoot.SetFocus();
                }
                catch
                {
                    // Some providers reject UIA focus. The exact Win32 path
                    // below remains independently verified before dispatch.
                }
                if (IsExactWindowForeground(window)) return true;
                IntPtr foreground = NativeMethods.GetForegroundWindow();
                uint foregroundThread = foreground == IntPtr.Zero
                    ? 0
                    : NativeMethods.GetWindowThreadProcessId(foreground, IntPtr.Zero);
                bool attachedTarget = currentThread != targetThread
                    && NativeMethods.AttachThreadInput(targetThread, currentThread, true);
                bool attachedForeground = foregroundThread != 0
                    && foregroundThread != currentThread
                    && foregroundThread != targetThread
                    && NativeMethods.AttachThreadInput(foregroundThread, currentThread, true);
                try
                {
                    NativeMethods.BringWindowToTop(window);
                    NativeMethods.SetForegroundWindow(window);
                    NativeMethods.SetActiveWindow(window);
                    NativeMethods.SetFocus(window);
                    for (int attachedPoll = 0; attachedPoll < 5; attachedPoll++)
                    {
                        if (IsExactWindowForeground(window)) return true;
                        Thread.Sleep(20);
                    }
                }
                finally
                {
                    if (attachedForeground) NativeMethods.AttachThreadInput(foregroundThread, currentThread, false);
                    if (attachedTarget) NativeMethods.AttachThreadInput(targetThread, currentThread, false);
                }
                for (int poll = 0; poll < 5; poll++)
                {
                    if (IsExactWindowForeground(window)) return true;
                    Thread.Sleep(20);
                }
            }
            // Windows foreground-lock rules can still reject a helper process
            // even after its thread is attached to the current foreground
            // queue. A balanced Alt down/up is the documented user-input
            // prelude used by native desktop launchers: it never targets an
            // application control, cannot remain pressed, and the exact HWND
            // is re-verified before any requested input is dispatched.
            if (TryUnlockForegroundWithAlt())
            {
                if (NativeMethods.IsIconic(window)) NativeMethods.ShowWindowAsync(window, NativeMethods.ShowRestore);
                NativeMethods.BringWindowToTop(window);
                NativeMethods.SetForegroundWindow(window);
                for (int poll = 0; poll < 15; poll++)
                {
                    if (IsExactWindowForeground(window)) return true;
                    Thread.Sleep(20);
                }
            }
            return false;
        }

        private static bool TryUnlockForegroundWithAlt()
        {
            bool pressed = false;
            try
            {
                uint down = NativeMethods.SendInput(1, new[] { NativeMethods.VirtualKeyInput(0x12, false) }, Marshal.SizeOf(typeof(NativeMethods.Input)));
                if (down != 1) return false;
                pressed = true;
                uint up = NativeMethods.SendInput(1, new[] { NativeMethods.VirtualKeyInput(0x12, true) }, Marshal.SizeOf(typeof(NativeMethods.Input)));
                pressed = false;
                return up == 1;
            }
            finally
            {
                if (pressed)
                {
                    NativeMethods.SendInput(1, new[] { NativeMethods.VirtualKeyInput(0x12, true) }, Marshal.SizeOf(typeof(NativeMethods.Input)));
                }
            }
        }

        private static bool IsExactWindowForeground(IntPtr window)
        {
            IntPtr foreground = NativeMethods.GetForegroundWindow();
            if (foreground == window) return true;
            return foreground != IntPtr.Zero
                && NativeMethods.GetAncestor(foreground, NativeMethods.GetAncestorRoot) == window;
        }

        private static Dictionary<string, object> ObservationDictionary(
            Dictionary<string, object> window,
            AutomationSnapshot automation,
            ScreenshotSnapshot screenshot)
        {
            return new Dictionary<string, object>
            {
                { "observedAt", DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture) },
                { "window", window },
                { "screenshot", screenshot.ToDictionary() },
                { "stateFingerprint", automation.StateFingerprint },
                { "focusedElementId", automation.FocusedElementId },
                { "elements", automation.Elements.Select(delegate(ElementSnapshot item) { return item.ToDictionary(); }).ToList() },
                { "truncated", automation.Truncated }
            };
        }

        private static AutomationSnapshot ReadAutomation(IntPtr window, Rectangle windowBounds)
        {
            AutomationSnapshot snapshot = new AutomationSnapshot();
            AutomationElement root;
            try
            {
                root = AutomationElement.FromHandle(window);
            }
            catch
            {
                root = null;
            }
            if (root == null)
            {
                snapshot.StateFingerprint = Sha256Hex("uia-unavailable");
                return snapshot;
            }

            AutomationSnapshot controlView = ReadAutomationTree(root, windowBounds, TreeWalker.ControlViewWalker);
            if (controlView.Elements.Count > 1) return controlView;

            // Some XAML/WinUI surfaces expose only their top-level pane in the
            // control view while keeping actionable descendants in RawView.
            // Prefer the richer bounded tree, but retain the factual control
            // result when RawView does not add anything.
            AutomationSnapshot rawView = ReadAutomationTree(root, windowBounds, TreeWalker.RawViewWalker);
            return rawView.Elements.Count > controlView.Elements.Count ? rawView : controlView;
        }

        private static AutomationSnapshot ReadAutomationTree(
            AutomationElement root,
            Rectangle windowBounds,
            TreeWalker walker)
        {
            AutomationSnapshot snapshot = new AutomationSnapshot();
            const int maxElements = 300;
            const int maxDepth = 20;
            Queue<Tuple<AutomationElement, int>> queue = new Queue<Tuple<AutomationElement, int>>();
            queue.Enqueue(Tuple.Create(root, 0));
            Dictionary<string, int> duplicates = new Dictionary<string, int>(StringComparer.Ordinal);
            while (queue.Count > 0 && snapshot.Elements.Count < maxElements)
            {
                Tuple<AutomationElement, int> current = queue.Dequeue();
                ElementSnapshot element = ReadElement(current.Item1, windowBounds, duplicates);
                if (element != null)
                {
                    snapshot.Elements.Add(element);
                    if (element.Focused) snapshot.FocusedElementId = element.ElementId;
                }
                if (current.Item2 >= maxDepth) continue;
                AutomationElement child = SafeFirstChild(walker, current.Item1);
                int siblingGuard = 0;
                while (child != null && siblingGuard < 1000)
                {
                    queue.Enqueue(Tuple.Create(child, current.Item2 + 1));
                    child = SafeNextSibling(walker, child);
                    siblingGuard++;
                }
            }
            snapshot.Truncated = queue.Count > 0;
            string canonical = String.Join("\n", snapshot.Elements.Select(delegate(ElementSnapshot item)
            {
                return item.FingerprintLine();
            }).ToArray());
            snapshot.StateFingerprint = Sha256Hex(canonical);
            return snapshot;
        }

        private static ElementSnapshot ReadElement(
            AutomationElement element,
            Rectangle windowBounds,
            Dictionary<string, int> duplicates)
        {
            try
            {
                AutomationElement.AutomationElementInformation current = element.Current;
                System.Windows.Rect rawBounds = current.BoundingRectangle;
                Rectangle relativeBounds = new Rectangle(
                    ClampCoordinate((int)Math.Round(rawBounds.Left) - windowBounds.Left),
                    ClampCoordinate((int)Math.Round(rawBounds.Top) - windowBounds.Top),
                    ClampSize((int)Math.Round(rawBounds.Width)),
                    ClampSize((int)Math.Round(rawBounds.Height)));
                string controlType = current.ControlType == null
                    ? "Unknown"
                    : current.ControlType.ProgrammaticName.Replace("ControlType.", "");
                string name = BoundText(current.Name, 500);
                string automationId = BoundText(current.AutomationId, 500);
                string className = BoundText(current.ClassName, 500);
                string signature = String.Join("|", new[]
                {
                    automationId,
                    className,
                    controlType,
                    name,
                    relativeBounds.X.ToString(CultureInfo.InvariantCulture),
                    relativeBounds.Y.ToString(CultureInfo.InvariantCulture),
                    relativeBounds.Width.ToString(CultureInfo.InvariantCulture),
                    relativeBounds.Height.ToString(CultureInfo.InvariantCulture)
                });
                int ordinal;
                if (!duplicates.TryGetValue(signature, out ordinal)) ordinal = 0;
                duplicates[signature] = ordinal + 1;
                List<string> patterns = ReadPatterns(element);
                string value = current.IsPassword ? "" : ReadElementValue(element);
                return new ElementSnapshot
                {
                    Element = element,
                    ElementId = "el-" + Sha256Hex(signature).Substring(0, 16) + "-" + ordinal.ToString(CultureInfo.InvariantCulture),
                    Name = name,
                    Value = value,
                    AutomationId = automationId,
                    ClassName = className,
                    ControlType = controlType,
                    Bounds = relativeBounds,
                    Enabled = current.IsEnabled,
                    Offscreen = current.IsOffscreen,
                    Focusable = current.IsKeyboardFocusable,
                    Focused = current.HasKeyboardFocus,
                    Password = current.IsPassword,
                    Patterns = patterns
                };
            }
            catch
            {
                return null;
            }
        }

        private static List<string> ReadPatterns(AutomationElement element)
        {
            List<string> result = new List<string>();
            AddPattern(element, InvokePattern.Pattern, "invoke", result);
            AddPattern(element, ValuePattern.Pattern, "value", result);
            AddPattern(element, SelectionItemPattern.Pattern, "select", result);
            AddPattern(element, TogglePattern.Pattern, "toggle", result);
            AddPattern(element, ExpandCollapsePattern.Pattern, "expand-collapse", result);
            AddPattern(element, ScrollItemPattern.Pattern, "scroll-item", result);
            return result;
        }

        private static string ReadElementValue(AutomationElement element)
        {
            try
            {
                object pattern;
                if (element.TryGetCurrentPattern(ValuePattern.Pattern, out pattern) && pattern is ValuePattern)
                {
                    return BoundText(((ValuePattern)pattern).Current.Value, 500);
                }
            }
            catch
            {
                // The native provider may disappear between tree capture and
                // pattern read. Empty value is a factual, bounded fallback.
            }
            return "";
        }

        private static void AddPattern(AutomationElement element, AutomationPattern pattern, string name, List<string> output)
        {
            try
            {
                object value;
                if (element.TryGetCurrentPattern(pattern, out value)) output.Add(name);
            }
            catch
            {
                // UI Automation providers may disappear while being inspected.
            }
        }

        private static AutomationElement SafeFirstChild(TreeWalker walker, AutomationElement element)
        {
            try { return walker.GetFirstChild(element); }
            catch { return null; }
        }

        private static AutomationElement SafeNextSibling(TreeWalker walker, AutomationElement element)
        {
            try { return walker.GetNextSibling(element); }
            catch { return null; }
        }

        private static ScreenshotSnapshot CaptureWindow(IntPtr window, Rectangle bounds, string outputPath)
        {
            if (bounds.Width <= 0 || bounds.Height <= 0 || bounds.Width > 16384 || bounds.Height > 16384)
            {
                throw new NativeFailure("window-bounds-invalid", "Window bounds cannot be captured safely.");
            }
            string directory = Path.GetDirectoryName(outputPath);
            if (String.IsNullOrWhiteSpace(directory)) throw new NativeFailure("screenshot-path-invalid", "Screenshot path has no parent directory.");
            Directory.CreateDirectory(directory);
            using (Bitmap bitmap = new Bitmap(bounds.Width, bounds.Height, PixelFormat.Format32bppArgb))
            {
                bool printed = false;
                using (Graphics graphics = Graphics.FromImage(bitmap))
                {
                    IntPtr deviceContext = graphics.GetHdc();
                    try
                    {
                        printed = NativeMethods.PrintWindow(window, deviceContext, NativeMethods.PrintWindowRenderFullContent);
                    }
                    finally
                    {
                        graphics.ReleaseHdc(deviceContext);
                    }
                }
                string method = "print-window";
                bool occlusionSafe = printed;
                if (!printed)
                {
                    try
                    {
                        using (Graphics graphics = Graphics.FromImage(bitmap))
                        {
                            graphics.CopyFromScreen(bounds.Location, Point.Empty, bounds.Size, CopyPixelOperation.SourceCopy);
                        }
                        method = "screen-copy";
                    }
                    catch (Exception error)
                    {
                        throw new NativeFailure("window-capture-failed", "Window capture failed: " + SafeMessage(error));
                    }
                }
                string temporary = outputPath + ".tmp-" + Guid.NewGuid().ToString("N") + ".png";
                bitmap.Save(temporary, ImageFormat.Png);
                if (File.Exists(outputPath)) File.Delete(outputPath);
                File.Move(temporary, outputPath);
                byte[] bytes = File.ReadAllBytes(outputPath);
                return new ScreenshotSnapshot
                {
                    Path = Path.GetFullPath(outputPath),
                    Sha256 = Sha256Hex(bytes),
                    PerceptualHash = DifferenceHash(bitmap),
                    Width = bitmap.Width,
                    Height = bitmap.Height,
                    CaptureMethod = method,
                    OcclusionSafe = occlusionSafe
                };
            }
        }

        private static string DifferenceHash(Bitmap source)
        {
            ulong hash = 0;
            using (Bitmap scaled = new Bitmap(source, new Size(9, 8)))
            {
                int bit = 0;
                for (int y = 0; y < 8; y++)
                {
                    for (int x = 0; x < 8; x++)
                    {
                        Color left = scaled.GetPixel(x, y);
                        Color right = scaled.GetPixel(x + 1, y);
                        int leftValue = left.R * 299 + left.G * 587 + left.B * 114;
                        int rightValue = right.R * 299 + right.G * 587 + right.B * 114;
                        if (leftValue > rightValue) hash |= 1UL << bit;
                        bit++;
                    }
                }
            }
            return hash.ToString("X16", CultureInfo.InvariantCulture);
        }

        private static int PerceptualDistance(string expected, string actual)
        {
            ulong left;
            ulong right;
            if (!UInt64.TryParse(expected, NumberStyles.HexNumber, CultureInfo.InvariantCulture, out left)
                || !UInt64.TryParse(actual, NumberStyles.HexNumber, CultureInfo.InvariantCulture, out right))
            {
                return 64;
            }
            ulong value = left ^ right;
            int count = 0;
            while (value != 0)
            {
                count++;
                value &= value - 1;
            }
            return count;
        }

        private static bool TryReadWindow(IntPtr handle, out Dictionary<string, object> summary)
        {
            summary = null;
            if (handle == IntPtr.Zero || !NativeMethods.IsWindow(handle) || !NativeMethods.IsWindowVisible(handle)) return false;
            int titleLength = NativeMethods.GetWindowTextLength(handle);
            if (titleLength <= 0 || titleLength > 4096) return false;
            StringBuilder titleBuffer = new StringBuilder(titleLength + 1);
            NativeMethods.GetWindowText(handle, titleBuffer, titleBuffer.Capacity);
            string title = BoundText(titleBuffer.ToString(), 4096);
            if (String.IsNullOrWhiteSpace(title)) return false;
            uint processId;
            NativeMethods.GetWindowThreadProcessId(handle, out processId);
            if (processId == 0) return false;
            string processName = ProcessName(processId);
            if (IsProtectedWindow(processName, title)) return false;
            int cloaked;
            if (NativeMethods.DwmGetWindowAttribute(
                handle,
                NativeMethods.DwmWindowAttributeCloaked,
                out cloaked,
                Marshal.SizeOf(typeof(int))) == 0 && cloaked != 0) return false;
            Rectangle bounds;
            try { bounds = WindowBounds(handle); }
            catch { return false; }
            if (bounds.Width < 2 || bounds.Height < 2) return false;
            summary = new Dictionary<string, object>
            {
                { "windowRef", WindowRef(handle) },
                { "processId", (int)processId },
                { "processName", processName },
                { "title", title },
                { "bounds", NativeMethods.BoundsDictionary(bounds) },
                { "minimized", NativeMethods.IsIconic(handle) },
                { "foreground", NativeMethods.GetForegroundWindow() == handle }
            };
            return true;
        }

        private static Dictionary<string, object> RequireWindow(IntPtr window)
        {
            Dictionary<string, object> summary;
            if (!TryReadWindow(window, out summary))
            {
                throw new NativeFailure("window-unavailable-or-protected", "The exact window is unavailable, hidden, ambiguous, or protected.");
            }
            return summary;
        }

        private static bool IsProtectedWindow(string processName, string title)
        {
            string process = (processName ?? "").Trim().ToLowerInvariant();
            HashSet<string> blockedProcesses = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
            {
                "consent", "credentialuibroker", "lockapp", "logonui", "lsass", "msmpeng",
                "securityhealthhost", "sechealthui", "winlogon",
                "1password", "bitwarden", "dashlane", "keepass", "keepassxc", "lastpass",
                "nordpass", "protonpass", "roboform"
            };
            if (blockedProcesses.Contains(process)) return true;
            string normalizedTitle = (title ?? "").Trim().ToLowerInvariant();
            return normalizedTitle.Contains("windows security")
                || normalizedTitle.Contains("безопасность windows")
                || normalizedTitle.Contains("monarch security")
                || normalizedTitle.Contains("диспетчер учетных данных")
                || normalizedTitle.Contains("credential manager");
        }

        private static string ProcessName(uint processId)
        {
            try
            {
                using (Process process = Process.GetProcessById((int)processId)) return BoundText(process.ProcessName, 256);
            }
            catch
            {
                return "unknown";
            }
        }

        private static Rectangle WindowBounds(IntPtr window)
        {
            NativeMethods.NativeRect value;
            if (!NativeMethods.GetWindowRect(window, out value))
            {
                throw new NativeFailure("window-bounds-unavailable", "Windows did not return target window bounds.");
            }
            return Rectangle.FromLTRB(value.Left, value.Top, value.Right, value.Bottom);
        }

        private static IntPtr ResolveWindow(string windowRef)
        {
            if (!windowRef.StartsWith("hwnd:", StringComparison.OrdinalIgnoreCase))
            {
                throw new NativeFailure("window-ref-invalid", "Window reference format is invalid.");
            }
            string hex = windowRef.Substring(5);
            ulong raw;
            if (hex.Length < 8 || hex.Length > 16
                || !UInt64.TryParse(hex, NumberStyles.HexNumber, CultureInfo.InvariantCulture, out raw))
            {
                throw new NativeFailure("window-ref-invalid", "Window reference format is invalid.");
            }
            IntPtr result = new IntPtr(unchecked((long)raw));
            if (!NativeMethods.IsWindow(result))
            {
                throw new NativeFailure("window-not-found", "The exact observed window no longer exists.");
            }
            return result;
        }

        private static string WindowRef(IntPtr handle)
        {
            return "hwnd:" + unchecked((ulong)handle.ToInt64()).ToString("X16", CultureInfo.InvariantCulture);
        }

        private static void SendUnicodeText(
            string text,
            ControlGuard control,
            IntPtr window,
            NativeMethods.NativePoint originalCursor,
            bool originalCursorKnown)
        {
            foreach (char character in text)
            {
                control.Verify();
                RequireExactForeground(window);
                if (originalCursorKnown && SystemCursorMovedByUser(originalCursor, 8))
                {
                    throw new NativeFailure(
                        "user-cursor-takeover",
                        "The user moved the system cursor while Oscar was typing; Computer Use stopped before the next character.");
                }
                NativeMethods.Input[] inputs = new NativeMethods.Input[2];
                inputs[0] = NativeMethods.UnicodeInput(character, false);
                inputs[1] = NativeMethods.UnicodeInput(character, true);
                SendInputs(inputs);
            }
        }

        private static void SendVirtualKey(ushort key, bool up)
        {
            SendInputs(new[] { NativeMethods.VirtualKeyInput(key, up) });
        }

        private static void TryReleaseVirtualKey(ushort key)
        {
            try { SendVirtualKey(key, true); }
            catch { }
        }

        private static void TryReleaseMouse(uint up)
        {
            try { SendMouse(up, 0); }
            catch { }
        }

        private static void SendMouse(uint flags, int data)
        {
            NativeMethods.Input input = new NativeMethods.Input();
            input.Type = NativeMethods.InputMouse;
            input.Union.Mouse = new NativeMethods.MouseInput
            {
                Dx = 0,
                Dy = 0,
                MouseData = unchecked((uint)data),
                Flags = flags,
                Time = 0,
                ExtraInfo = UIntPtr.Zero
            };
            SendInputs(new[] { input });
        }

        private static void SendInputs(NativeMethods.Input[] inputs)
        {
            uint sent = NativeMethods.SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(NativeMethods.Input)));
            if (sent != inputs.Length)
            {
                throw new NativeFailure("windows-input-rejected", "Windows rejected native input dispatch (" + Marshal.GetLastWin32Error().ToString(CultureInfo.InvariantCulture) + ").");
            }
        }

        private static ushort VirtualKey(string key)
        {
            Dictionary<string, ushort> keys = new Dictionary<string, ushort>(StringComparer.OrdinalIgnoreCase)
            {
                { "backspace", 0x08 }, { "tab", 0x09 }, { "enter", 0x0D }, { "escape", 0x1B },
                { "space", 0x20 }, { "pageup", 0x21 }, { "pagedown", 0x22 }, { "end", 0x23 },
                { "home", 0x24 }, { "left", 0x25 }, { "up", 0x26 }, { "right", 0x27 },
                { "down", 0x28 }, { "delete", 0x2E },
                { "add", 0x6B }, { "subtract", 0x6D }, { "multiply", 0x6A },
                { "divide", 0x6F }, { "decimal", 0x6E },
                { "f1", 0x70 }, { "f2", 0x71 }, { "f3", 0x72 }, { "f4", 0x73 },
                { "f5", 0x74 }, { "f6", 0x75 }, { "f7", 0x76 }, { "f8", 0x77 },
                { "f9", 0x78 }, { "f10", 0x79 }, { "f11", 0x7A }, { "f12", 0x7B }
            };
            if (key.Length == 1 && key[0] >= 'a' && key[0] <= 'z') return (ushort)Char.ToUpperInvariant(key[0]);
            if (key.Length == 1 && key[0] >= '0' && key[0] <= '9') return (ushort)key[0];
            ushort value;
            if (keys.TryGetValue(key, out value)) return value;
            throw new NativeFailure("key-invalid", "Unsupported key.");
        }

        private static Rectangle ReadBounds(Dictionary<string, object> value)
        {
            return new Rectangle(
                ReadInteger(value, "x", 0, -100000, 100000),
                ReadInteger(value, "y", 0, -100000, 100000),
                ReadInteger(value, "width", 0, 0, 16384),
                ReadInteger(value, "height", 0, 0, 16384));
        }

        private static bool SameBounds(Rectangle left, Rectangle right)
        {
            return left.X == right.X && left.Y == right.Y && left.Width == right.Width && left.Height == right.Height;
        }

        private static bool SystemCursorMovedByUser(NativeMethods.NativePoint expected, int tolerance)
        {
            NativeMethods.NativePoint current;
            return NativeMethods.GetCursorPos(out current)
                && (Math.Abs(current.X - expected.X) > tolerance || Math.Abs(current.Y - expected.Y) > tolerance);
        }

        private static void RequireExactForeground(IntPtr window)
        {
            if (!IsExactWindowForeground(window))
            {
                throw new NativeFailure("window-focus-lost", "The exact target window lost focus before native input dispatch.");
            }
        }

        private static Dictionary<string, object> CursorDictionary(
            Point point,
            bool systemCursorRestored,
            bool userTakeoverDetected,
            bool foregroundVerifiedAtDispatch,
            OscarCursorAnimationMetrics animation)
        {
            return new Dictionary<string, object>
            {
                { "x", point.X },
                { "y", point.Y },
                { "style", "oscar-orange" },
                { "nativeOverlay", true },
                { "systemCursorRestored", systemCursorRestored },
                { "userTakeoverDetected", userTakeoverDetected },
                { "foregroundVerifiedAtDispatch", foregroundVerifiedAtDispatch },
                { "animation", animation.ToDictionary() }
            };
        }

        private static Point FocusedOrCenterPoint(Rectangle windowBounds, AutomationSnapshot automation)
        {
            ElementSnapshot focused = automation.Elements.FirstOrDefault(delegate(ElementSnapshot item)
            {
                return item.Focused && item.Bounds.Width > 0 && item.Bounds.Height > 0;
            });
            return focused == null
                ? new Point(windowBounds.Left + windowBounds.Width / 2, windowBounds.Top + windowBounds.Height / 2)
                : new Point(
                    windowBounds.Left + focused.Bounds.Left + focused.Bounds.Width / 2,
                    windowBounds.Top + focused.Bounds.Top + focused.Bounds.Height / 2);
        }

        private static string RequiredString(Dictionary<string, object> record, string key, int maxLength)
        {
            object value;
            string text = record.TryGetValue(key, out value) ? Convert.ToString(value, CultureInfo.InvariantCulture) : "";
            text = text == null ? "" : text.Trim();
            if (text.Length == 0 || text.Length > maxLength)
            {
                throw new NativeFailure("request-field-invalid", "Required request field is invalid: " + key);
            }
            return text;
        }

        private static string OptionalString(Dictionary<string, object> record, string key, string fallback, int maxLength)
        {
            object value;
            if (!record.TryGetValue(key, out value) || value == null) return fallback;
            string text = Convert.ToString(value, CultureInfo.InvariantCulture) ?? "";
            if (text.Length > maxLength) throw new NativeFailure("request-field-invalid", "Request field is oversized: " + key);
            return text.Trim();
        }

        private static int ReadInteger(Dictionary<string, object> record, string key, int fallback, int minimum, int maximum)
        {
            object value;
            if (!record.TryGetValue(key, out value) || value == null) return fallback;
            int number;
            try { number = Convert.ToInt32(value, CultureInfo.InvariantCulture); }
            catch { throw new NativeFailure("request-field-invalid", "Request field must be an integer: " + key); }
            if (number < minimum || number > maximum)
            {
                throw new NativeFailure("request-field-invalid", "Request integer is out of range: " + key);
            }
            return number;
        }

        private static bool ReadBoolean(Dictionary<string, object> record, string key, bool fallback)
        {
            object value;
            if (!record.TryGetValue(key, out value) || value == null) return fallback;
            try { return Convert.ToBoolean(value, CultureInfo.InvariantCulture); }
            catch { throw new NativeFailure("request-field-invalid", "Request field must be boolean: " + key); }
        }

        private static List<string> ReadStringList(Dictionary<string, object> record, string key, int maximum)
        {
            object value;
            if (!record.TryGetValue(key, out value) || value == null) return new List<string>();
            System.Collections.IEnumerable enumerable = value as System.Collections.IEnumerable;
            if (enumerable == null || value is string) throw new NativeFailure("request-field-invalid", "Request array is invalid: " + key);
            object[] raw = enumerable.Cast<object>().ToArray();
            if (raw.Length > maximum) throw new NativeFailure("request-field-invalid", "Request array is invalid: " + key);
            List<string> values = raw.Select(delegate(object item)
            {
                return Convert.ToString(item, CultureInfo.InvariantCulture).Trim().ToLowerInvariant();
            }).Where(delegate(string item) { return item.Length > 0; }).Distinct(StringComparer.Ordinal).ToList();
            if (values.Count != raw.Length) throw new NativeFailure("request-field-invalid", "Request array contains duplicate or blank values: " + key);
            return values;
        }

        private static Dictionary<string, object> RequiredRecord(Dictionary<string, object> record, string key)
        {
            object value;
            if (!record.TryGetValue(key, out value) || !(value is Dictionary<string, object>))
            {
                throw new NativeFailure("request-field-invalid", "Request object is invalid: " + key);
            }
            return (Dictionary<string, object>)value;
        }

        private static Dictionary<string, object> OptionalRecord(Dictionary<string, object> record, string key)
        {
            object value;
            if (!record.TryGetValue(key, out value) || value == null) return null;
            if (!(value is Dictionary<string, object>))
            {
                throw new NativeFailure("request-field-invalid", "Request object is invalid: " + key);
            }
            return (Dictionary<string, object>)value;
        }

        private static string RequiredAbsolutePath(Dictionary<string, object> record, string key)
        {
            string value = RequiredString(record, key, 32767);
            if (!Path.IsPathRooted(value)) throw new NativeFailure("request-path-invalid", "Request path must be absolute.");
            return Path.GetFullPath(value);
        }

        private static string BoundText(string value, int maximum)
        {
            string normalized = (value ?? "").Replace('\0', ' ').Trim();
            return normalized.Length <= maximum ? normalized : normalized.Substring(0, maximum);
        }

        private static int ClampCoordinate(int value)
        {
            return Math.Max(-100000, Math.Min(100000, value));
        }

        private static int ClampSize(int value)
        {
            return Math.Max(0, Math.Min(16384, value));
        }

        private static string Sha256Hex(string value)
        {
            return Sha256Hex(Encoding.UTF8.GetBytes(value ?? ""));
        }

        private static string Sha256Hex(byte[] value)
        {
            using (SHA256 hash = SHA256.Create())
            {
                return BitConverter.ToString(hash.ComputeHash(value)).Replace("-", "").ToLowerInvariant();
            }
        }

        private static bool FixedEquals(string left, string right)
        {
            if (left == null || right == null || left.Length != right.Length) return false;
            int difference = 0;
            for (int index = 0; index < left.Length; index++) difference |= left[index] ^ right[index];
            return difference == 0;
        }

        private static void TryDelete(string path)
        {
            try { if (File.Exists(path)) File.Delete(path); }
            catch { }
        }

        private static void WriteFailure(string resultPath, string code, string message)
        {
            try
            {
                JavaScriptSerializer serializer = new JavaScriptSerializer();
                WriteResult(resultPath, serializer.Serialize(new Dictionary<string, object>
                {
                    { "ok", false },
                    { "error", code },
                    { "message", BoundText(message, 1000) }
                }));
            }
            catch (Exception error)
            {
                Console.Error.WriteLine(SafeMessage(error));
            }
        }

        private static void WriteResult(string resultPath, string json)
        {
            string directory = Path.GetDirectoryName(resultPath);
            if (!String.IsNullOrWhiteSpace(directory)) Directory.CreateDirectory(directory);
            string temporary = resultPath + ".tmp-" + Guid.NewGuid().ToString("N");
            File.WriteAllText(temporary, json, new UTF8Encoding(false));
            if (File.Exists(resultPath)) File.Delete(resultPath);
            File.Move(temporary, resultPath);
        }

        private static string SafeMessage(Exception error)
        {
            return BoundText((error == null ? "Unknown provider failure." : error.Message).Replace("\r", " ").Replace("\n", " "), 1000);
        }
    }

    internal static class NativeMethods
    {
        internal const uint WindowCloseMessage = 0x0010;
        internal const int SystemMetricCaptionHeight = 4;
        internal const int SystemMetricCaptionButtonWidth = 30;
        internal const uint InputMouse = 0;
        internal const uint InputKeyboard = 1;
        internal const uint KeyEventKeyUp = 0x0002;
        internal const uint KeyEventUnicode = 0x0004;
        internal const uint MouseEventLeftDown = 0x0002;
        internal const uint MouseEventLeftUp = 0x0004;
        internal const uint MouseEventRightDown = 0x0008;
        internal const uint MouseEventRightUp = 0x0010;
        internal const uint MouseEventMiddleDown = 0x0020;
        internal const uint MouseEventMiddleUp = 0x0040;
        internal const uint MouseEventWheel = 0x0800;
        internal const uint PrintWindowRenderFullContent = 0x00000002;
        internal const uint GetAncestorRoot = 2;
        internal const uint SetWindowNoSize = 0x0001;
        internal const uint SetWindowNoMove = 0x0002;
        internal const uint SetWindowNoActivate = 0x0010;
        internal const uint SetWindowShow = 0x0040;
        internal const int ShowRestore = 9;
        internal const int SystemMetricCursorWidth = 13;
        internal const int DwmWindowAttributeCloaked = 14;
        internal const uint BitmapCompressionRgb = 0;
        internal const uint DibRgbColors = 0;
        internal static readonly IntPtr WindowTop = IntPtr.Zero;

        internal delegate bool EnumWindowsCallback(IntPtr handle, IntPtr parameter);

        [StructLayout(LayoutKind.Sequential)]
        internal struct NativeRect
        {
            internal int Left;
            internal int Top;
            internal int Right;
            internal int Bottom;
        }

        [StructLayout(LayoutKind.Sequential)]
        internal struct NativePoint
        {
            internal int X;
            internal int Y;
        }

        [StructLayout(LayoutKind.Sequential)]
        internal struct NativeSize
        {
            internal int Width;
            internal int Height;
        }

        [StructLayout(LayoutKind.Sequential, Pack = 1)]
        internal struct BlendFunction
        {
            internal byte BlendOp;
            internal byte BlendFlags;
            internal byte SourceConstantAlpha;
            internal byte AlphaFormat;
        }

        [StructLayout(LayoutKind.Sequential)]
        internal struct BitmapInfoHeader
        {
            internal uint Size;
            internal int Width;
            internal int Height;
            internal ushort Planes;
            internal ushort BitCount;
            internal uint Compression;
            internal uint SizeImage;
            internal int XPelsPerMeter;
            internal int YPelsPerMeter;
            internal uint ColorsUsed;
            internal uint ColorsImportant;
        }

        [StructLayout(LayoutKind.Sequential)]
        internal struct BitmapInfo
        {
            internal BitmapInfoHeader Header;
        }

        [StructLayout(LayoutKind.Sequential)]
        internal struct MouseInput
        {
            internal int Dx;
            internal int Dy;
            internal uint MouseData;
            internal uint Flags;
            internal uint Time;
            internal UIntPtr ExtraInfo;
        }

        [StructLayout(LayoutKind.Sequential)]
        internal struct KeyboardInput
        {
            internal ushort VirtualKey;
            internal ushort ScanCode;
            internal uint Flags;
            internal uint Time;
            internal UIntPtr ExtraInfo;
        }

        [StructLayout(LayoutKind.Sequential)]
        internal struct HardwareInput
        {
            internal uint Message;
            internal ushort ParameterLow;
            internal ushort ParameterHigh;
        }

        [StructLayout(LayoutKind.Explicit)]
        internal struct InputUnion
        {
            [FieldOffset(0)] internal MouseInput Mouse;
            [FieldOffset(0)] internal KeyboardInput Keyboard;
            [FieldOffset(0)] internal HardwareInput Hardware;
        }

        [StructLayout(LayoutKind.Sequential)]
        internal struct Input
        {
            internal uint Type;
            internal InputUnion Union;
        }

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool EnumWindows(EnumWindowsCallback callback, IntPtr parameter);

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool IsWindow(IntPtr handle);

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool IsWindowVisible(IntPtr handle);

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool IsIconic(IntPtr handle);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        internal static extern int GetWindowText(IntPtr handle, StringBuilder text, int maximum);

        [DllImport("user32.dll")]
        internal static extern int GetWindowTextLength(IntPtr handle);

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool GetWindowRect(IntPtr handle, out NativeRect bounds);

        [DllImport("user32.dll")]
        internal static extern uint GetWindowThreadProcessId(IntPtr handle, out uint processId);

        [DllImport("user32.dll")]
        internal static extern uint GetWindowThreadProcessId(IntPtr handle, IntPtr processId);

        [DllImport("user32.dll")]
        internal static extern IntPtr GetForegroundWindow();

        [DllImport("dwmapi.dll")]
        internal static extern int DwmGetWindowAttribute(IntPtr handle, int attribute, out int value, int size);

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool SetForegroundWindow(IntPtr handle);

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool BringWindowToTop(IntPtr handle);

        [DllImport("user32.dll")]
        internal static extern IntPtr SetFocus(IntPtr handle);

        [DllImport("user32.dll")]
        internal static extern IntPtr SetActiveWindow(IntPtr handle);

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool ShowWindowAsync(IntPtr handle, int command);

        [DllImport("user32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool SetWindowPos(
            IntPtr handle,
            IntPtr insertAfter,
            int x,
            int y,
            int width,
            int height,
            uint flags);

        [DllImport("kernel32.dll")]
        internal static extern uint GetCurrentThreadId();

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool AttachThreadInput(uint attach, uint attachTo, bool value);

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool SetCursorPos(int x, int y);

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool PostMessage(IntPtr handle, uint message, IntPtr wParam, IntPtr lParam);

        [DllImport("user32.dll")]
        internal static extern uint GetDpiForWindow(IntPtr handle);

        [DllImport("user32.dll")]
        internal static extern int GetSystemMetrics(int index);

        [DllImport("winmm.dll")]
        internal static extern uint timeBeginPeriod(uint periodMilliseconds);

        [DllImport("winmm.dll")]
        internal static extern uint timeEndPeriod(uint periodMilliseconds);

        [DllImport("user32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool UpdateLayeredWindow(
            IntPtr window,
            IntPtr destinationDc,
            ref NativePoint destination,
            ref NativeSize size,
            IntPtr sourceDc,
            ref NativePoint source,
            int colorKey,
            ref BlendFunction blend,
            int flags);

        [DllImport("user32.dll")]
        internal static extern IntPtr GetDC(IntPtr window);

        [DllImport("user32.dll")]
        internal static extern int ReleaseDC(IntPtr window, IntPtr deviceContext);

        [DllImport("gdi32.dll")]
        internal static extern IntPtr CreateCompatibleDC(IntPtr deviceContext);

        [DllImport("gdi32.dll")]
        internal static extern IntPtr CreateDIBSection(
            IntPtr deviceContext,
            ref BitmapInfo bitmapInfo,
            uint usage,
            out IntPtr bits,
            IntPtr section,
            uint offset);

        [DllImport("gdi32.dll")]
        internal static extern IntPtr SelectObject(IntPtr deviceContext, IntPtr value);

        [DllImport("gdi32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool DeleteObject(IntPtr value);

        [DllImport("gdi32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool DeleteDC(IntPtr deviceContext);

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool GetCursorPos(out NativePoint point);

        [DllImport("user32.dll")]
        internal static extern IntPtr WindowFromPoint(NativePoint point);

        [DllImport("user32.dll")]
        internal static extern IntPtr GetAncestor(IntPtr handle, uint flags);

        [DllImport("user32.dll", SetLastError = true)]
        internal static extern uint SendInput(uint count, Input[] inputs, int size);

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool PrintWindow(IntPtr handle, IntPtr deviceContext, uint flags);

        internal static Input UnicodeInput(char value, bool keyUp)
        {
            Input input = new Input();
            input.Type = InputKeyboard;
            input.Union.Keyboard = new KeyboardInput
            {
                VirtualKey = 0,
                ScanCode = value,
                Flags = KeyEventUnicode | (keyUp ? KeyEventKeyUp : 0),
                Time = 0,
                ExtraInfo = UIntPtr.Zero
            };
            return input;
        }

        internal static Input VirtualKeyInput(ushort value, bool keyUp)
        {
            Input input = new Input();
            input.Type = InputKeyboard;
            input.Union.Keyboard = new KeyboardInput
            {
                VirtualKey = value,
                ScanCode = 0,
                Flags = keyUp ? KeyEventKeyUp : 0,
                Time = 0,
                ExtraInfo = UIntPtr.Zero
            };
            return input;
        }

        internal static Dictionary<string, object> BoundsDictionary(Rectangle value)
        {
            return new Dictionary<string, object>
            {
                { "x", value.X },
                { "y", value.Y },
                { "width", value.Width },
                { "height", value.Height }
            };
        }
    }
}
