using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace MonarchLauncher
{
    internal static class Program
    {
        private const string LauncherVersion = "1.0.0";
        private const int HealthTimeoutSeconds = 120;
        private const int MaximumCandidateAttempts = 2;
        private static readonly JavaScriptSerializer Json = new JavaScriptSerializer();

        [System.Runtime.InteropServices.DllImport("shell32.dll", SetLastError = true)]
        private static extern void SetCurrentProcessExplicitAppUserModelID(
            [System.Runtime.InteropServices.MarshalAs(System.Runtime.InteropServices.UnmanagedType.LPWStr)]
            string appId
        );

        [STAThread]
        private static int Main(string[] args)
        {
            try { SetCurrentProcessExplicitAppUserModelID("Monarch.App"); } catch { }

            try
            {
                if (HasArgument(args, "--self-test"))
                {
                    return SelfTest();
                }

                var installRoot = AppDomain.CurrentDomain.BaseDirectory
                    .TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
                var currentPath = Path.Combine(installRoot, "current.json");
                var layoutPath = Path.Combine(installRoot, "install-layout.json");
                if (!File.Exists(currentPath) || !File.Exists(layoutPath))
                {
                    LaunchDevelopmentWorkspace();
                    return 0;
                }

                var layout = ReadJson(layoutPath);
                RequireInteger(layout, "schemaVersion", 1);
                var transactionsRoot = RequireCanonicalDirectory(
                    RequireString(layout, "transactionsRoot"),
                    RequireString(layout, "payloadRoot")
                );
                var pendingPath = Path.Combine(transactionsRoot, "pending-update.json");
                if (File.Exists(pendingPath))
                {
                    return RunCandidateTrial(installRoot, layout, pendingPath);
                }

                var pointer = ReadJson(currentPath);
                var currentVersion = RequireString(pointer, "currentVersion");
                LaunchVersion(installRoot, layout, currentVersion, null, false);
                return 0;
            }
            catch (Exception error)
            {
                ShowFailure(error.Message);
                return 1;
            }
        }

        private static int SelfTest()
        {
            var executable = Process.GetCurrentProcess().MainModule.FileName;
            if (!File.Exists(executable) || ParseVersion(LauncherVersion) == null)
            {
                return 2;
            }
            return 0;
        }

        private static int RunCandidateTrial(
            string installRoot,
            Dictionary<string, object> layout,
            string pendingPath
        )
        {
            var pending = ReadJson(pendingPath);
            RequireInteger(pending, "schemaVersion", 1);
            var updateId = RequireSafeIdentifier(pending, "updateId");
            var previousVersion = RequireSafeVersion(pending, "previousVersion");
            var candidateVersion = RequireSafeVersion(pending, "candidateVersion");
            var attempts = ReadInteger(pending, "attempts", 0);
            var transactionDirectory = Path.Combine(
                RequireCanonicalDirectory(
                    RequireString(layout, "transactionsRoot"),
                    RequireString(layout, "payloadRoot")
                ),
                updateId
            );
            Directory.CreateDirectory(transactionDirectory);
            var acknowledgementPath = Path.Combine(transactionDirectory, "health-ack.json");

            while (attempts < MaximumCandidateAttempts)
            {
                attempts += 1;
                pending["attempts"] = attempts;
                pending["phase"] = "trial";
                pending["lastAttemptAt"] = DateTimeOffset.UtcNow.ToString("o");
                WriteAtomicJson(pendingPath, pending);

                DeleteIfExists(acknowledgementPath);
                var process = LaunchVersion(
                    installRoot,
                    layout,
                    candidateVersion,
                    "--post-update=" + updateId,
                    true
                );

                if (WaitForAcknowledgement(
                    process,
                    acknowledgementPath,
                    updateId,
                    candidateVersion,
                    TimeSpan.FromSeconds(HealthTimeoutSeconds)
                ))
                {
                    var pointer = ReadJson(Path.Combine(installRoot, "current.json"));
                    pointer["schemaVersion"] = 1;
                    pointer["currentVersion"] = candidateVersion;
                    pointer["previousVersion"] = previousVersion;
                    pointer["updatedAt"] = DateTimeOffset.UtcNow.ToString("o");
                    WriteAtomicJson(Path.Combine(installRoot, "current.json"), pointer);

                    pending["phase"] = "committed";
                    pending["committedAt"] = DateTimeOffset.UtcNow.ToString("o");
                    WriteAtomicJson(pendingPath, pending);
                    return 0;
                }

                StopCandidate(process);
            }

            var rollbackPointer = ReadJson(Path.Combine(installRoot, "current.json"));
            rollbackPointer["schemaVersion"] = 1;
            rollbackPointer["currentVersion"] = previousVersion;
            rollbackPointer["previousVersion"] = candidateVersion;
            rollbackPointer["updatedAt"] = DateTimeOffset.UtcNow.ToString("o");
            WriteAtomicJson(Path.Combine(installRoot, "current.json"), rollbackPointer);
            pending["phase"] = "rollback-required";
            pending["rolledBackAt"] = DateTimeOffset.UtcNow.ToString("o");
            WriteAtomicJson(pendingPath, pending);

            LaunchVersion(
                installRoot,
                layout,
                previousVersion,
                "--rollback-update=" + updateId,
                false
            );
            return 0;
        }

        private static Process LaunchVersion(
            string installRoot,
            Dictionary<string, object> layout,
            string version,
            string extraArgument,
            bool trackProcess
        )
        {
            var safeVersion = RequireSafeVersion(version);
            var versionsRoot = Path.GetFullPath(Path.Combine(installRoot, "versions"));
            var versionRoot = RequireCanonicalDirectory(
                Path.Combine(versionsRoot, safeVersion),
                versionsRoot
            );
            var descriptorPath = Path.Combine(versionRoot, "version.json");
            if (!File.Exists(descriptorPath))
            {
                throw new InvalidDataException("Installed version descriptor is missing.");
            }

            var descriptor = ReadJson(descriptorPath);
            RequireInteger(descriptor, "descriptorVersion", 1);
            RequireInteger(descriptor, "layoutSchemaVersion", 1);
            if (!String.Equals(
                RequireSafeVersion(descriptor, "appVersion"),
                safeVersion,
                StringComparison.Ordinal
            ))
            {
                throw new InvalidDataException("Installed version descriptor does not match its directory.");
            }
            if (CompareVersions(LauncherVersion, RequireSafeVersion(descriptor, "minimumLauncherVersion")) < 0)
            {
                throw new InvalidDataException("This Monarch version requires a newer bootstrap launcher.");
            }

            ValidatePayloadComponent(
                RequireString(layout, "payloadRoot"),
                Path.Combine(
                    RequireString(layout, "payloadRoot"),
                    "runtimes",
                    "runtime-" + RequireSafeIdentifier(descriptor, "runtimeVersion")
                )
            );
            ValidatePayloadComponent(
                RequireString(layout, "payloadRoot"),
                Path.Combine(
                    RequireString(layout, "payloadRoot"),
                    "environments",
                    RequireSafeIdentifier(descriptor, "backendEnvironment")
                )
            );
            ValidateReadableDataSchema(installRoot, descriptor);

            var electronExe = Path.Combine(versionRoot, "node_modules", "electron", "dist", "electron.exe");
            var electronMain = Path.Combine(versionRoot, "desktop", "electron", "main.mjs");
            if (!File.Exists(electronExe))
            {
                throw new FileNotFoundException("Electron runtime is missing.", electronExe);
            }
            if (!File.Exists(electronMain))
            {
                throw new FileNotFoundException("Monarch desktop entrypoint is missing.", electronMain);
            }

            var startInfo = new ProcessStartInfo();
            startInfo.FileName = electronExe;
            startInfo.Arguments = Quote(electronMain)
                + (String.IsNullOrEmpty(extraArgument) ? "" : " " + Quote(extraArgument));
            startInfo.WorkingDirectory = versionRoot;
            startInfo.UseShellExecute = false;
            startInfo.EnvironmentVariables["MONARCH_DESKTOP_LAUNCHED_BY"] = "Monarch.exe";
            startInfo.EnvironmentVariables["MONARCH_INSTALL_ROOT"] = installRoot;
            startInfo.EnvironmentVariables["MONARCH_VERSION_ROOT"] = versionRoot;
            startInfo.EnvironmentVariables["MONARCH_PAYLOAD_ROOT"] = RequireString(layout, "payloadRoot");
            startInfo.EnvironmentVariables["MONARCH_TRANSACTION_ROOT"] = RequireString(layout, "transactionsRoot");
            startInfo.EnvironmentVariables["MONARCH_CONFIG_ROOT"] = RequireString(layout, "configRoot");
            startInfo.EnvironmentVariables["MONARCH_DATA_ROOT"] = RequireString(layout, "dataRoot");
            startInfo.EnvironmentVariables["MONARCH_LOGS_ROOT"] = RequireString(layout, "logsRoot");
            var process = Process.Start(startInfo);
            if (process == null)
            {
                throw new InvalidOperationException("Windows did not start Monarch.");
            }
            return trackProcess ? process : null;
        }

        private static bool WaitForAcknowledgement(
            Process process,
            string acknowledgementPath,
            string updateId,
            string candidateVersion,
            TimeSpan timeout
        )
        {
            var deadline = DateTime.UtcNow.Add(timeout);
            while (DateTime.UtcNow < deadline)
            {
                if (File.Exists(acknowledgementPath))
                {
                    try
                    {
                        var acknowledgement = ReadJson(acknowledgementPath);
                        if (String.Equals(
                                RequireString(acknowledgement, "updateId"),
                                updateId,
                                StringComparison.Ordinal
                            )
                            && String.Equals(
                                RequireString(acknowledgement, "appVersion"),
                                candidateVersion,
                                StringComparison.Ordinal
                            )
                            && String.Equals(
                                RequireString(acknowledgement, "status"),
                                "healthy",
                                StringComparison.Ordinal
                            ))
                        {
                            return true;
                        }
                    }
                    catch
                    {
                        // A partially written or malformed acknowledgement is never accepted.
                    }
                }
                if (process != null && process.HasExited)
                {
                    return false;
                }
                Thread.Sleep(250);
            }
            return false;
        }

        private static void StopCandidate(Process process)
        {
            if (process == null || process.HasExited)
            {
                return;
            }
            try
            {
                process.CloseMainWindow();
                if (process.WaitForExit(5000))
                {
                    return;
                }
                var taskkill = new ProcessStartInfo();
                taskkill.FileName = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.System),
                    "taskkill.exe"
                );
                taskkill.Arguments = "/PID " + process.Id + " /T /F";
                taskkill.CreateNoWindow = true;
                taskkill.UseShellExecute = false;
                var cleanup = Process.Start(taskkill);
                if (cleanup != null) cleanup.WaitForExit(10000);
            }
            catch
            {
                // Rollback still proceeds; the previous app uses the transaction lock.
            }
        }

        private static void ValidatePayloadComponent(string payloadRoot, string componentPath)
        {
            var canonical = RequireCanonicalDirectory(componentPath, payloadRoot);
            if (!Directory.Exists(canonical))
            {
                throw new DirectoryNotFoundException("A versioned Monarch runtime component is missing.");
            }
        }

        private static void ValidateReadableDataSchema(
            string installRoot,
            Dictionary<string, object> descriptor
        )
        {
            var schemaPath = Path.Combine(installRoot, "data-schema.json");
            if (!File.Exists(schemaPath))
            {
                return;
            }
            var schema = ReadJson(schemaPath);
            var active = ReadInteger(schema, "dataSchemaVersion", -1);
            var minimum = ReadInteger(descriptor, "minimumReadableDataSchema", -1);
            var maximum = ReadInteger(descriptor, "maximumReadableDataSchema", -1);
            if (active < minimum || active > maximum)
            {
                throw new InvalidDataException("The active data schema is not readable by this Monarch version.");
            }
        }

        private static void LaunchDevelopmentWorkspace()
        {
            var workspaceRoot = ResolveDevelopmentWorkspace();
            var electronExe = Path.Combine(workspaceRoot, "node_modules", "electron", "dist", "electron.exe");
            var electronMain = Path.Combine(workspaceRoot, "desktop", "electron", "main.mjs");
            if (!File.Exists(electronExe) || !File.Exists(electronMain))
            {
                throw new FileNotFoundException(
                    "Monarch installation is incomplete. Run the repair installer."
                );
            }
            var startInfo = new ProcessStartInfo();
            startInfo.FileName = electronExe;
            startInfo.Arguments = Quote(electronMain);
            startInfo.WorkingDirectory = workspaceRoot;
            startInfo.UseShellExecute = false;
            startInfo.EnvironmentVariables["MONARCH_DESKTOP_LAUNCHED_BY"] = "Monarch.exe";
            Process.Start(startInfo);
        }

        private static string ResolveDevelopmentWorkspace()
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
                if (parent == null) break;
                directory = parent.FullName;
            }
            return AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);
        }

        private static Dictionary<string, object> ReadJson(string path)
        {
            var text = File.ReadAllText(path);
            var value = Json.DeserializeObject(text) as Dictionary<string, object>;
            if (value == null)
            {
                throw new InvalidDataException(Path.GetFileName(path) + " must contain a JSON object.");
            }
            return value;
        }

        private static void WriteAtomicJson(string path, Dictionary<string, object> value)
        {
            var directory = Path.GetDirectoryName(path);
            Directory.CreateDirectory(directory);
            var temporary = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
            File.WriteAllText(temporary, Json.Serialize(value), new System.Text.UTF8Encoding(false));
            if (File.Exists(path))
            {
                var backup = path + ".previous";
                DeleteIfExists(backup);
                File.Replace(temporary, path, backup, true);
                DeleteIfExists(backup);
            }
            else
            {
                File.Move(temporary, path);
            }
        }

        private static string RequireCanonicalDirectory(string candidate, string root)
        {
            var fullRoot = Path.GetFullPath(root).TrimEnd(
                Path.DirectorySeparatorChar,
                Path.AltDirectorySeparatorChar
            );
            var fullCandidate = Path.GetFullPath(candidate).TrimEnd(
                Path.DirectorySeparatorChar,
                Path.AltDirectorySeparatorChar
            );
            if (!fullCandidate.Equals(fullRoot, StringComparison.OrdinalIgnoreCase)
                && !fullCandidate.StartsWith(
                    fullRoot + Path.DirectorySeparatorChar,
                    StringComparison.OrdinalIgnoreCase
                ))
            {
                throw new InvalidDataException("A Monarch path escaped its trusted root.");
            }
            return fullCandidate;
        }

        private static string RequireString(Dictionary<string, object> value, string key)
        {
            object result;
            if (!value.TryGetValue(key, out result) || !(result is string) || String.IsNullOrWhiteSpace((string)result))
            {
                throw new InvalidDataException("Missing or invalid " + key + ".");
            }
            return (string)result;
        }

        private static string RequireSafeIdentifier(Dictionary<string, object> value, string key)
        {
            return RequireSafeIdentifier(RequireString(value, key));
        }

        private static string RequireSafeIdentifier(string value)
        {
            foreach (var character in value)
            {
                if (!(Char.IsLetterOrDigit(character) || character == '.' || character == '-' || character == '_'))
                {
                    throw new InvalidDataException("Unsafe Monarch identifier.");
                }
            }
            return value;
        }

        private static string RequireSafeVersion(Dictionary<string, object> value, string key)
        {
            return RequireSafeVersion(RequireString(value, key));
        }

        private static string RequireSafeVersion(string value)
        {
            if (ParseVersion(value) == null)
            {
                throw new InvalidDataException("Invalid Monarch version.");
            }
            return value;
        }

        private static int ReadInteger(Dictionary<string, object> value, string key, int fallback)
        {
            object result;
            if (!value.TryGetValue(key, out result))
            {
                return fallback;
            }
            if (result is int) return (int)result;
            if (result is long && (long)result <= Int32.MaxValue) return (int)(long)result;
            return fallback;
        }

        private static void RequireInteger(Dictionary<string, object> value, string key, int expected)
        {
            if (ReadInteger(value, key, Int32.MinValue) != expected)
            {
                throw new InvalidDataException("Unsupported " + key + ".");
            }
        }

        private static int[] ParseVersion(string value)
        {
            var parts = value.Split('.');
            if (parts.Length != 3) return null;
            var result = new int[3];
            for (var index = 0; index < parts.Length; index += 1)
            {
                if (!Int32.TryParse(parts[index], out result[index]) || result[index] < 0)
                {
                    return null;
                }
            }
            return result;
        }

        private static int CompareVersions(string left, string right)
        {
            var a = ParseVersion(left);
            var b = ParseVersion(right);
            if (a == null || b == null) throw new InvalidDataException("Invalid version comparison.");
            for (var index = 0; index < 3; index += 1)
            {
                if (a[index] != b[index]) return a[index].CompareTo(b[index]);
            }
            return 0;
        }

        private static bool HasArgument(string[] args, string expected)
        {
            foreach (var argument in args)
            {
                if (String.Equals(argument, expected, StringComparison.OrdinalIgnoreCase))
                {
                    return true;
                }
            }
            return false;
        }

        private static void DeleteIfExists(string path)
        {
            try
            {
                if (File.Exists(path)) File.Delete(path);
            }
            catch
            {
                // A backup is best-effort; the primary transactional file remains intact.
            }
        }

        private static string Quote(string value)
        {
            return "\"" + value.Replace("\"", "\\\"") + "\"";
        }

        private static void ShowFailure(string message)
        {
            MessageBox.Show(
                message,
                "Monarch failed to start",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error
            );
        }
    }
}
