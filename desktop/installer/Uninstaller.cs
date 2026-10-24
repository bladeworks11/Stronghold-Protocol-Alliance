using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Text;
using Microsoft.Win32;

// 卸载程序（安装时随负载一起放进安装目录，exe 由 csc 编译）
// 做四件事：删桌面快捷方式、删开始菜单组、删「应用和功能」注册表项、删整个安装目录。
// 删目录时自己还在里面，所以最后交给一个 cmd 进程延时删除，自己先退出。

namespace SPUninstall
{
    internal static class Program
    {
        const string AppName = "卫戍协议：盟约";
        const string RegKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\StrongholdProtocol";

        static int Main(string[] args)
        {
            bool silent = Array.IndexOf(args, "/S") >= 0;
            string dir = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
            try
            {
                if (!silent)
                {
                    Console.OutputEncoding = Encoding.UTF8;
                    Console.WriteLine();
                    Console.WriteLine("  卸载 " + AppName);
                    Console.WriteLine("  ----------------------------------------");
                    Console.WriteLine("  安装目录：" + dir);
                    Console.Write("  确认卸载？(Y/n) ");
                    string ans = Console.ReadLine();
                    if (!string.IsNullOrEmpty(ans) && ans.Trim().ToLower() != "y")
                    {
                        Console.WriteLine("  已取消。");
                        return 0;
                    }
                }

                string desktop = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), AppName + ".lnk");
                TryDelete(desktop);
                string group = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), AppName);
                TryDeleteDir(group);
                try { Registry.CurrentUser.DeleteSubKeyTree(RegKey, false); } catch { }

                if (!silent) Console.WriteLine("  正在删除文件…");
                // 先尽量删干净（自己删不掉就留给 cmd）
                foreach (string file in Directory.GetFiles(dir, "*", SearchOption.AllDirectories))
                {
                    string self = Assembly.GetExecutingAssembly().Location;
                    if (string.Equals(file, self, StringComparison.OrdinalIgnoreCase)) continue;
                    try { File.SetAttributes(file, FileAttributes.Normal); File.Delete(file); } catch { }
                }

                // 交给 cmd：等本进程退出后把目录整体删掉
                string cmd = "/c ping -n 3 127.0.0.1 >nul & rmdir /s /q \"" + dir + "\"";
                ProcessStartInfo psi = new ProcessStartInfo("cmd.exe", cmd);
                psi.WindowStyle = ProcessWindowStyle.Hidden;
                psi.CreateNoWindow = true;
                Process.Start(psi);

                if (!silent)
                {
                    Console.WriteLine("  已卸载（设置与缓存一并删除）。");
                    Environment.Exit(0);
                }
                return 0;
            }
            catch (Exception ex)
            {
                if (!silent) Console.WriteLine("  卸载失败：" + ex.Message);
                return 1;
            }
        }

        static void TryDelete(string path) { try { if (File.Exists(path)) File.Delete(path); } catch { } }
        static void TryDeleteDir(string path) { try { if (Directory.Exists(path)) Directory.Delete(path, true); } catch { } }
    }
}
