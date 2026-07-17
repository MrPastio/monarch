# Monarch Security

Local-first terminal security protector for Windows.

The design rule is strict: deterministic checks are the root of trust. The LLM
is optional, lazy, and advisory only. Scans never delete files, kill processes,
change firewall/Defender settings, block devices, or quarantine automatically.
An optional separate elevated response executor can apply only a PIN-approved,
evidence-bound, expiring firewall rule; it is disabled until explicitly installed.
External reputation lookups are disabled by default and require an explicit
per-command opt-in.

The integrated Monarch runtime also includes an Agent Guard in the TypeScript
execution path. It checks intent/action alignment, workspace boundaries,
remote provenance, security-tampering commands, and catastrophic operations
before a capability runs. Raw action input is transferred to this Python policy
layer through a bounded ephemeral local request file, never as visible process
arguments. Audit records retain evidence codes and hashes instead of raw input.

## Main Command

After setup with `-InstallCommand`, open a new terminal and run:

```powershell
monarch_sec
```

From the project folder you can also run the local wrapper directly:

```powershell
.\monarch_sec.ps1
```

Running `monarch_sec` without arguments opens the terminal control screen with:

- quick numbered actions for the common workflow
- a full command catalog with a short description for every command
- aliases such as `scan`, `deep`, `network`, `attack`, or `integrity`
- direct command input without retyping `monarch_sec`
- readable summaries inside the menu instead of raw JSON dumps

Inside the menu you can type a number, a short alias, or a direct command:

```text
1
scan
deep
scan-system --summary-only --no-llm
commands
```

Scriptable commands:

```powershell
monarch_sec commands
monarch_sec start --no-llm
monarch_sec status
monarch_sec stop
monarch_sec scan-path C:\Users\Example\Downloads --recursive --no-llm
monarch_sec deep-scan-file C:\Users\Example\Downloads\sample.exe --no-llm
monarch_sec deep-scan-file C:\Users\Example\Downloads\sample.exe --defender --no-llm
monarch_sec deep-scan-file C:\Users\Example\Downloads\sample.exe --virustotal --no-llm
monarch_sec scan-network --no-llm
monarch_sec scan-persistence --no-llm
monarch_sec scan-posture --no-llm
monarch_sec scan-system --summary-only --no-llm
monarch_sec scan-system --summary-only --include-files --file-limit 50 --no-llm
monarch_sec baseline-preview
monarch_sec baseline --persistence-only --expected-digest <sha256-from-preview>
monarch_sec verify-protection
monarch_sec verify-integrity
monarch_sec attack-simulation
monarch_sec simulate-live-threat --confirm-live-simulation
monarch_sec background-benchmark --duration 300
monarch_sec test-notification
monarch_sec tail-audit --lines 20
```

## Continuous Protection

The background protector continuously watches for new or changed security
signals:

- files in configured folders, with metadata-first inspection and deeper hashing
  or entropy only when needed
- new processes and suspicious parent/command-line behavior
- connected devices, especially USB/storage/phone/Bluetooth classes
- installed software changes
- passive network changes: adapters, DNS, gateway, neighbors, listeners, and
  established connections
- persistence entries: Startup folders, Run/RunOnce keys, scheduled tasks
- posture changes: firewall profiles and Microsoft Defender status

It deduplicates by stable signatures in `data/state.json`, writes decisions to
`logs/audit.jsonl`, and slows expensive work under CPU/RAM pressure. State and
new audit records are sealed with an HMAC integrity key so local tampering is
detectable with `monarch_sec verify-integrity`.

The background stop path uses a per-run HMAC token and PID binding. A blind
write to `data/protector.stop` is ignored and audited instead of stopping the
protector.

## Scanning and Control

File scans collect cheap deep metadata without external services:

- magic-byte type detection, including PE/ZIP/OLE/PDF/text/binary
- Mark-of-the-Web `Zone.Identifier` when present
- partial hashes for files above the full-hash budget
- PE header metadata, section names, and section entropy
- suspicious script primitives such as encoded commands, web downloads,
  Defender preference changes, scheduled tasks, and registry edits

`deep-scan-file` adds Windows Authenticode verdicts for executable/script-like
content and can optionally request a Microsoft Defender custom scan with
`--defender`. VirusTotal hash reputation is never called implicitly; it requires
both `--virustotal` and a configured `[policy].virustotal_api_key`. Unsigned,
invalid, mismatched, untrusted, or externally reported malicious files raise the
local score and add explicit safe controls before the file is allowed to run.

Policy decisions now include safe control recommendations in the JSON
`controls` field. The controls are deliberately advisory: they can suggest
verification, Defender scanning, process-tree review, isolation, or manual
remediation, but they do not delete files, kill processes, block devices, or
change Defender/firewall settings automatically. The response executor described
below is a separate explicit workflow and is never called by a scan or the LLM.

