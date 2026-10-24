using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

// 卫戍协议：盟约 · 单文件安装器
//   exe = 本程序 + [Deflate 压缩的负载] + [24 字节页脚: "SPPKG001" + int64 偏移 + int64 未压缩字节数]
//
// 负载直接解压到安装目录，**全程不使用 %TEMP%** —— 绕开「NSIS 安装包在部分机器上报
// Error writing temporary file」的问题。
//
// 收尾（桌面/开始菜单快捷方式 + 控制面板条目）交给 powershell.exe 执行。如果那一步被限制
// （有些机器只给「未签名的 exe 及其子进程」限制这些位置），就留下「完成安装.bat」给用户点一次
// ——由资源管理器/cmd 直接拉起的进程是受信任的，那一步就能成功。
//
// 参数：/S 静默安装    /D=<目录> 指定安装目录    /NODESKTOP 不建桌面快捷方式

namespace SPInstaller
{
    internal static class Pkg
    {
        const int FooterSize = 24;
        static readonly byte[] Magic = Encoding.ASCII.GetBytes("SPPKG001");

        public static string SelfPath()
        {
            return Assembly.GetExecutingAssembly().Location;
        }

        // 页脚在"负载之后、签名之前"：没签名时正好在文件末尾；用 Authenticode 签名后，
        // 签名块（通常几 KB）会追加到页脚后面，所以要从尾部往前扫最多 8 MB 找 "SPPKG001"。
        static byte[] ReadFooter()
        {
            using (FileStream fs = new FileStream(SelfPath(), FileMode.Open, FileAccess.Read, FileShare.Read))
            {
                long len = fs.Length;
                if (len < FooterSize + 8) throw new InvalidDataException("安装文件不完整");
                int window = (int)Math.Min(len, 8L * 1024 * 1024);
                byte[] buf = new byte[window];
                fs.Seek(len - window, SeekOrigin.Begin);
                int got = 0;
                while (got < window)
                {
                    int n = fs.Read(buf, got, window - got);
                    if (n <= 0) break;
                    got += n;
                }
                for (int i = got - FooterSize; i >= 0; i--)
                {
                    bool hit = true;
                    for (int k = 0; k < 8; k++)
                    {
                        if (buf[i + k] != Magic[k]) { hit = false; break; }
                    }
                    if (!hit) continue;
                    long off = BitConverter.ToInt64(buf, i + 8);
                    long size = BitConverter.ToInt64(buf, i + 16);
                    if (off <= 0 || off >= len - window + i) continue;
                    byte[] footer = new byte[FooterSize];
                    Array.Copy(buf, i, footer, 0, FooterSize);
                    if (size < 0) BitConverter.GetBytes((long)0).CopyTo(footer, 16);
                    return footer;
                }
                throw new InvalidDataException("找不到内嵌的安装数据");
            }
        }

        public static long PayloadOffset()
        {
            byte[] footer = ReadFooter();
            for (int i = 0; i < 8; i++)
                if (footer[i] != Magic[i]) throw new InvalidDataException("找不到内嵌的安装数据");
            long off = BitConverter.ToInt64(footer, 8);
            if (off <= 0) throw new InvalidDataException("安装数据偏移无效");
            return off;
        }

        // 负载解压后的总字节数（页脚里记着，用来显示"预计占用"）
        public static long TotalBytes()
        {
            try
            {
                byte[] footer = ReadFooter();
                for (int i = 0; i < 8; i++)
                    if (footer[i] != Magic[i]) return 0;
                long size = BitConverter.ToInt64(footer, 16);
                if (size > 0) return size;
            }
            catch { }
            // 老格式（16 字节页脚）没有这一段，粗略按 exe 体积 × 2.5 估一个
            try { return (long)(new FileInfo(SelfPath()).Length * 2.5); } catch { return 0; }
        }

