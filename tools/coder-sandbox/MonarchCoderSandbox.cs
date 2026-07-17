using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

internal sealed class BrokerRequest
{
    public string projectRoot { get; set; }
    public string hostProjectRoot { get; set; }
    public string executable { get; set; }
    public string[] arguments { get; set; }
    public string workingDirectory { get; set; }
    public int timeoutMs { get; set; }
    public int maxOutputBytes { get; set; }
    public bool allowNetwork { get; set; }
    public string identity { get; set; }
    public string jobDirectory { get; set; }
    public string[] readOnlyPaths { get; set; }
    public string isolationKind { get; set; }
}

internal sealed class IsolationResult
{
    public string kind { get; set; }
    public bool verified { get; set; }
    public bool appContainer { get; set; }
    public bool lowIntegrity { get; set; }
    public bool projectReadWrite { get; set; }
    public bool hostFilesystemDefaultDeny { get; set; }
    public bool networkAllowed { get; set; }
}

internal sealed class BrokerResult
{
    public int? exitCode { get; set; }
    public string stdout { get; set; }
    public string stderr { get; set; }
    public bool timedOut { get; set; }
    public bool truncated { get; set; }
    public long durationMs { get; set; }
    public string error { get; set; }
    public IsolationResult isolation { get; set; }
}

internal sealed class BoundedReadResult
{
    public string Text;
    public bool Truncated;
}

internal sealed class BoundedOutputCollector
{
    private readonly object sync = new object();
    private readonly MemoryStream retained = new MemoryStream();
    private readonly int maxBytes;
    private bool truncated;

    public BoundedOutputCollector(int maxBytes)
    {
        this.maxBytes = maxBytes;
    }

    public void Drain(Stream stream)
    {
        byte[] buffer = new byte[8192];
        int read;
        while ((read = stream.Read(buffer, 0, buffer.Length)) > 0)
        {
            lock (sync)
            {
                int remaining = maxBytes - (int)retained.Length;
                if (remaining > 0) retained.Write(buffer, 0, Math.Min(read, remaining));
                if (read > remaining) truncated = true;
            }
        }
    }

    public BoundedReadResult Snapshot()
    {
        lock (sync)
        {
            return new BoundedReadResult
            {
                Text = Encoding.UTF8.GetString(retained.ToArray()),
                Truncated = truncated,
            };
        }
    }
}