`scan-system` runs a combined host scan across network, devices, persistence,
and security posture. Optional `--include-files` scans configured file-watch
folders up to `--file-limit`; optional `--include-installs` adds installed
software inventory.

`verify-protection` runs an inert local validation lab. It creates harmless
test samples, scans them through the real scanner/rules/policy path, and checks
that hidden PE content, suspicious PowerShell, risky process ancestry,
persistence, exposed RDP, suspicious public internet connections, and disabled
Defender scenarios produce the expected risk and safe controls. The samples are
scanned, not executed. Use
`--keep-artifacts <path>` to retain the generated lab files for inspection, or
`--with-llm` to include advisory LLM routing.

`attack-simulation` is the harder adversarial lab. It attempts detector-evasion
patterns with inert artifacts and synthetic events: ZIP droppers with
double-extension payload names, Office macro indicators inside archives,
`.url` internet shortcuts, obfuscated PowerShell downloader command lines,
LOLBins with public internet connections, new USB HID devices, a correlated
PowerShell reverse-shell/RAT chain, download-path persistence, and public
cleartext exfiltration. It reports
`survived_evasions` and also lists residual architectural weaknesses that are
not solved by local scoring alone.

The same replay now includes seven explicitly benign controls, including routine
administrator PowerShell, a loopback Node.js development listener, and a trusted
network-profile refresh. The seventh control verifies that an exact persistence
entry from the HMAC-protected user-approved baseline stays low-signal, while a
changed entry with the same baseline key is escalated. Rolling last-seen persistence
signatures remain separate and cannot approve an entry automatically. It reports labeled attack/benign coverage plus
measured local `detection_rate`, `false_positive_rate`, and per-case p50/p95/max
latency. These are repeatable engineering gates, not claims about real-world
population accuracy; expand the labeled corpus before enabling more automation.
When `psutil` is available, the result also includes a one-second p50/p95 CPU
observation and RSS of the real background protector, CPU and observed peak RSS of the replay CLI
process, and five event-to-durable-incident measurements through rules, policy,
correlation, HMAC append and `fsync`. The latter intentionally excludes the
configured sensor polling interval, so it must not be presented as end-to-end
wall-clock detection time for polling sensors.
The protector observation is likewise not guaranteed to be idle: p95 deliberately
retains short sensor bursts while p50 describes the typical sample in that window.

Persistence trust uses a two-step flow. `baseline-preview` is read-only and returns
bounded added/changed/removed counts, entry keys, and a SHA-256 digest of the exact
current snapshot. `baseline --persistence-only --expected-digest <digest>` is the only
path that updates `approved_persistence_signatures`; it fails closed if the snapshot
changed after preview. A general `baseline` may refresh rolling last-seen persistence
state but cannot silently approve it. The Security UI exposes the same diff before its
separate confirmed approval action.

`background-benchmark` is the longer resource gate for the already-running protector.
It observes 30-900 seconds (five minutes by default), writes one bounded JSON artifact
inside `security/reports`, and reports process CPU/RSS p50/p95/max plus the fraction of
samples above 1% and 5% CPU. On Windows it uses `GetProcessTimes` and working-set APIs,
so `psutil` remains optional. This is whole-process observation, not per-sensor duty
attribution, and it does not claim polling detection latency.

The Monarch Security UI starts the same benchmark as an owned asynchronous job rather
than holding the capability request open for five minutes. The job exposes bounded
progress/status, refuses a second concurrent benchmark, and cancellation is bound to
the exact current job id. Closing/deactivating the Security module cancels its child
process; a cancelled run does not publish a partial artifact as a completed result.

The live incident journal is bounded by `max_incident_log_bytes` (4 MiB by
default). Compaction copies and hash-verifies the complete HMAC chain into
`incidents.jsonl.archives`, then rewrites the live journal as one signed
compaction record plus the latest snapshot of every incident. At most
`max_incident_archives` full archives are retained. Before an older archive is
pruned, its SHA-256, size, name, and reason are written to the separate signed
`incidents.jsonl.retention.jsonl` ledger. `verify-integrity` validates the live
journal, every retained archive, and the retention ledger.

## Notifications

The background protector sends a Windows notification when a detection reaches
the configured threshold. Notifications are rate-limited per event family so a
busy sensor does not spam the desktop. The notification path is advisory only:
it does not delete files, kill processes, change firewall rules, or quarantine
items.

Relevant settings live in `[notifications]`:

- `enabled` toggles the notification layer
- `min_score` controls the score required before a notification is sent
- `cooldown_seconds` suppresses repeated alerts for the same event family
- `windows_toast` enables Windows balloon notifications
- `console_bell` enables a terminal bell fallback