        public static int ExtractAll(string targetDir, Action<int, string> onFile)
        {
            int count = 0;
            long offset = PayloadOffset();
            using (FileStream fs = new FileStream(SelfPath(), FileMode.Open, FileAccess.Read, FileShare.Read))
            {
                fs.Seek(offset, SeekOrigin.Begin);
                using (DeflateStream ds = new DeflateStream(fs, CompressionMode.Decompress))
                using (BinaryReader br = new BinaryReader(ds))
                {
                    while (true)
                    {
                        int nameLen;
                        try { nameLen = br.ReadInt32(); }
                        catch (EndOfStreamException) { break; }
                        if (nameLen <= 0 || nameLen > 4096) break;
                        string rel = Encoding.UTF8.GetString(br.ReadBytes(nameLen));
                        long size = br.ReadInt64();
                        string path = Path.Combine(targetDir, rel.Replace('/', Path.DirectorySeparatorChar));
                        string parent = Path.GetDirectoryName(path);
                        if (!string.IsNullOrEmpty(parent)) Directory.CreateDirectory(parent);
                        using (FileStream outFs = new FileStream(path, FileMode.Create, FileAccess.Write, FileShare.None, 128 * 1024))
                        {
                            byte[] buf = new byte[128 * 1024];
                            long left = size;
                            while (left > 0)
                            {
                                int want = (int)Math.Min(buf.Length, left);
                                int n = br.Read(buf, 0, want);
                                if (n <= 0) throw new EndOfStreamException("安装数据在写入过程中结束");
                                outFs.Write(buf, 0, n);
                                left -= n;
                            }
                        }
                        count++;
                        if (onFile != null) onFile(count, rel);
                    }
                }
            }
            return count;
        }
    }

    internal static class Setup
    {
        public const string AppName = "卫戍协议：盟约";
        public const string ExeName = "Stronghold Protocol.exe";
        const string ArpKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\StrongholdProtocol";

        // 用户选目录时自动补一层子文件夹：选 E:\ 或 E:\Games 都装到 <所选>\Stronghold Protocol，
        // 免得几十个文件直接散在盘根或你选的那个目录里。
        public const string SubFolder = "Stronghold Protocol";

        public static string NormalizeDir(string dir)
        {
            string d = (dir ?? "").Trim().Trim('"');
            if (d.Length == 0) return DefaultDir();
            try { d = Path.GetFullPath(d); } catch { }
            string trimmed = d.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            string leaf = Path.GetFileName(trimmed);
            if (!string.Equals(leaf, SubFolder, StringComparison.OrdinalIgnoreCase))
            {
                string root = Path.GetPathRoot(d);
                d = string.Equals(trimmed, root == null ? "" : root.TrimEnd(Path.DirectorySeparatorChar), StringComparison.OrdinalIgnoreCase)
                    ? Path.Combine(root ?? d, SubFolder)
                    : Path.Combine(trimmed, SubFolder);
            }
            return d;
        }

        public static string DefaultDir()
        {
            return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                                @"Programs\Stronghold Protocol");
        }

        public static string SizeText(long bytes)
        {
            if (bytes <= 0) return "未知";
            if (bytes >= 1024L * 1024 * 1024) return string.Format("{0:F2} GB", bytes / 1024.0 / 1024.0 / 1024.0);
            return string.Format("{0:F0} MB", bytes / 1024.0 / 1024.0);
        }

        public static long FreeSpace(string dir)
        {
            try
            {
                string root = Path.GetPathRoot(Path.GetFullPath(dir));
                if (string.IsNullOrEmpty(root)) return -1;
                return new DriveInfo(root).AvailableFreeSpace;
            }
            catch { return -1; }
        }