internal static class Program
{
    private const uint CREATE_NO_WINDOW = 0x08000000;
    private const uint CREATE_SUSPENDED = 0x00000004;
    private const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
    private const uint WAIT_OBJECT_0 = 0x00000000;
    private const uint WAIT_TIMEOUT = 0x00000102;
    private const int TokenIsAppContainer = 29;
    private const int TokenIntegrityLevel = 25;
    private const uint TOKEN_QUERY = 0x0008;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    private const int JobObjectExtendedLimitInformation = 9;
    private static readonly IntPtr PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES = new IntPtr(0x00020009);
    private const ulong UI_RESTRICTIONS = 0x0001UL | 0x0002UL | 0x0004UL | 0x0008UL | 0x0010UL | 0x0020UL | 0x0040UL | 0x0080UL;
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 4 * 1024 * 1024 };

    [UnmanagedFunctionPointer(CallingConvention.Winapi, CharSet = CharSet.Unicode, SetLastError = true)]
    private delegate bool CreateProcessInSandboxDelegate(
        string applicationName,
        StringBuilder commandLine,
        IntPtr processAttributes,
        IntPtr threadAttributes,
        bool inheritHandles,
        uint creationFlags,
        IntPtr environment,
        string currentDirectory,
        ref STARTUPINFO startupInfo,
        string identity,
        byte[] sandboxSpecification,
        uint sandboxSpecificationSize,
        out PROCESS_INFORMATION processInformation);

    public static int Main(string[] args)
    {
        try
        {
            if (args.Length == 2 && args[0] == "grant-read")
            {
                GrantDirectoryAccess(Path.GetFullPath(args[1]), new SecurityIdentifier("S-1-15-2-1"), false, true);
                Console.WriteLine("{\"ok\":true,\"sid\":\"S-1-15-2-1\"}");
                return 0;
            }
            bool brokerMode = args.Length == 3 && (args[0] == "host" || args[0] == "worker");
            bool targetMode = args.Length == 4 && args[0] == "target";
            if (!brokerMode && !targetMode)
            {
                Console.Error.WriteLine("Usage: MonarchCoderSandbox.exe host|worker <request.json> <result.json>");
                return 64;
            }
            if (args[0] == "host") return RunHost(args[1], args[2]);
            if (args[0] == "worker") return RunWorker(args[1], args[2]);
            return RunTarget(args[1], args[2], args[3]);
        }
        catch (Exception error)
        {
            TryWriteFailure(args.Length > 2 ? args[2] : null, "broker-failed: " + error.Message);
            Console.Error.WriteLine(error.ToString());
            return 70;
        }
    }

    private static int RunHost(string requestPath, string resultPath)
    {
        BrokerRequest request = LoadAndValidateRequest(requestPath, resultPath);
        string self = Path.GetFullPath(Process.GetCurrentProcess().MainModule.FileName);
        List<string> readOnly = new List<string>();
        readOnly.Add(Path.GetDirectoryName(self));
        string executableDirectory = Path.GetDirectoryName(request.executable);
        if (!IsWithin(executableDirectory, request.hostProjectRoot)) readOnly.Add(executableDirectory);
        if (request.readOnlyPaths != null)
        {
            foreach (string entry in request.readOnlyPaths)
            {
                if (!String.IsNullOrWhiteSpace(entry)) readOnly.Add(Path.GetFullPath(entry));
            }
        }

        string[] readOnlyPaths = UniquePaths(readOnly);
        string workerArguments = "worker " + QuoteArgument(Path.GetFullPath(requestPath)) + " " + QuoteArgument(Path.GetFullPath(resultPath));
        StringBuilder commandLine = new StringBuilder(QuoteArgument(self) + " " + workerArguments);
        PROCESS_INFORMATION process;
        int experimentalError;
        request.isolationKind = "windows-appcontainer-bfs";
        File.WriteAllText(requestPath, Json.Serialize(request), new UTF8Encoding(false));
        if (!TryLaunchExperimental(request, self, commandLine, readOnlyPaths, out process, out experimentalError))
        {
            if (experimentalError != 120 && experimentalError != 50 && experimentalError != 126)
                throw new InvalidOperationException("AppContainer BFS launch failed with Win32 error " + experimentalError + ".");
            request.isolationKind = "windows-appcontainer-acl";
            File.WriteAllText(requestPath, Json.Serialize(request), new UTF8Encoding(false));
            commandLine = new StringBuilder(QuoteArgument(self) + " " + workerArguments);
            process = LaunchStableAppContainer(request, self, commandLine, readOnlyPaths);
        }
        return StartAndWaitForWorker(request, resultPath, process);
    }

    private static bool TryLaunchExperimental(
        BrokerRequest request,
        string self,
        StringBuilder commandLine,
        string[] readOnlyPaths,
        out PROCESS_INFORMATION process,
        out int error)
    {
        process = new PROCESS_INFORMATION();
        error = 0;
        byte[] specification = SandboxSpecBuilder.Build(
            new[] { request.projectRoot, request.hostProjectRoot, request.jobDirectory },
            readOnlyPaths,
            request.allowNetwork,
            UI_RESTRICTIONS);
        IntPtr library = LoadLibraryEx("processmodel.dll", IntPtr.Zero, 0x00000800);
        if (library == IntPtr.Zero) { error = Marshal.GetLastWin32Error(); return false; }
        try
        {
            IntPtr address = GetProcAddress(library, "Experimental_CreateProcessInSandbox");
            if (address == IntPtr.Zero) { error = 120; return false; }
            CreateProcessInSandboxDelegate create = (CreateProcessInSandboxDelegate)Marshal.GetDelegateForFunctionPointer(
                address,
                typeof(CreateProcessInSandboxDelegate));
            STARTUPINFO startup = new STARTUPINFO();
            startup.cb = Marshal.SizeOf(typeof(STARTUPINFO));
            bool created = create(
                self,
                commandLine,
                IntPtr.Zero,
                IntPtr.Zero,
                false,
                CREATE_NO_WINDOW | CREATE_SUSPENDED,
                IntPtr.Zero,
                request.workingDirectory,
                ref startup,
                request.identity,
                specification,
                (uint)specification.Length,
                out process);
            if (!created)
            {
                error = Marshal.GetLastWin32Error();
                return false;
            }
            return true;
        }
        finally
        {
            FreeLibrary(library);
        }
    }

    private static PROCESS_INFORMATION LaunchStableAppContainer(
        BrokerRequest request,
        string self,
        StringBuilder commandLine,
        string[] readOnlyPaths)
    {
        IntPtr appContainerSid = IntPtr.Zero;
        IntPtr capabilitySid = IntPtr.Zero;
        IntPtr capabilitiesArray = IntPtr.Zero;
        IntPtr securityCapabilitiesPointer = IntPtr.Zero;
        IntPtr attributeList = IntPtr.Zero;
        try
        {
            int profileResult = CreateAppContainerProfile(
                request.identity,
                "Monarch Coder Sandbox",
                "Project-scoped Monarch Coder command isolation",
                IntPtr.Zero,
                0,
                out appContainerSid);
            if (profileResult != 0)
            {
                const int AlreadyExists = unchecked((int)0x800700B7);
                if (profileResult != AlreadyExists || DeriveAppContainerSidFromAppContainerName(request.identity, out appContainerSid) != 0)
                    throw new InvalidOperationException("AppContainer profile creation failed with HRESULT 0x" + profileResult.ToString("X8") + ".");
            }

            SecurityIdentifier sid = new SecurityIdentifier(appContainerSid);
            GrantDirectoryAccess(request.hostProjectRoot, sid, true, true);
            GrantDirectoryAccess(request.jobDirectory, sid, true, true);
            AssertSharedReadAccess(Path.GetDirectoryName(self));
            foreach (string readOnlyPath in readOnlyPaths) AssertSharedReadAccess(readOnlyPath);

            SECURITY_CAPABILITIES securityCapabilities = new SECURITY_CAPABILITIES();
            securityCapabilities.AppContainerSid = appContainerSid;
            if (request.allowNetwork)
            {
                if (!ConvertStringSidToSid("S-1-15-3-1", out capabilitySid))
                    throw new InvalidOperationException("internetClient capability SID could not be created.");
                SID_AND_ATTRIBUTES capability = new SID_AND_ATTRIBUTES { Sid = capabilitySid, Attributes = 0x00000004 };
                capabilitiesArray = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(SID_AND_ATTRIBUTES)));
                Marshal.StructureToPtr(capability, capabilitiesArray, false);
                securityCapabilities.Capabilities = capabilitiesArray;
                securityCapabilities.CapabilityCount = 1;
            }
            securityCapabilitiesPointer = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(SECURITY_CAPABILITIES)));
            Marshal.StructureToPtr(securityCapabilities, securityCapabilitiesPointer, false);

            IntPtr attributeListSize = IntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref attributeListSize);
            attributeList = Marshal.AllocHGlobal(attributeListSize);
            if (!InitializeProcThreadAttributeList(attributeList, 1, 0, ref attributeListSize))
                throw new InvalidOperationException("AppContainer attribute list initialization failed with Win32 error " + Marshal.GetLastWin32Error() + ".");
            if (!UpdateProcThreadAttribute(
                attributeList,
                0,
                PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES,
                securityCapabilitiesPointer,
                new IntPtr(Marshal.SizeOf(typeof(SECURITY_CAPABILITIES))),
                IntPtr.Zero,
                IntPtr.Zero))
                throw new InvalidOperationException("AppContainer security capabilities could not be applied: " + Marshal.GetLastWin32Error() + ".");

            STARTUPINFOEX startup = new STARTUPINFOEX();
            startup.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX));
            startup.lpAttributeList = attributeList;
            PROCESS_INFORMATION process;
            if (!CreateProcess(
                self,
                commandLine,
                IntPtr.Zero,
                IntPtr.Zero,
                false,
                EXTENDED_STARTUPINFO_PRESENT | CREATE_NO_WINDOW | CREATE_SUSPENDED,
                IntPtr.Zero,
                request.workingDirectory,
                ref startup,
                out process))
                throw new InvalidOperationException("Stable AppContainer launch failed with Win32 error " + Marshal.GetLastWin32Error() + ".");
            return process;
        }
        finally
        {
            if (attributeList != IntPtr.Zero) { DeleteProcThreadAttributeList(attributeList); Marshal.FreeHGlobal(attributeList); }
            if (securityCapabilitiesPointer != IntPtr.Zero) Marshal.FreeHGlobal(securityCapabilitiesPointer);
            if (capabilitiesArray != IntPtr.Zero) Marshal.FreeHGlobal(capabilitiesArray);
            if (capabilitySid != IntPtr.Zero) LocalFree(capabilitySid);
            if (appContainerSid != IntPtr.Zero) FreeSid(appContainerSid);
        }
    }

    private static int StartAndWaitForWorker(BrokerRequest request, string resultPath, PROCESS_INFORMATION process)
    {
        IntPtr workerJob = IntPtr.Zero;
        bool waitOwnsProcessHandles = false;
        try
        {
            workerJob = CreateKillOnCloseJob();
            if (!AssignProcessToJobObject(workerJob, process.hProcess))
                throw new InvalidOperationException("Sandbox worker could not be assigned to the host job before startup.");
            if (ResumeThread(process.hThread) == UInt32.MaxValue)
                throw new InvalidOperationException("Sandbox worker could not be resumed after job assignment.");
            waitOwnsProcessHandles = true;
            return WaitForWorker(request, resultPath, process);
        }
        catch
        {
            if (!waitOwnsProcessHandles)
            {
                TerminateProcess(process.hProcess, 70);
                CloseHandle(process.hThread);
                CloseHandle(process.hProcess);
            }
            throw;
        }
        finally
        {
            if (workerJob != IntPtr.Zero) CloseHandle(workerJob);
        }
    }

    private static int WaitForWorker(BrokerRequest request, string resultPath, PROCESS_INFORMATION process)
    {
        try
        {
            uint wait = WaitForSingleObject(process.hProcess, (uint)Math.Min(Int32.MaxValue, request.timeoutMs + 15000));
            if (wait == WAIT_TIMEOUT)
            {
                TerminateProcess(process.hProcess, 124);
                TryWriteFailure(resultPath, "sandbox-worker-timeout");
                return 124;
            }
            if (wait != WAIT_OBJECT_0)
            {
                TryWriteFailure(resultPath, "sandbox-worker-wait-failed");
                return 70;
            }
            uint exitCode;
            if (!GetExitCodeProcess(process.hProcess, out exitCode)) exitCode = 70;
            if (!File.Exists(resultPath))
            {
                TryWriteFailure(resultPath, "sandbox-worker-produced-no-result");
                return 70;
            }
            return unchecked((int)exitCode);
        }
        finally
        {
            CloseHandle(process.hThread);
            CloseHandle(process.hProcess);
        }
    }

    private static void GrantDirectoryAccess(string directory, SecurityIdentifier sid, bool writable, bool required)
    {
        if (String.IsNullOrWhiteSpace(directory) || !Directory.Exists(directory)) return;
        try
        {
            DirectorySecurity security = Directory.GetAccessControl(directory, AccessControlSections.Access);
            FileSystemRights rights = writable
                ? FileSystemRights.Modify | FileSystemRights.Synchronize
                : FileSystemRights.ReadAndExecute | FileSystemRights.Synchronize;
            AuthorizationRuleCollection existingRules = security.GetAccessRules(true, true, typeof(SecurityIdentifier));
            foreach (FileSystemAccessRule existing in existingRules)
            {
                if (
                    existing.AccessControlType == AccessControlType.Allow
                    && sid.Equals(existing.IdentityReference)
                    && (existing.FileSystemRights & rights) == rights
                    && (existing.InheritanceFlags & (InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit))
                        == (InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit)
                ) return;
            }
            FileSystemAccessRule rule = new FileSystemAccessRule(
                sid,
                rights,
                InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit,
                PropagationFlags.None,
                AccessControlType.Allow);
            security.AddAccessRule(rule);
            Directory.SetAccessControl(directory, security);
        }
        catch (Exception error)
        {
            if (required) throw new InvalidOperationException("AppContainer ACL grant failed for '" + directory + "': " + error.Message, error);
        }
    }

    private static void GrantAncestorTraverse(string directory, SecurityIdentifier sid)
    {
        DirectoryInfo current = Directory.GetParent(Path.GetFullPath(directory));
        while (current != null)
        {
            try
            {
                DirectorySecurity security = current.GetAccessControl(AccessControlSections.Access);
                AuthorizationRuleCollection existingRules = security.GetAccessRules(true, true, typeof(SecurityIdentifier));
                bool alreadyGranted = false;
                foreach (FileSystemAccessRule existing in existingRules)
                {
                    if (
                        existing.AccessControlType == AccessControlType.Allow
                        && sid.Equals(existing.IdentityReference)
                        && (existing.FileSystemRights & (FileSystemRights.Traverse | FileSystemRights.ReadAttributes | FileSystemRights.Synchronize))
                            == (FileSystemRights.Traverse | FileSystemRights.ReadAttributes | FileSystemRights.Synchronize)
                        && existing.InheritanceFlags == InheritanceFlags.None
                    )
                    {
                        alreadyGranted = true;
                        break;
                    }
                }
                if (alreadyGranted) { current = current.Parent; continue; }
                FileSystemAccessRule rule = new FileSystemAccessRule(
                    sid,
                    FileSystemRights.Traverse | FileSystemRights.ReadAttributes | FileSystemRights.ReadPermissions | FileSystemRights.Synchronize,
                    InheritanceFlags.None,
                    PropagationFlags.None,
                    AccessControlType.Allow);
                security.AddAccessRule(rule);
                current.SetAccessControl(security);
            }
            catch
            {
                // System and drive roots normally already grant traversal. Never weaken or take ownership to alter them.
            }
            current = current.Parent;
        }
    }

    private static void AssertSharedReadAccess(string directory)
    {
        if (String.IsNullOrWhiteSpace(directory) || !Directory.Exists(directory)) return;
        SecurityIdentifier sid = new SecurityIdentifier("S-1-15-2-1");
        DirectorySecurity security = Directory.GetAccessControl(directory, AccessControlSections.Access);
        AuthorizationRuleCollection rules = security.GetAccessRules(true, true, typeof(SecurityIdentifier));
        foreach (FileSystemAccessRule rule in rules)
        {
            if (
                rule.AccessControlType == AccessControlType.Allow
                && sid.Equals(rule.IdentityReference)
                && (rule.FileSystemRights & FileSystemRights.ReadAndExecute) == FileSystemRights.ReadAndExecute
            ) return;
        }
        throw new InvalidOperationException("Sandbox tool runtime lacks the shared read-only AppContainer ACL: " + directory);
    }

    private static int RunWorker(string requestPath, string resultPath)
    {
        BrokerRequest request = LoadAndValidateRequest(requestPath, resultPath);
        bool appContainer = IsCurrentProcessAppContainer();
        bool lowIntegrity = IsCurrentProcessLowIntegrity();
        if (!appContainer || !lowIntegrity)
        {
            throw new InvalidOperationException("Worker refused to execute outside a verified low-integrity AppContainer.");
        }

        Stopwatch stopwatch = Stopwatch.StartNew();
        IntPtr job = CreateKillOnCloseJob();
        Process targetHost = null;
        string targetResultPath = Path.Combine(request.jobDirectory, "target-result.json");
        string targetSignalPath = Path.Combine(request.jobDirectory, "target-start.signal");
        string targetCompletionPath = targetSignalPath + ".complete";
        try
        {
            string self = Path.GetFullPath(Process.GetCurrentProcess().MainModule.FileName);
            ProcessStartInfo start = new ProcessStartInfo
            {
                FileName = self,
                Arguments = "target " + QuoteArgument(Path.GetFullPath(requestPath)) + " "
                    + QuoteArgument(targetResultPath) + " " + QuoteArgument(targetSignalPath),
                WorkingDirectory = request.workingDirectory,
                UseShellExecute = false,
                CreateNoWindow = true,
            };
            targetHost = new Process { StartInfo = start };
            if (!targetHost.Start()) throw new InvalidOperationException("Sandbox target host did not start.");
            if (!AssignProcessToJobObject(job, targetHost.Handle))
            {
                try { targetHost.Kill(); } catch { }
                throw new InvalidOperationException("Sandbox target host could not be assigned to the child job.");
            }
            File.WriteAllText(targetSignalPath, "assigned", new UTF8Encoding(false));

            Stopwatch targetWait = Stopwatch.StartNew();
            while (!File.Exists(targetCompletionPath) && !targetHost.HasExited && targetWait.ElapsedMilliseconds <= request.timeoutMs + 15000)
                System.Threading.Thread.Sleep(10);
            bool completed = File.Exists(targetCompletionPath);
            if (!completed)
            {
                TerminateJobObject(job, 124);
                targetHost.WaitForExit(5000);
                throw new InvalidOperationException(targetHost.HasExited
                    ? "Sandbox target host exited before producing a completion receipt."
                    : "Sandbox target host timed out.");
            }
            if (!File.Exists(targetResultPath)) throw new InvalidOperationException("Sandbox target host produced no result.");
            BrokerResult result = Json.Deserialize<BrokerResult>(File.ReadAllText(targetResultPath, Encoding.UTF8));
            if (result == null) throw new InvalidOperationException("Sandbox target result is invalid.");
            TerminateJobObject(job, result.timedOut ? 124u : 0u);
            targetHost.WaitForExit(5000);
            stopwatch.Stop();
            result.durationMs = Math.Max(result.durationMs, stopwatch.ElapsedMilliseconds);
            WriteResult(resultPath, result);
            return result.exitCode.HasValue ? result.exitCode.Value : (result.timedOut ? 124 : 70);
        }
        finally
        {
            if (job != IntPtr.Zero)
            {
                TerminateJobObject(job, 125);
                CloseHandle(job);
            }
            if (targetHost != null) targetHost.Dispose();
        }
    }

    private static int RunTarget(string requestPath, string resultPath, string signalPath)
    {
        BrokerRequest request = LoadAndValidateRequest(requestPath, resultPath);
        EnsureWithin(Path.GetFullPath(signalPath), request.jobDirectory, "target signal");
        string completionPath = Path.GetFullPath(signalPath) + ".complete";
        EnsureWithin(completionPath, request.jobDirectory, "target completion signal");
        if (!IsCurrentProcessAppContainer() || !IsCurrentProcessLowIntegrity())
            throw new InvalidOperationException("Target host refused to execute outside a verified low-integrity AppContainer.");

        Stopwatch signalWait = Stopwatch.StartNew();
        while (!File.Exists(signalPath))
        {
            if (signalWait.ElapsedMilliseconds > 10000)
                throw new InvalidOperationException("Target host did not receive an assigned-job signal.");
            System.Threading.Thread.Sleep(10);
        }

        Stopwatch stopwatch = Stopwatch.StartNew();
        Process process = null;
        try
        {
            ProcessStartInfo start = BuildTargetStartInfo(request);
            process = new Process { StartInfo = start };
            if (!process.Start()) throw new InvalidOperationException("Target process did not start.");
            if (start.RedirectStandardInput) process.StandardInput.Close();

            BoundedOutputCollector stdoutCollector = new BoundedOutputCollector(request.maxOutputBytes);
            BoundedOutputCollector stderrCollector = new BoundedOutputCollector(request.maxOutputBytes);
            Task stdoutTask = Task.Factory.StartNew(
                delegate { stdoutCollector.Drain(process.StandardOutput.BaseStream); },
                TaskCreationOptions.LongRunning);
            Task stderrTask = Task.Factory.StartNew(
                delegate { stderrCollector.Drain(process.StandardError.BaseStream); },
                TaskCreationOptions.LongRunning);
            bool exited = process.WaitForExit(request.timeoutMs);
            if (!exited)
            {
                try { process.Kill(); } catch { }
                process.WaitForExit(5000);
            }
            Task.WaitAll(new Task[] { stdoutTask, stderrTask }, 250);
            BoundedReadResult stdout = stdoutCollector.Snapshot();
            BoundedReadResult stderr = stderrCollector.Snapshot();
            if (!stdoutTask.IsCompleted) stdout.Truncated = true;
            if (!stderrTask.IsCompleted) stderr.Truncated = true;
            stopwatch.Stop();
            BrokerResult result = new BrokerResult
            {
                exitCode = exited ? (int?)process.ExitCode : null,
                stdout = stdout.Text,
                stderr = stderr.Text,
                timedOut = !exited,
                truncated = stdout.Truncated || stderr.Truncated,
                durationMs = stopwatch.ElapsedMilliseconds,
                error = null,
                isolation = new IsolationResult
                {
                    kind = String.IsNullOrWhiteSpace(request.isolationKind) ? "windows-appcontainer-acl" : request.isolationKind,
                    verified = true,
                    appContainer = true,
                    lowIntegrity = true,
                    projectReadWrite = true,
                    hostFilesystemDefaultDeny = true,
                    networkAllowed = request.allowNetwork,
                },
            };
            WriteResult(resultPath, result);
            File.WriteAllText(completionPath, "complete", new UTF8Encoding(false));
            System.Threading.Thread.Sleep(30000);
            return exited && process.ExitCode == 0 ? 0 : (exited ? process.ExitCode : 124);
        }
        finally
        {
            if (process != null) process.Dispose();
        }
    }

    private static ProcessStartInfo BuildTargetStartInfo(BrokerRequest request)
    {
        string executable = request.executable;
        string extension = Path.GetExtension(executable).ToLowerInvariant();
        ProcessStartInfo start = new ProcessStartInfo();
        if (extension == ".cmd" || extension == ".bat")
        {
            foreach (string argument in request.arguments ?? new string[0])
            {
                if (argument.IndexOfAny(new[] { '&', '|', '<', '>', '^', '\r', '\n' }) >= 0)
                    throw new InvalidOperationException("Batch command arguments contain unsupported shell metacharacters.");
            }
            start.FileName = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "cmd.exe");
            start.Arguments = "/d /s /c \"\"" + executable.Replace("\"", "\"\"") + "\" " + JoinArguments(request.arguments) + "\"";
        }
        else
        {
            start.FileName = executable;
            start.Arguments = JoinArguments(request.arguments);
        }
        start.WorkingDirectory = request.workingDirectory;
        start.UseShellExecute = false;
        start.CreateNoWindow = true;
        start.RedirectStandardInput = String.Equals(Path.GetFileName(executable), "git.exe", StringComparison.OrdinalIgnoreCase);
        start.RedirectStandardOutput = true;
        start.RedirectStandardError = true;
        start.StandardOutputEncoding = Encoding.UTF8;
        start.StandardErrorEncoding = Encoding.UTF8;
        if (start.RedirectStandardInput)
        {
            foreach (string variable in new[]
            {
                "GIT_CONFIG_GLOBAL",
                "GIT_CONFIG_SYSTEM",
                "GIT_DIR",
                "GIT_WORK_TREE",
                "GIT_INDEX_FILE",
                "GIT_OBJECT_DIRECTORY",
                "GIT_ALTERNATE_OBJECT_DIRECTORIES",
            }) start.EnvironmentVariables.Remove(variable);
            start.EnvironmentVariables["HOME"] = request.jobDirectory;
            start.EnvironmentVariables["GIT_CONFIG_NOSYSTEM"] = "1";
            start.EnvironmentVariables["GIT_TERMINAL_PROMPT"] = "0";
        }
        start.EnvironmentVariables["MONARCH_CODER_SANDBOX"] = String.IsNullOrWhiteSpace(request.isolationKind) ? "windows-appcontainer-acl" : request.isolationKind;
        start.EnvironmentVariables["MONARCH_CODER_PROJECT_ROOT"] = request.projectRoot;
        start.EnvironmentVariables["NODE_OPTIONS"] = "--preserve-symlinks --preserve-symlinks-main";
        List<string> pathEntries = new List<string> { Path.GetDirectoryName(request.executable) };
        if (request.readOnlyPaths != null)
        {
            foreach (string runtimeRoot in request.readOnlyPaths)
            {
                string gitExecPath = Path.Combine(runtimeRoot, "mingw64", "libexec", "git-core");
                if (Directory.Exists(gitExecPath))
                {
                    start.EnvironmentVariables["GIT_EXEC_PATH"] = gitExecPath;
                    pathEntries.Add(Path.Combine(runtimeRoot, "cmd"));
                    pathEntries.Add(Path.Combine(runtimeRoot, "bin"));
                    pathEntries.Add(Path.Combine(runtimeRoot, "mingw64", "bin"));
                }
            }
        }
        start.EnvironmentVariables["PATH"] = String.Join(";", pathEntries.ToArray()) + ";" + (start.EnvironmentVariables["PATH"] ?? "");
        return start;
    }

    private static BrokerRequest LoadAndValidateRequest(string requestPath, string resultPath)
    {
        string requestFull = Path.GetFullPath(requestPath);
        BrokerRequest request = Json.Deserialize<BrokerRequest>(File.ReadAllText(requestFull, Encoding.UTF8));
        if (request == null) throw new InvalidOperationException("Sandbox request is invalid.");
        request.projectRoot = Path.GetFullPath(Required(request.projectRoot, "projectRoot"));
        request.hostProjectRoot = Path.GetFullPath(Required(request.hostProjectRoot, "hostProjectRoot"));
        request.executable = Path.GetFullPath(Required(request.executable, "executable"));
        request.workingDirectory = Path.GetFullPath(Required(request.workingDirectory, "workingDirectory"));
        request.jobDirectory = Path.GetFullPath(Required(request.jobDirectory, "jobDirectory"));
        request.identity = Required(request.identity, "identity");
        request.arguments = request.arguments ?? new string[0];
        request.timeoutMs = Math.Max(1000, Math.Min(10 * 60 * 1000, request.timeoutMs));
        request.maxOutputBytes = Math.Max(4096, Math.Min(1024 * 1024, request.maxOutputBytes));
        if (!Directory.Exists(request.projectRoot)) throw new InvalidOperationException("Project root does not exist.");
        if (!Directory.Exists(request.jobDirectory)) throw new InvalidOperationException("Sandbox job directory does not exist.");
        if (!File.Exists(request.executable)) throw new InvalidOperationException("Sandbox executable does not exist.");
        EnsureWithin(request.workingDirectory, request.projectRoot, "workingDirectory");
        EnsureWithin(requestFull, request.jobDirectory, "requestPath");
        EnsureWithin(Path.GetFullPath(resultPath), request.jobDirectory, "resultPath");
        return request;
    }

    private static BoundedReadResult Drain(Stream stream, int maxBytes)
    {
        byte[] buffer = new byte[8192];
        MemoryStream retained = new MemoryStream();
        bool truncated = false;
        int read;
        while ((read = stream.Read(buffer, 0, buffer.Length)) > 0)
        {
            int remaining = maxBytes - (int)retained.Length;
            if (remaining > 0) retained.Write(buffer, 0, Math.Min(read, remaining));
            if (read > remaining) truncated = true;
        }
        return new BoundedReadResult { Text = Encoding.UTF8.GetString(retained.ToArray()), Truncated = truncated };
    }

    private static IntPtr CreateKillOnCloseJob()
    {
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) throw new InvalidOperationException("Sandbox child job creation failed.");
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        int length = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
        IntPtr pointer = Marshal.AllocHGlobal(length);
        try
        {
            Marshal.StructureToPtr(info, pointer, false);
            if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, pointer, (uint)length))
                throw new InvalidOperationException("Sandbox child job limits could not be applied.");
        }
        finally
        {
            Marshal.FreeHGlobal(pointer);
        }
        return job;
    }

    private static bool IsCurrentProcessAppContainer()
    {
        IntPtr token;
        if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, out token)) return false;
        try
        {
            int value = 0;
            int returned;
            return GetTokenInformation(token, TokenIsAppContainer, ref value, sizeof(int), out returned) && value != 0;
        }
        finally { CloseHandle(token); }
    }

    private static bool IsCurrentProcessLowIntegrity()
    {
        IntPtr token;
        if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, out token)) return false;
        try
        {
            int needed;
            GetTokenInformationBuffer(token, TokenIntegrityLevel, IntPtr.Zero, 0, out needed);
            if (needed <= 0) return false;
            IntPtr buffer = Marshal.AllocHGlobal(needed);
            try
            {
                if (!GetTokenInformationBuffer(token, TokenIntegrityLevel, buffer, needed, out needed)) return false;
                TOKEN_MANDATORY_LABEL label = (TOKEN_MANDATORY_LABEL)Marshal.PtrToStructure(buffer, typeof(TOKEN_MANDATORY_LABEL));
                IntPtr countPointer = GetSidSubAuthorityCount(label.Label.Sid);
                byte count = Marshal.ReadByte(countPointer);
                if (count == 0) return false;
                IntPtr ridPointer = GetSidSubAuthority(label.Label.Sid, (uint)(count - 1));
                uint rid = unchecked((uint)Marshal.ReadInt32(ridPointer));
                return rid <= 0x1000;
            }
            finally { Marshal.FreeHGlobal(buffer); }
        }
        finally { CloseHandle(token); }
    }

    private static string[] UniquePaths(IEnumerable<string> paths)
    {
        HashSet<string> seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        List<string> result = new List<string>();
        foreach (string entry in paths)
        {
            if (String.IsNullOrWhiteSpace(entry)) continue;
            string full = Path.GetFullPath(entry);
            if (seen.Add(full)) result.Add(full);
        }
        return result.ToArray();
    }

    private static void EnsureWithin(string candidate, string root, string label)
    {
        string normalizedRoot = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar) + Path.DirectorySeparatorChar;
        string normalizedCandidate = Path.GetFullPath(candidate);
        if (!normalizedCandidate.StartsWith(normalizedRoot, StringComparison.OrdinalIgnoreCase) &&
            !String.Equals(normalizedCandidate.TrimEnd(Path.DirectorySeparatorChar), root.TrimEnd(Path.DirectorySeparatorChar), StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException(label + " must stay inside its trusted root.");
    }

    private static bool IsWithin(string candidate, string root)
    {
        string normalizedRoot = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        string normalizedCandidate = Path.GetFullPath(candidate).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        return String.Equals(normalizedCandidate, normalizedRoot, StringComparison.OrdinalIgnoreCase)
            || normalizedCandidate.StartsWith(normalizedRoot + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase);
    }

    private static string Required(string value, string label)
    {
        if (String.IsNullOrWhiteSpace(value) || value.IndexOf('\0') >= 0) throw new InvalidOperationException(label + " is required.");
        return value;
    }

    private static string JoinArguments(string[] values)
    {
        if (values == null || values.Length == 0) return "";
        string[] quoted = new string[values.Length];
        for (int index = 0; index < values.Length; index++) quoted[index] = QuoteArgument(values[index] ?? "");
        return String.Join(" ", quoted);
    }

    private static string QuoteArgument(string value)
    {
        if (value.Length > 0 && value.IndexOfAny(new[] { ' ', '\t', '\n', '\v', '"' }) < 0) return value;
        StringBuilder result = new StringBuilder("\"");
        int slashes = 0;
        foreach (char character in value)
        {
            if (character == '\\') { slashes++; continue; }
            if (character == '"')
            {
                result.Append('\\', slashes * 2 + 1);
                result.Append('"');
                slashes = 0;
                continue;
            }
            result.Append('\\', slashes);
            slashes = 0;
            result.Append(character);
        }
        result.Append('\\', slashes * 2);
        result.Append('"');
        return result.ToString();
    }

    private static void WriteResult(string resultPath, BrokerResult result)
    {
        string target = Path.GetFullPath(resultPath);
        string temporary = target + ".tmp";
        File.WriteAllText(temporary, Json.Serialize(result), new UTF8Encoding(false));
        if (File.Exists(target)) File.Delete(target);
        File.Move(temporary, target);
    }

    private static void TryWriteFailure(string resultPath, string error)
    {
        if (String.IsNullOrWhiteSpace(resultPath)) return;
        try
        {
            WriteResult(resultPath, new BrokerResult
            {
                exitCode = null,
                stdout = "",
                stderr = "",
                timedOut = false,
                truncated = false,
                durationMs = 0,
                error = error,
                isolation = new IsolationResult
                {
                    kind = "windows-appcontainer-bfs",
                    verified = false,
                    appContainer = false,
                    lowIntegrity = false,
                    projectReadWrite = false,
                    hostFilesystemDefaultDeny = false,
                    networkAllowed = false,
                },
            });
        }
        catch { }
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFO
    {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public int dwX;
        public int dwY;
        public int dwXSize;
        public int dwYSize;
        public int dwXCountChars;
        public int dwYCountChars;
        public int dwFillAttribute;
        public int dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public uint dwProcessId;
        public uint dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct STARTUPINFOEX
    {
        public STARTUPINFO StartupInfo;
        public IntPtr lpAttributeList;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct SECURITY_CAPABILITIES
    {
        public IntPtr AppContainerSid;
        public IntPtr Capabilities;
        public uint CapabilityCount;
        public uint Reserved;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct SID_AND_ATTRIBUTES { public IntPtr Sid; public uint Attributes; }
    [StructLayout(LayoutKind.Sequential)]
    private struct TOKEN_MANDATORY_LABEL { public SID_AND_ATTRIBUTES Label; }
    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS
    {
        public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
        public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern IntPtr LoadLibraryEx(string fileName, IntPtr file, uint flags);
    [DllImport("kernel32.dll", CharSet = CharSet.Ansi, SetLastError = true)] private static extern IntPtr GetProcAddress(IntPtr module, string name);
    [DllImport("kernel32.dll")] private static extern bool FreeLibrary(IntPtr module);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool TerminateProcess(IntPtr process, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")] private static extern IntPtr GetCurrentProcess();
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll", EntryPoint = "GetTokenInformation", SetLastError = true)] private static extern bool GetTokenInformation(IntPtr token, int infoClass, ref int information, int length, out int returned);
    [DllImport("advapi32.dll", EntryPoint = "GetTokenInformation", SetLastError = true)] private static extern bool GetTokenInformationBuffer(IntPtr token, int infoClass, IntPtr information, int length, out int returned);
    [DllImport("advapi32.dll")] private static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);
    [DllImport("advapi32.dll")] private static extern IntPtr GetSidSubAuthority(IntPtr sid, uint index);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr information, uint length);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool TerminateJobObject(IntPtr job, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returnSize);
    [DllImport("kernel32.dll")] private static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool CreateProcess(
        string applicationName,
        StringBuilder commandLine,
        IntPtr processAttributes,
        IntPtr threadAttributes,
        bool inheritHandles,
        uint creationFlags,
        IntPtr environment,
        string currentDirectory,
        ref STARTUPINFOEX startupInfo,
        out PROCESS_INFORMATION processInformation);
    [DllImport("userenv.dll", CharSet = CharSet.Unicode)] private static extern int CreateAppContainerProfile(
        string name,
        string displayName,
        string description,
        IntPtr capabilities,
        uint capabilityCount,
        out IntPtr appContainerSid);
    [DllImport("userenv.dll", CharSet = CharSet.Unicode)] private static extern int DeriveAppContainerSidFromAppContainerName(string name, out IntPtr appContainerSid);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool ConvertStringSidToSid(string stringSid, out IntPtr sid);
    [DllImport("advapi32.dll")] private static extern IntPtr FreeSid(IntPtr sid);
    [DllImport("kernel32.dll")] private static extern IntPtr LocalFree(IntPtr memory);
}

internal static class SandboxSpecBuilder
{
    public static byte[] Build(string[] readWritePaths, string[] readOnlyPaths, bool network, ulong uiRestrictions)
    {
        List<byte> bytes = new List<byte>();
        WriteUInt32(bytes, 32);
        bytes.AddRange(Encoding.ASCII.GetBytes("SBOX"));

        // VTable for SandboxSpec fields in documented schema order.
        WriteUInt16(bytes, 22);
        WriteUInt16(bytes, 40);
        WriteUInt16(bytes, 4);   // version
        WriteUInt16(bytes, 8);   // app_container
        WriteUInt16(bytes, 0);   // integrity = system_default
        WriteUInt16(bytes, 10);  // disallow_win32k_system_calls
        WriteUInt16(bytes, 16);  // ui_restrictions
        WriteUInt16(bytes, 24);  // capabilities
        WriteUInt16(bytes, 28);  // fs_read_write
        WriteUInt16(bytes, 32);  // fs_read_only
        WriteUInt16(bytes, 0);   // network_policy
        while (bytes.Count < 32) bytes.Add(0);

        int table = bytes.Count;
        WriteInt32(bytes, table - 8);
        int versionOffset = ReserveUInt32(bytes);
        bytes.Add(1);
        bytes.Add(0);
        bytes.Add(1);
        while (bytes.Count < table + 16) bytes.Add(0);
        WriteUInt64(bytes, uiRestrictions);
        int capabilitiesOffset = ReserveUInt32(bytes);
        int readWriteOffset = ReserveUInt32(bytes);
        int readOnlyOffset = ReserveUInt32(bytes);
        WriteUInt32(bytes, 0);

        Align(bytes, 4);
        int version = WriteString(bytes, "0.1.0");
        PatchRelativeOffset(bytes, versionOffset, version);
        int capabilities = WriteString(bytes, network ? "internetClient" : "");
        PatchRelativeOffset(bytes, capabilitiesOffset, capabilities);
        int readWrite = WriteStringVector(bytes, readWritePaths ?? new string[0]);
        PatchRelativeOffset(bytes, readWriteOffset, readWrite);
        int readOnly = WriteStringVector(bytes, readOnlyPaths ?? new string[0]);
        PatchRelativeOffset(bytes, readOnlyOffset, readOnly);
        return bytes.ToArray();
    }

    private static int WriteStringVector(List<byte> bytes, string[] values)
    {
        Align(bytes, 4);
        int start = bytes.Count;
        WriteUInt32(bytes, (uint)values.Length);
        int[] slots = new int[values.Length];
        for (int index = 0; index < values.Length; index++) slots[index] = ReserveUInt32(bytes);
        for (int index = 0; index < values.Length; index++)
        {
            int value = WriteString(bytes, values[index]);
            PatchRelativeOffset(bytes, slots[index], value);
        }
        return start;
    }

    private static int WriteString(List<byte> bytes, string value)
    {
        Align(bytes, 4);
        int start = bytes.Count;
        byte[] encoded = Encoding.UTF8.GetBytes(value ?? "");
        WriteUInt32(bytes, (uint)encoded.Length);
        bytes.AddRange(encoded);
        bytes.Add(0);
        return start;
    }

    private static int ReserveUInt32(List<byte> bytes) { int slot = bytes.Count; WriteUInt32(bytes, 0); return slot; }
    private static void PatchRelativeOffset(List<byte> bytes, int slot, int target)
    {
        uint value = checked((uint)(target - slot));
        for (int index = 0; index < 4; index++) bytes[slot + index] = (byte)(value >> (index * 8));
    }
    private static void Align(List<byte> bytes, int alignment) { while ((bytes.Count % alignment) != 0) bytes.Add(0); }
    private static void WriteUInt16(List<byte> bytes, ushort value) { bytes.Add((byte)value); bytes.Add((byte)(value >> 8)); }
    private static void WriteUInt32(List<byte> bytes, uint value) { for (int index = 0; index < 4; index++) bytes.Add((byte)(value >> (index * 8))); }
    private static void WriteInt32(List<byte> bytes, int value) { WriteUInt32(bytes, unchecked((uint)value)); }
    private static void WriteUInt64(List<byte> bytes, ulong value) { for (int index = 0; index < 8; index++) bytes.Add((byte)(value >> (index * 8))); }
}
