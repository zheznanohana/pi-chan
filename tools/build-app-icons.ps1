Add-Type -AssemblyName System.Drawing
$root='C:\Users\YOUR_USER\pi-chan-dashboard\assets\pet'
foreach($size in @(16,24,32,48,64,128,256)){
 $b=[Drawing.Bitmap]::new($size,$size);$g=[Drawing.Graphics]::FromImage($b);$g.SmoothingMode='AntiAlias';$g.ScaleTransform($size/64.0,$size/64.0)
 $path=[Drawing.Drawing2D.GraphicsPath]::new();foreach($a in @(@(3,3,180),@(41,3,270),@(41,41,0),@(3,41,90))){$path.AddArc($a[0],$a[1],20,20,$a[2],90)};$path.CloseFigure()
 $brush=[Drawing.SolidBrush]::new([Drawing.ColorTranslator]::FromHtml('#283343'));$g.FillPath($brush,$path)
 $pen=[Drawing.Pen]::new([Drawing.ColorTranslator]::FromHtml('#FFBD6B'),6);$pen.StartCap='Round';$pen.EndCap='Round';$pen.LineJoin='Round'
 $g.DrawLine($pen,17,23,47,23);$g.DrawLine($pen,25,23,23,44);$g.DrawLine($pen,39,23,39,40);$g.DrawArc($pen,39,36,9,8,90,90)
 $b.Save("$root\app-icon-$size.png",[Drawing.Imaging.ImageFormat]::Png)
 if($size -eq 32){$b.Save("$root\tray-active.png",[Drawing.Imaging.ImageFormat]::Png);$dot=[Drawing.SolidBrush]::new([Drawing.Color]::FromArgb(245,180,187,196));$g.FillEllipse($dot,43,43,17,17);$b.Save("$root\tray-muted.png",[Drawing.Imaging.ImageFormat]::Png);$dot.Dispose()}
 $pen.Dispose();$brush.Dispose();$path.Dispose();$g.Dispose();$b.Dispose()
}