        // 收尾脚本：快捷方式（桌面可选）+ 控制面板条目。路径全部由参数传进来。
        const string FinishScript = @"
param([string]$Dir, [string]$Desktop = '1')
$ErrorActionPreference = 'Stop'
# 完成安装.bat 传的是 %~dp0. 这种带 \. 的路径（形如 D:\Games\X\.），先规范成干净路径：
# 快捷方式的 IconLocation 里带 \. 段时，外壳取不到图标，会显示成白纸。
$Dir = [IO.Path]::GetFullPath($Dir).TrimEnd('\')
$appName = '卫戍协议：盟约'
$exe = Join-Path $Dir 'Stronghold Protocol.exe'
# 图标直接用 exe 自己（构建时已用 rcedit 把图标写进 exe 资源）：
# 指向独立的 .ico 在这台机器的外壳上会显示成白纸图标，指向 exe 才稳定。
$icon = $exe
$uninst = Join-Path $Dir '卸载.bat'
$shell = New-Object -ComObject WScript.Shell
function Make($lnk, $target, $arguments, $iconPath, $work) {
  $parent = Split-Path -Parent $lnk
  if (-not (Test-Path $parent)) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
  $sc = $shell.CreateShortcut($lnk)
  $sc.TargetPath = $target
  $sc.Arguments = $arguments
  $sc.WorkingDirectory = $work
  $sc.IconLocation = $iconPath + ',0'
  $sc.Description = $appName
  $sc.Save()
}
# 只有勾选时才创建桌面快捷方式；不勾只表示这次别建，绝不删除已有的那个。
# （以前这里是 else { Remove-Item ... }：重装时没勾，桌面上原来那个就凭空消失了）
if ($Desktop -eq '1') {
  Make (Join-Path ([Environment]::GetFolderPath('Desktop')) ($appName + '.lnk')) $exe '--no-sandbox' $icon $Dir
}
$group = Join-Path ([Environment]::GetFolderPath('Programs')) $appName
Make (Join-Path $group ($appName + '.lnk')) $exe '--no-sandbox' $icon $Dir
Make (Join-Path $group ('卸载 ' + $appName + '.lnk')) $uninst '' $uninst $Dir
$ver = '0.3.0'
try {
  $pkg = Join-Path $Dir 'resources\app\package.json'
  if (Test-Path $pkg) { $ver = (Get-Content $pkg -Raw -Encoding UTF8 | ConvertFrom-Json).version }
} catch { }
$key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\StrongholdProtocol'
New-Item -Path $key -Force | Out-Null
Set-ItemProperty -Path $key -Name DisplayName -Value $appName
Set-ItemProperty -Path $key -Name DisplayVersion -Value $ver
Set-ItemProperty -Path $key -Name Publisher -Value 'Stronghold Protocol (fan project)'
Set-ItemProperty -Path $key -Name DisplayIcon -Value $icon
Set-ItemProperty -Path $key -Name InstallLocation -Value $Dir
Set-ItemProperty -Path $key -Name UninstallString -Value $uninst
Set-ItemProperty -Path $key -Name NoModify -Value 1 -Type DWord
Set-ItemProperty -Path $key -Name NoRepair -Value 1 -Type DWord
";

        // 卸载入口：写成 .bat 让 cmd / powershell 去跑（受限机器上未签名 exe 删不动桌面和注册表）
        const string UninstallBat = "@echo off\r\nchcp 65001 >nul\r\npowershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command \"$d = Split-Path -Parent '%~f0'; Remove-Item ([IO.Path]::Combine([Environment]::GetFolderPath('Desktop'),'卫戍协议：盟约.lnk')) -Force -ErrorAction SilentlyContinue; Remove-Item ([IO.Path]::Combine($env:APPDATA,'Microsoft','Windows','Start Menu','Programs','卫戍协议：盟约')) -Recurse -Force -ErrorAction SilentlyContinue; Remove-Item 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\StrongholdProtocol' -Recurse -Force -ErrorAction SilentlyContinue; Set-Location 'C:\\'; Start-Sleep -Milliseconds 500; Remove-Item $d -Recurse -Force -ErrorAction SilentlyContinue\"\r\n";

        static void WriteScripts(string dir, bool desktop)
        {
            try
            {
                File.WriteAllText(Path.Combine(dir, "_finish.ps1"), FinishScript, new UTF8Encoding(true));
                File.WriteAllText(Path.Combine(dir, "卸载.bat"), UninstallBat, new UTF8Encoding(false));

                string flag = desktop ? "1" : "0";
                string bat = "@echo off\r\nchcp 65001 >nul\r\npowershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \"%~dp0_finish.ps1\" -Dir \"%~dp0.\" -Desktop " + flag + "\r\n";
                File.WriteAllText(Path.Combine(dir, "完成安装.bat"), bat, new UTF8Encoding(false));

                // 快捷方式被外部删掉（杀软、手动清理、OneDrive 重定向）时一键重建：
                // 就是把收尾脚本再跑一遍，强制建桌面图标 + 开始菜单 + 控制面板条目。
                string repair = "@echo off\r\nchcp 65001 >nul\r\necho 正在重建快捷方式...\r\npowershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \"%~dp0_finish.ps1\" -Dir \"%~dp0.\" -Desktop 1\r\nif errorlevel 1 (echo 失败：请右键以管理员身份运行本文件) else (echo 完成。)\r\npause\r\n";
                File.WriteAllText(Path.Combine(dir, "修复快捷方式.bat"), repair, new UTF8Encoding(false));
            }
            catch { }
        }

        // 用 powershell 做收尾；成功返回空列表
        static List<string> RunFinish(string dir, bool desktop)
        {
            List<string> warnings = new List<string>();
            string script = Path.Combine(dir, "_finish.ps1");
            try
            {
                ProcessStartInfo psi = new ProcessStartInfo("powershell.exe",
                    "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \"" + script + "\" -Dir \"" + dir + "\" -Desktop " + (desktop ? "1" : "0"));
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
                psi.WindowStyle = ProcessWindowStyle.Hidden;
                psi.RedirectStandardError = true;
                psi.RedirectStandardOutput = true;
                Process p = Process.Start(psi);
                string err = p.StandardError.ReadToEnd();
                p.WaitForExit();
                if (p.ExitCode != 0) warnings.Add("powershell 返回 " + p.ExitCode + "：" + err.Trim());
            }
            catch (Exception ex) { warnings.Add("没能启动 powershell：" + ex.Message); }
            return warnings;
        }

        // 兜底：用 ShellExecute 让资源管理器（已在运行的可信进程）去跑补完脚本。
        // 注意不能用 Process.Start("explorer.exe", ...) —— 那会新起一个 explorer 进程，
        // 在受限机器上它自己就 0xc0000142 崩掉；ShellExecute 只是把请求交给已在跑的 shell。
        static bool TryShellExecuteFinish(string dir)
        {
            string bat = Path.Combine(dir, "完成安装.bat");
            if (!File.Exists(bat)) return false;
            try
            {
                ProcessStartInfo psi = new ProcessStartInfo(bat);
                psi.UseShellExecute = true;
                psi.WorkingDirectory = dir;
                psi.WindowStyle = ProcessWindowStyle.Hidden;
                Process.Start(psi);
            }
            catch { return false; }

            for (int i = 0; i < 12; i++)
            {
                System.Threading.Thread.Sleep(300);
                try
                {
                    using (RegistryKey k = Registry.CurrentUser.OpenSubKey(ArpKey))
                    {
                        if (k != null) return true;
                    }
                }
                catch { }
            }
            return false;
        }

        public static List<string> Run(string dir, bool desktop, Action<int, string> onFile, out int count)
        {
            dir = NormalizeDir(dir);
            Directory.CreateDirectory(dir);
            WriteScripts(dir, desktop);
            count = Pkg.ExtractAll(dir, onFile);
            WriteScripts(dir, desktop); // 负载里可能带着旧的同名脚本，写完文件后再落一次

            List<string> warnings = RunFinish(dir, desktop);
            bool ok = warnings.Count == 0;
            if (!ok)
            {
                // 交给已在运行的 shell 去跑补完脚本；成功就不打扰用户
                ok = TryShellExecuteFinish(dir);
                if (ok) warnings.Clear();
            }

            if (!ok)
            {
                warnings.Clear();
                warnings.Add("快捷方式和控制面板条目没建成：这台机器限制了未签名程序的写入（已尝试自动补建）。");
                warnings.Add("请双击这个文件补上（只需一次）：" + Path.Combine(dir, "完成安装.bat"));
                warnings.Add("也可以直接用安装目录里的 PLAY.bat 启动游戏，功能完全一样。");
            }
            return warnings;
        }
    }

