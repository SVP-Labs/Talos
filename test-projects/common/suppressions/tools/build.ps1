function Show-Progress {
    [Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSAvoidUsingWriteHost', '')]
    param([string] $Message)
    Write-Host $Message
}
