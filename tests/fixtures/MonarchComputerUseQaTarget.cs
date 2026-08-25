using System;
using System.Drawing;
using System.Windows.Forms;

internal static class MonarchComputerUseQaTarget
{
    [STAThread]
    private static void Main(string[] args)
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        string title = args.Length > 0 ? args[0] : "Monarch Computer Use QA";
        using (Form form = new Form())
        using (Label status = new Label())
        using (TextBox editor = new TextBox())
        using (Button commit = new Button())
        {
            form.Text = title;
            form.Name = "monarchComputerUseQa";
            form.StartPosition = FormStartPosition.Manual;
            form.Location = new Point(180, 160);
            form.Size = new Size(520, 260);
            form.TopMost = true;

            status.Name = "qaStatus";
            status.Text = "idle";
            status.Location = new Point(30, 30);
            status.AutoSize = true;

            editor.Name = "qaInput";
            editor.AccessibleName = "QA editor";
            editor.Location = new Point(30, 75);
            editor.Size = new Size(300, 28);

            commit.Name = "qaCommit";
            commit.Text = "Commit";
            commit.Location = new Point(350, 72);
            commit.Size = new Size(110, 34);
            commit.Click += delegate { status.Text = "clicked"; };
            editor.TextChanged += delegate { status.Text = "typed:" + editor.Text; };

            form.Controls.Add(status);
            form.Controls.Add(editor);
            form.Controls.Add(commit);
            form.Shown += delegate { form.Activate(); };
            Application.Run(form);
        }
    }
}