    internal sealed class SetupForm : Form
    {
        readonly TextBox _path;
        readonly Button _browse;
        readonly Button _install;
        readonly Button _cancel;
        readonly CheckBox _desktop;
        readonly ProgressBar _bar;
        readonly Label _status;
        readonly Label _size;
        int _errors;
        int _count;
        List<string> _warnings = new List<string>();
        readonly long _total;

        public SetupForm()
        {
            _total = Pkg.TotalBytes();
            Text = Setup.AppName + " · 安装";
            ClientSize = new Size(600, 300);
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            MinimizeBox = false;
            StartPosition = FormStartPosition.CenterScreen;
            Font = new Font("Microsoft YaHei UI", 9f);

            Label title = new Label();
            title.Text = "安装 " + Setup.AppName;
            title.Font = new Font("Microsoft YaHei UI", 14f, FontStyle.Bold);
            title.SetBounds(20, 16, 540, 32);

            Label hint = new Label();
            hint.Text = "安装到（不需要管理员，也不经过系统临时目录）：";
            hint.SetBounds(20, 62, 460, 20);

            _path = new TextBox();
            _path.Text = Setup.DefaultDir();
            _path.SetBounds(20, 86, 440, 24);
            _path.TextChanged += delegate { UpdateSize(); };

            _browse = new Button();
            _browse.Text = "浏览…";
            _browse.SetBounds(468, 85, 92, 26);
            _browse.Click += Browse;

            _desktop = new CheckBox();
            _desktop.Text = "创建桌面快捷方式（开始菜单里总会有一个）";
            _desktop.SetBounds(20, 120, 400, 24);
            _desktop.Checked = true;

            _size = new Label();
            _size.SetBounds(20, 148, 540, 20);
            _size.ForeColor = Color.FromArgb(90, 90, 90);

            _bar = new ProgressBar();
            _bar.SetBounds(20, 176, 540, 16);
            _bar.Maximum = 100;
            _bar.Style = ProgressBarStyle.Continuous;

            _status = new Label();
            _status.Text = "就绪。";
            _status.SetBounds(20, 198, 540, 20);
            _status.AutoEllipsis = true;

            _install = new Button();
            _install.Text = "安装";
            _install.SetBounds(376, 240, 88, 32);
            _install.Click += StartInstall;

            _cancel = new Button();
            _cancel.Text = "取消";
            _cancel.SetBounds(472, 240, 88, 32);
            _cancel.Click += delegate { Close(); };

            Controls.Add(title);
            Controls.Add(hint);
            Controls.Add(_path);
            Controls.Add(_browse);
            Controls.Add(_desktop);
            Controls.Add(_size);
            Controls.Add(_bar);
            Controls.Add(_status);
            Controls.Add(_install);
            Controls.Add(_cancel);

            UpdateSize();
        }

