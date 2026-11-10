# Windows toast helper. Invoked by index.js with one base64 JSON payload so the
# command line stays pure ASCII: non-ASCII titles and bodies survive regardless
# of the console code page.
param(
  [Parameter(Mandatory = $true)]
  [string]$PayloadBase64
)

$ErrorActionPreference = 'Stop'

$json = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($PayloadBase64))
$payload = $json | ConvertFrom-Json

$title = [string]$payload.title
if ([string]::IsNullOrWhiteSpace($title)) { $title = 'DeepSeek Harness' }
$body = [string]$payload.body
$appId = [string]$payload.appId
if ([string]::IsNullOrWhiteSpace($appId) -or $appId.Length -gt 128 -or $appId -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$') {
  $appId = 'com.deepseek.dsh'
}

$null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]

$template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent(
  [Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$texts = $template.GetElementsByTagName('text')
$texts.Item(0).AppendChild($template.CreateTextNode($title)) | Out-Null
$texts.Item(1).AppendChild($template.CreateTextNode($body)) | Out-Null

$toast = [Windows.UI.Notifications.ToastNotification]::new($template)
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast)
