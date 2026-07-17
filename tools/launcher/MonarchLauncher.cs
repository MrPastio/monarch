using System;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;

namespace MonarchLauncher
{
    internal static class Program
    {
        [System.Runtime.InteropServices.DllImport("shell32.dll", SetLastError = true)]
        static extern void SetCurrentProcessExplicitAppUserModelID([System.Runtime.InteropServices.MarshalAs(System.Runtime.InteropServices.UnmanagedType.LPWStr)] string AppID);

        [STAThread]
        private static void Main()
        {
            try { SetCurrentProcessExplicitAppUserModelID("Monarch.App"); } catch { }

            var workspaceRoot = ResolveWorkspaceRoot();
            var electronExe = Path.Combine(workspaceRoot, "node_modules", "electron", "dist", "electron.exe");
            var electronMain = Path.Combine(workspaceRoot, "desktop", "electron", "main.mjs");

            if (!File.Exists(electronExe))
            {
                MessageBox.Show(
                    "Electron is not installed. Run npm install, then launch Monarch again.",
                    "Monarch",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error
                );
                return;
            }

            if (!File.Exists(electronMain))
            {
                MessageBox.Show(
                    "Monarch desktop shell is missing: desktop\\electron\\main.mjs",
                    "Monarch",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error
                );
                return;
            }

            try
            {
                var startInfo = new ProcessStartInfo();
                startInfo.FileName = electronExe;
                startInfo.Arguments = Quote(electronMain);
                startInfo.WorkingDirectory = workspaceRoot;
                startInfo.UseShellExecute = false;
                startInfo.EnvironmentVariables["MONARCH_DESKTOP_LAUNCHED_BY"] = "Monarch.exe";

                Process.Start(startInfo);
            }
            catch (Exception error)
            {
                MessageBox.Show(
                    error.Message,
                    "Monarch failed to start",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error
                );
            }
        }

        private static string ResolveWorkspaceRoot()
        {
            var directory = AppDomain.CurrentDomain.BaseDirectory;
            while (!String.IsNullOrEmpty(directory))
            {
                if (File.Exists(Path.Combine(directory, "package.json"))
                    && Directory.Exists(Path.Combine(directory, "src")))
                {
                    return directory.TrimEnd(Path.DirectorySeparatorChar);
                }

                var parent = Directory.GetParent(directory);
                if (parent == null)
                {
                    break;
                }
                directory = parent.FullName;
            }

            return AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);
        }

        private static string Quote(string value)
        {
            return "\"" + value.Replace("\"", "\\\"") + "\"";
        }
    }
}
