// The windowless program that stands in for the launcher on the taskbar and in the Start menu.
// It does one thing: start `node <launcher script>` with no console and leave the stage. The
// launcher itself (bin/launch.mjs) does the work and reports its own failures.
//
// bin/setup-launcher.mjs fills in the two placeholders and compiles this file with the C#
// compiler Windows ships (csc.exe), with the icon it takes from the installed ZCode. So the
// repository keeps the source, never a binary and never Z.AI's icon.
//
// C# 5 only: that is what the compiler of .NET Framework 4 understands.
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Text;
using System.Windows.Forms;

[assembly: AssemblyTitle("__TITLE__")]
[assembly: AssemblyDescription("__DESCRIPTION__")]
[assembly: AssemblyProduct("__TITLE__")]
[assembly: AssemblyCompany("")]
[assembly: AssemblyCopyright("")]
[assembly: AssemblyVersion("0.1.0.0")]
[assembly: AssemblyFileVersion("0.1.0.0")]

internal static class Program
{
    // Next to this program: the path of the launcher script, one line.
    private const string PathFile = "launch-path.txt";
    // What stopped this program from starting the launcher, for whoever looks afterwards.
    private const string ErrorLog = "launcher-error.log";

    [STAThread]
    private static int Main()
    {
        string home = AppDomain.CurrentDomain.BaseDirectory;
        string script = FirstLine(Path.Combine(home, PathFile));
        if (script == null)
        {
            return Fail(home, "找不到启动脚本的位置。" + Environment.NewLine + Environment.NewLine
                + Path.Combine(home, PathFile) + " 不存在或是空的。重新运行一次安装命令即可修复。");
        }
        if (!File.Exists(script))
        {
            return Fail(home, "启动脚本不在记录的位置了：" + Environment.NewLine + script + Environment.NewLine + Environment.NewLine
                + "插件可能被更新到了别的目录，或者被移走了。重新运行一次安装命令即可修复。");
        }

        ProcessStartInfo start = new ProcessStartInfo("node", "\"" + script + "\"");
        start.UseShellExecute = false;
        start.CreateNoWindow = true;
        start.WindowStyle = ProcessWindowStyle.Hidden;
        start.WorkingDirectory = Path.GetDirectoryName(script);
        // Tells the launcher to report what went wrong in a message box of its own: there is no
        // console for its output.
        start.EnvironmentVariables["ZCODE_APPEARANCE_NO_CONSOLE"] = "1";
        try
        {
            Process.Start(start);
            return 0;
        }
        catch (Win32Exception err)
        {
            return Fail(home, "启动器需要 Node.js 22 或更新版本，并且 node 要在 PATH 里。" + Environment.NewLine + Environment.NewLine
                + err.Message);
        }
    }

    // The first line that says something, or null when there is none.
    private static string FirstLine(string file)
    {
        try
        {
            string[] lines = File.ReadAllLines(file, Encoding.UTF8);
            for (int i = 0; i < lines.Length; i++)
            {
                string line = lines[i].Trim();
                if (line.Length > 0)
                {
                    return line;
                }
            }
            return null;
        }
        catch (Exception)
        {
            return null;
        }
    }

    private static int Fail(string home, string message)
    {
        try
        {
            File.AppendAllText(Path.Combine(home, ErrorLog), message + Environment.NewLine + DateTime.Now.ToString("s") + Environment.NewLine, Encoding.UTF8);
        }
        catch (Exception)
        {
            // The log is a courtesy; the message box says it anyway.
        }
        // A test or a script that cannot answer a dialog asks for silence: the message is in
        // the log either way.
        if (Environment.GetEnvironmentVariable("ZCODE_APPEARANCE_LAUNCHER_QUIET") != "1")
        {
            MessageBox.Show(message, "__TITLE__", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
        return 1;
    }
}
