using System;
using System.Runtime.InteropServices;
using System.Threading;

internal static class MonarchComputerUseCursorMover
{
    [StructLayout(LayoutKind.Sequential)]
    private struct NativePoint
    {
        internal int X;
        internal int Y;
    }

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetCursorPos(out NativePoint point);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetCursorPos(int x, int y);

    private static int Main(string[] args)
    {
        int delayMs = args.Length > 0 ? Int32.Parse(args[0]) : 300;
        int durationMs = args.Length > 1 ? Int32.Parse(args[1]) : 1600;
        NativePoint original;
        if (!GetCursorPos(out original)) return 2;
        Thread.Sleep(Math.Max(0, delayMs));
        DateTime deadline = DateTime.UtcNow.AddMilliseconds(Math.Max(100, durationMs));
        bool alternate = false;
        while (DateTime.UtcNow < deadline)
        {
            alternate = !alternate;
            SetCursorPos(original.X + (alternate ? 32 : -32), original.Y + (alternate ? 18 : -18));
            Thread.Sleep(35);
        }
        SetCursorPos(original.X, original.Y);
        return 0;
    }
}
