$ErrorActionPreference = "Stop"

function New-OscarApiToken {
    $bytes = New-Object byte[] 32
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $rng.GetBytes($bytes)
    }
    finally {
        $rng.Dispose()
    }

    return -join ($bytes | ForEach-Object { $_.ToString("x2") })
}

function Ensure-OscarApiToken {
    param(
        [Parameter(Mandatory = $true)]
        [string]$OscarRoot
    )

    $configured = [Environment]::GetEnvironmentVariable("OSCAR_API_TOKEN", "Process")
    if (-not [string]::IsNullOrWhiteSpace($configured)) {
        return $configured.Trim().TrimStart([char]0xFEFF)
    }

    $monarchRoot = (Resolve-Path (Join-Path $OscarRoot "..")).Path
    $secretsDir = Join-Path $monarchRoot "secrets"
    $tokenFile = Join-Path $secretsDir "oscar_token.txt"

    if (Test-Path -LiteralPath $tokenFile) {
        $existing = (Get-Content -LiteralPath $tokenFile -Raw -Encoding UTF8).Trim().TrimStart([char]0xFEFF)
        if (-not [string]::IsNullOrWhiteSpace($existing)) {
            return $existing
        }
    }

    $token = New-OscarApiToken
    New-Item -ItemType Directory -Path $secretsDir -Force | Out-Null
    Set-Content -LiteralPath $tokenFile -Value $token -NoNewline -Encoding ASCII
    return $token
}