        void UpdateSize()
        {
            long free = Setup.FreeSpace(_path.Text.Trim());
            string line = "预计占用：约 " + Setup.SizeText(_total);
            if (free > 0) line += "　·　目标磁盘剩余：" + Setup.SizeText(free);
            if (free > 0 && _total > 0 && free < _total) line += "　（空间不足）";
            _size.Text = line;
            _size.ForeColor = (free > 0 && _total > 0 && free < _total) ? Color.Firebrick : Color.FromArgb(90, 90, 90);
        }

        void Browse(object sender, EventArgs e)
        {
            using (FolderBrowserDialog dlg = new FolderBrowserDialog())
            {
                dlg.Description = "选择安装位置";
                dlg.SelectedPath = _path.Text;
                if (dlg.ShowDialog(this) == DialogResult.OK) { _path.Text = Setup.NormalizeDir(dlg.SelectedPath); UpdateSize(); }
            }
        }

        void StartInstall(object sender, EventArgs e)
        {
            string dir = Setup.NormalizeDir(_path.Text);
            if (dir.Length == 0) { MessageBox.Show(this, "请填写安装目录。", "提示"); return; }
            _path.Text = dir;
            if (Directory.Exists(Path.Combine(dir, "resources")))
            {
                if (MessageBox.Show(this, "该目录里已经有客户端，覆盖安装？", "确认", MessageBoxButtons.YesNo) != DialogResult.Yes) return;
            }
            bool desktop = _desktop.Checked;

            _install.Enabled = false;
            _browse.Enabled = false;
            _path.Enabled = false;
            _desktop.Enabled = false;
            _bar.Style = ProgressBarStyle.Marquee;
            _status.Text = "正在写入文件（不经过临时目录）…";

            BackgroundWorker w = new BackgroundWorker();
            w.DoWork += delegate
            {
                try
                {
                    _warnings = Setup.Run(dir, desktop, delegate(int n, string rel)
                    {
                        if (n % 200 != 0) return;
                        try { BeginInvoke((Action)delegate { _status.Text = string.Format("已写入 {0} 个文件 · {1}", n, rel); }); }
                        catch { }
                    }, out _count);
                }
                catch (Exception ex) { _errors = 1; BeginInvoke((Action)delegate { ShowError(ex); }); }
            };
            w.RunWorkerCompleted += delegate
            {
                if (_errors != 0) return;
                _bar.Style = ProgressBarStyle.Continuous;
                _bar.Value = 100;
                _status.Text = string.Format("安装完成，共 {0} 个文件。", _count);
                _install.Visible = false;
                _cancel.Text = "完成";
                if (_warnings.Count > 0)
                {
                    string text = string.Join("\r\n", _warnings.ToArray()) +
                                  "\r\n\r\n点「打开安装目录」，再双击里面的「完成安装.bat」即可（也可以直接双击 PLAY.bat 进游戏）。";
                    if (MessageBox.Show(this, text, "还需要一步", MessageBoxButtons.OKCancel, MessageBoxIcon.Information) == DialogResult.OK)
                    {
                        try { Process.Start(new ProcessStartInfo(dir) { UseShellExecute = true }); } catch { }
                    }
                }
                if (MessageBox.Show(this, "安装完成，现在就启动？", Setup.AppName, MessageBoxButtons.YesNo) == DialogResult.Yes)
                {
                    try { Process.Start(new ProcessStartInfo(Path.Combine(dir, Setup.ExeName), "--no-sandbox") { WorkingDirectory = dir }); }
                    catch (Exception ex) { MessageBox.Show(this, ex.Message, "启动失败"); }
                }
                Close();
            };
            w.RunWorkerAsync();
        }

