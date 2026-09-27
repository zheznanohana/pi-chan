$ErrorActionPreference='Stop'
[Console]::InputEncoding=[Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Speech
$s=New-Object System.Speech.Synthesis.SpeechSynthesizer
$v=$s.GetInstalledVoices() | Where-Object {$_.Enabled -and $_.VoiceInfo.Culture.Name -like 'en-*'} | Select-Object -First 1
while($null -ne ($line=[Console]::ReadLine())){
 $r=$null
 try{
  $r=$line|ConvertFrom-Json
  if(!$v){throw 'No installed English speech voice'}
  $s.SelectVoice($v.VoiceInfo.Name)
  $stream=New-Object IO.MemoryStream
  $fmt=New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000,[System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,[System.Speech.AudioFormat.AudioChannel]::Mono)
  $s.SetOutputToWaveStream($stream);$s.Speak([string]$r.text);$s.SetOutputToNull()
  $bytes=$stream.ToArray();$stream.Dispose()
  [Console]::WriteLine((@{id=$r.id;wav=[Convert]::ToBase64String($bytes);voice=$v.VoiceInfo.Name}|ConvertTo-Json -Compress))
 }catch{[Console]::WriteLine((@{id=$r.id;error=$_.Exception.Message}|ConvertTo-Json -Compress))}
}
$s.Dispose()

