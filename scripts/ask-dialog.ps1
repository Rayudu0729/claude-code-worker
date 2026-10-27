# Timed question dialog for Windows (see scripts/ask-dialog.mjs). One button per option plus a text
# box for a free answer; closes after timeoutSec. Writes the result JSON to $OutFile.
param([string]$InFile, [string]$OutFile)
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$ask = [IO.File]::ReadAllText($InFile) | ConvertFrom-Json
$script:result = @{ answered = $false; timed_out = $true }
$script:left = [int]$ask.timeoutSec

$form = New-Object Windows.Forms.Form
$form.Text = 'Claude needs your answer'
$form.TopMost = $true
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.MinimizeBox = $false
$form.AutoSize = $true
$form.AutoSizeMode = 'GrowAndShrink'
$form.Font = New-Object Drawing.Font('Segoe UI', 10)

$panel = New-Object Windows.Forms.FlowLayoutPanel
$panel.FlowDirection = 'TopDown'
$panel.WrapContents = $false
$panel.AutoSize = $true
$panel.Padding = New-Object Windows.Forms.Padding(14)
$form.Controls.Add($panel)

function Add-Label($text, $bold) {
  $l = New-Object Windows.Forms.Label
  $l.Text = $text
  $l.UseMnemonic = $false
  $l.AutoSize = $true
  $l.MaximumSize = New-Object Drawing.Size(560, 0)
  $l.Margin = New-Object Windows.Forms.Padding(0, 0, 0, 10)
  if ($bold) { $l.Font = New-Object Drawing.Font('Segoe UI', 10, [Drawing.FontStyle]::Bold) }
  $panel.Controls.Add($l)
  return $l
}

function Finish($r) {
  $script:result = $r
  $form.Close()
}

[void](Add-Label $ask.question $true)
$countdown = Add-Label '' $false

foreach ($opt in @($ask.options)) {
  $b = New-Object Windows.Forms.Button
  $b.Text = if ($opt -eq $ask.recommended) { "$opt   (recommended)" } else { $opt }
  $b.Tag = $opt
  $b.UseMnemonic = $false
  $b.AutoSize = $true
  $b.MinimumSize = New-Object Drawing.Size(560, 34)
  $b.MaximumSize = New-Object Drawing.Size(560, 0)
  $b.TextAlign = 'MiddleLeft'
  $b.Add_Click({ Finish @{ answered = $true; choice = $this.Tag } })
  $panel.Controls.Add($b)
}

$other = Add-Label 'Or type your own answer:' $false
$other.Margin = New-Object Windows.Forms.Padding(0, 10, 0, 4)
$row = New-Object Windows.Forms.FlowLayoutPanel
$row.AutoSize = $true
$row.WrapContents = $false
$box = New-Object Windows.Forms.TextBox
$box.Width = 470
$send = New-Object Windows.Forms.Button
$send.Text = 'Send'
$send.AutoSize = $true
$send.Add_Click({ if ($box.Text.Trim()) { Finish @{ answered = $true; text = $box.Text.Trim() } } })
$box.Add_KeyDown({ if ($_.KeyCode -eq 'Enter' -and $box.Text.Trim()) { Finish @{ answered = $true; text = $box.Text.Trim() } } })
$row.Controls.Add($box)
$row.Controls.Add($send)
$panel.Controls.Add($row)

function Show-Left { $countdown.Text = "Claude will decide by itself in $($script:left) s if you do not answer." }
Show-Left
$timer = New-Object Windows.Forms.Timer
$timer.Interval = 1000
$timer.Add_Tick({
  $script:left--
  if ($script:left -le 0) { $timer.Stop(); $form.Close() } else { Show-Left }
})
$form.Add_Shown({ $form.Activate(); [System.Media.SystemSounds]::Exclamation.Play(); $timer.Start() })
[void]$form.ShowDialog()
$timer.Stop()

[IO.File]::WriteAllText($OutFile, ($script:result | ConvertTo-Json -Compress))