        void ShowError(Exception ex)
        {
            _bar.Style = ProgressBarStyle.Continuous;
            _status.Text = "安装失败。";
            _install.Enabled = true;
            _browse.Enabled = true;
            _path.Enabled = true;
            _desktop.Enabled = true;

            bool denied = ex is UnauthorizedAccessException
                          || (ex.InnerException is UnauthorizedAccessException)
                          || ex.Message.Contains("拒绝") || ex.Message.Contains("denied");
            if (denied)
            {
                MessageBox.Show(this,
                    "这个位置不允许写入：\r\n" + _path.Text + "\r\n\r\n" +
                    "盘符根目录（如 E:\\）、系统目录常被系统或安全软件保护，即使以管理员身份也未必能写。\r\n" +
                    "建议改成：\r\n" +
                    "　• " + Setup.DefaultDir() + "（默认，不需要管理员）\r\n" +
                    "　• 或自己建一个普通文件夹，比如 D:\\Games\\Stronghold Protocol\r\n\r\n" +
                    "（安装器会自动在所选目录下建 Stronghold Protocol 子文件夹，所以选 D:\\Games 就够了。）",
                    "无法写入这个位置", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }
            MessageBox.Show(this, ex.Message, "安装失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    internal static class Program
    {
        [STAThread]
        static int Main(string[] args)
        {
            string dir = null;
            bool silent = false;
            bool desktop = true;
            foreach (string a in args)
            {
                if (a.Equals("/S", StringComparison.OrdinalIgnoreCase)) silent = true;
                else if (a.Equals("/NODESKTOP", StringComparison.OrdinalIgnoreCase)) desktop = false;
                else if (a.StartsWith("/D=", StringComparison.OrdinalIgnoreCase)) dir = a.Substring(3).Trim('"');
            }
            try
            {
                if (silent)
                {
                    int n;
                    List<string> warns = Setup.Run(dir ?? Setup.DefaultDir(), desktop, null, out n);
                    Console.WriteLine("installed " + n + " files, total " + Pkg.TotalBytes() + " bytes");
                    foreach (string w in warns) Console.Error.WriteLine("warn: " + w);
                    return warns.Count == 0 ? 0 : 2;
                }
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Application.Run(new SetupForm());
                return 0;
            }
            catch (Exception ex)
            {
                if (!silent) MessageBox.Show(ex.ToString(), "安装失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
                else Console.Error.WriteLine(ex.Message);
                return 1;
            }
        }
    }
}
