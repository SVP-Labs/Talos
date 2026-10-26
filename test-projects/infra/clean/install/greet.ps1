<#
.SYNOPSIS
Prints a greeting.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)]
  [string] $Name
)

Write-Output "Hello, $Name"