Use `monarch_sec test-notification` to send a synthetic high-risk alert through
the same channel.

## Internet Protection

Network scanning now labels address scope for listeners, DNS servers, gateways,
neighbors, and connections: public, private, loopback, link-local, multicast,
reserved, or unknown. Rules treat public internet connections differently from
local chatter:

- suspicious tools such as PowerShell, `cmd`, `mshta`, `certutil`, or
  `bitsadmin` connecting to public IPs are escalated
- owning process name and executable path are added when `psutil` is available;
  full command lines are deliberately excluded because they frequently contain
  API keys, CSRF tokens, and session secrets
- common reverse-shell, remote-control, admin, SMB, RDP, WinRM, VNC, SSH, FTP,
  Telnet, and IRC-style ports get extra weight when public
- public cleartext ports get a warning signal
- exposed listeners on all interfaces or public addresses get stronger scoring
- DNS/gateway changes record public resolver context for investigation

### Expiring firewall response executor

Actual firewall containment is separated from collectors, UI, and the LLM. A
network incident must contain the exact remote IP/port evidence, score at least
`400/800`, produce a bounded proposal, receive explicit user confirmation and a
valid Security PIN, and then submit a bounded JSON request over a local Windows
named pipe. The elevated executor revalidates the PIN, proposal, evidence and
TTL inside its own process and creates a one-time internal nonce. It accepts only
`block_network`; unknown fields, subnet-wide
targets, stale grants, replayed grants, and endpoints outside incident evidence
are rejected.

Each accepted rule has two rollback owners: the executor ledger and an
independent Windows SYSTEM scheduled task at the action expiry. Therefore the
rule still expires if the executor crashes. Installation itself is an explicit
administrator operation:

```powershell
monarch_sec response-service-install --confirm-service-install
monarch_sec response-service-status
monarch_sec response-actions
```

Removal stops the executor, rolls back active rules, and removes its scheduled
task:

```powershell
monarch_sec response-service-uninstall --confirm-service-install
```

The executor is not installed by normal setup and Monarch reports this state in
Network Center instead of pretending active containment is available.

### Emergency response

Risk `700–800` is reserved for corroborated deterministic evidence: at least two
independent high-risk evidence families, or a trusted malicious verdict together
with observed harmful behavior. LLM output cannot create emergency eligibility.

When enabled, an eligible incident enters a signed emergency state. The elevated
executor may apply only a two-minute endpoint rule derived from the incident, and
Monarch calls the native Windows `LockWorkStation` API. No custom full-screen
shell is used and Security PIN never replaces Windows authentication. Native lock
is suppressed when Security PIN has not been configured so the legitimate user
cannot be trapped without a recovery path.

After normal Windows sign-in, Monarch presents two explicit choices:

- **I take control** verifies Security PIN and releases containment. If the
  executor is unavailable, local state releases fail-open while the independent
  rollback task still removes any firewall rule at its TTL.
- **Continue protection** revalidates PIN and evidence inside the elevated
  executor and extends only the exact endpoint containment for at most 15 minutes.

The emergency state itself expires after ten minutes by default and will not
re-lock repeatedly unless new incident evidence arrives. Inspect it with:

```powershell
monarch_sec emergency-status
```

### Security PIN recovery

When a Security PIN is created or rotated, Monarch shows eight high-entropy
one-time recovery codes exactly once. Only salted SHA-256 digests are stored in
the signed local PIN record. Save the codes outside Monarch; they are not written
to UI storage, command arguments, audit logs, or later status responses.

`pin-recover` accepts one recovery code and a matching new six-digit PIN through
the bounded `data/pin-requests` file transport. A successful recovery rotates the
PIN and all recovery codes, invalidating every old code. Recovery attempts use a
separate exponential rate limit, so failed recovery does not unlock or weaken the
normal PIN verifier.

## Model

Default model path:

```text
<MonarchRoot>\LLM models\systemrouter
```

That directory is Qwen2.5-0.5B-Instruct in Hugging Face/safetensors format. The
router auto-selects:

- `.gguf` file -> llama.cpp backend
- model directory -> Transformers backend

If optional HF packages are missing, Monarch still works through local rules and
policy fallback.

## Setup

```powershell
.\scripts\setup_runtime.ps1
```

To install the short `monarch_sec` command for new terminals:

```powershell
.\scripts\setup_runtime.ps1 -InstallCommand
```

Optional local inference runtimes:

```powershell
.\scripts\setup_runtime.ps1 -WithLlm
.\scripts\setup_runtime.ps1 -WithHf
.\scripts\setup_runtime.ps1 -WithTui
```

You can also install or repair only the terminal command shim:

```powershell
.\scripts\install_command.ps1
```

The legacy `run_monarch_security.py` and `monarch-security` entrypoint remain
available, but `monarch_sec` is the primary interface.
