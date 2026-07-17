using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.WinForms;
using Microsoft.Web.WebView2.Core;

namespace OscarDesktop
{
    internal static class Program
    {
        [STAThread]
        private static void Main(string[] args)
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            try
            {
                Options options = Options.Parse(args);
                Application.Run(new OscarForm(options));
            }
            catch (Exception ex)
            {
                MessageBox.Show(ex.Message, "Oscar", MessageBoxButtons.OK, MessageBoxIcon.Error);
                Environment.ExitCode = 1;
            }
        }
    }

    internal sealed class Options
    {
        public bool Mock;
        public int AutoCloseSeconds;

        public static Options Parse(string[] args)
        {
            Options options = new Options();
            for (int i = 0; i < args.Length; i++)
            {
                string arg = args[i];
                if (StringComparer.OrdinalIgnoreCase.Equals(arg, "--mock"))
                {
                    options.Mock = true;
                }
                else if (StringComparer.OrdinalIgnoreCase.Equals(arg, "--auto-close") && i + 1 < args.Length)
                {
                    int seconds;
                    if (int.TryParse(args[++i], out seconds))
                    {
                        options.AutoCloseSeconds = Math.Max(1, seconds);
                    }
                }
            }
            return options;
        }
    }

    internal sealed class OscarForm : Form
    {
        private const int BackendPort = 7861;
        private const string ApiBase = "http://127.0.0.1:7861";

        private static readonly Color WindowBg = Color.FromArgb(24, 24, 27);
        private static readonly Color TitlebarBg = Color.FromArgb(24, 24, 27);
        private static readonly Color SidebarBg = Color.FromArgb(9, 9, 11);
        private static readonly Color PanelBg = Color.FromArgb(39, 39, 42);
        private static readonly Color PanelSoft = Color.FromArgb(63, 63, 70);
        private static readonly Color ControlBg = Color.FromArgb(82, 82, 91);
        private static readonly Color TextMain = Color.FromArgb(250, 250, 250);
        private static readonly Color TextMuted = Color.FromArgb(113, 113, 122);
        private static readonly Color Line = Color.FromArgb(63, 63, 70);
        private static readonly Color Accent = Color.FromArgb(99, 102, 241);
        private static readonly Color AccentHover = Color.FromArgb(129, 140, 248);
        private static readonly Color AccentSoft = Color.FromArgb(49, 46, 129);
        private static readonly Color Success = Color.FromArgb(34, 197, 94);
        private static readonly Color Warning = Color.FromArgb(234, 179, 8);
        private static readonly Color Danger = Color.FromArgb(239, 68, 68);

        private readonly Options _options;
        private readonly JavaScriptSerializer _json = new JavaScriptSerializer();
        private readonly List<Dictionary<string, string>> _messages = new List<Dictionary<string, string>>();
        private readonly System.Windows.Forms.Timer _statusTimer = new System.Windows.Forms.Timer();
        private readonly object _processLock = new object();

        private Process _backendProcess;
        private bool _ownsBackend;
        private bool _backendReady;
        private bool _statusRefreshRunning;
        private bool _busy;
        private bool _cleanupStarted;
        private string _projectRoot;

        private Label _backendStatus;
        private Label _modelStatus;
        private Label _hardwareStatus;
        private Label _memoryStatus;
        private Label _modeStatus;
        private Label _activityLabel;
        private RichTextBox _chatBox;
        private RichTextBox _sourcesBox;
        private TextBox _inputBox;
        private Button _sendButton;
        private Button _clearButton;
        private Button _restartButton;
        private CheckBox _webCheck;
        private CheckBox _memoryCheck;
        private ComboBox _reasoningBox;
        private NumericUpDown _tokensBox;
        private NumericUpDown _temperatureBox;

        public OscarForm(Options options)
        {
            _options = options;
            _projectRoot = FindProjectRoot();

            Text = "Oscar";
            StartPosition = FormStartPosition.CenterScreen;
            MinimumSize = new Size(1080, 680);
            Size = new Size(1240, 760);
            BackColor = WindowBg;
            Font = new Font("Segoe UI", 10F, FontStyle.Regular, GraphicsUnit.Point);
            AutoScaleMode = AutoScaleMode.Dpi;

            BuildUi();
            WireEvents();
        }

        protected override async void OnShown(EventArgs e)
        {
            base.OnShown(e);
            
            try 
            {
                WebView2 webView = new WebView2();
                webView.Dock = DockStyle.Fill;
                this.Controls.Add(webView);
                webView.BringToFront();
                
                await webView.EnsureCoreWebView2Async(null);
                string token = GetApiToken();
                if (!string.IsNullOrEmpty(token))
                {
                    string escapedToken = _json.Serialize(token);
                    await webView.CoreWebView2.AddScriptToExecuteOnDocumentCreatedAsync("window.OSCAR_API_TOKEN = " + escapedToken + ";");
                }
                string distPath = Path.Combine(_projectRoot, "frontend", "dist");
                webView.CoreWebView2.SetVirtualHostNameToFolderMapping("oscar.local", distPath, CoreWebView2HostResourceAccessKind.Allow);
                webView.Source = new Uri("http://oscar.local/index.html");
            }
            catch (Exception ex)
            {
                MessageBox.Show("Ошибка загрузки WebView2: " + ex.Message);
            }

            AppendSystemMessage("Oscar Workspace\nГотов к локальной сессии. Backend поднимется автоматически, модель загрузится при первом ответе.");
            StartBackendIfNeeded();
            _statusTimer.Interval = 4000;
            _statusTimer.Start();
            RefreshStatus();

            if (_options.AutoCloseSeconds > 0)
            {
                System.Windows.Forms.Timer closer = new System.Windows.Forms.Timer();
                closer.Interval = _options.AutoCloseSeconds * 1000;
                closer.Tick += delegate
                {
                    closer.Stop();
                    Close();
                };
                closer.Start();
            }
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            _statusTimer.Stop();
            CleanupBackend();
            base.OnFormClosing(e);
        }

        private void BuildUi()
        {
            TableLayoutPanel frame = new TableLayoutPanel();
            frame.Dock = DockStyle.Fill;
            frame.BackColor = WindowBg;
            frame.ColumnCount = 1;
            frame.RowCount = 2;
            frame.RowStyles.Add(new RowStyle(SizeType.Absolute, 44F));
            frame.RowStyles.Add(new RowStyle(SizeType.Percent, 100F));
            Controls.Add(frame);

            Panel titlebar = new Panel();
            titlebar.Dock = DockStyle.Fill;
            titlebar.BackColor = TitlebarBg;
            titlebar.Paint += delegate(object sender, PaintEventArgs e)
            {
                using (Pen pen = new Pen(Line))
                {
                    e.Graphics.DrawLine(pen, 0, titlebar.Height - 1, titlebar.Width, titlebar.Height - 1);
                }
            };
            titlebar.Resize += delegate { titlebar.Invalidate(); };
            titlebar.Controls.Add(CreateTrafficLight(Color.FromArgb(255, 95, 87), new Point(16, 16)));
            titlebar.Controls.Add(CreateTrafficLight(Color.FromArgb(255, 189, 46), new Point(38, 16)));
            titlebar.Controls.Add(CreateTrafficLight(Color.FromArgb(40, 200, 64), new Point(60, 16)));
            Label titlebarTitle = CreateLabel("Oscar", 10F, FontStyle.Bold, TextMain);
            titlebarTitle.TextAlign = ContentAlignment.MiddleCenter;
            titlebarTitle.Size = new Size(220, 28);
            titlebarTitle.Location = new Point((Width - titlebarTitle.Width) / 2, 8);
            titlebar.Resize += delegate { titlebarTitle.Location = new Point((titlebar.Width - titlebarTitle.Width) / 2, 8); };
            titlebar.Controls.Add(titlebarTitle);
            Label titlebarStatus = CreateBadge("online", Success, Color.FromArgb(20, 50, 30));
            titlebarStatus.Anchor = AnchorStyles.Top | AnchorStyles.Right;
            titlebarStatus.Size = new Size(72, 26);
            titlebarStatus.Location = new Point(titlebar.Width - 92, 9);
            titlebar.Resize += delegate { titlebarStatus.Location = new Point(titlebar.Width - 92, 9); };
            titlebar.Controls.Add(titlebarStatus);
            frame.Controls.Add(titlebar, 0, 0);

            TableLayoutPanel root = new TableLayoutPanel();
            root.Dock = DockStyle.Fill;
            root.BackColor = WindowBg;
            root.ColumnCount = 3;
            root.RowCount = 1;
            root.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 260F));
            root.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100F));
            root.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 316F));
            frame.Controls.Add(root, 0, 1);

            Panel leftRail = CreateRail();
            leftRail.Padding = new Padding(14);
            leftRail.Paint += delegate(object sender, PaintEventArgs e)
            {
                using (Pen pen = new Pen(Line))
                {
                    e.Graphics.DrawLine(pen, leftRail.Width - 1, 0, leftRail.Width - 1, leftRail.Height);
                }
            };
            leftRail.Resize += delegate { leftRail.Invalidate(); };
            root.Controls.Add(leftRail, 0, 0);

            TableLayoutPanel sideLayout = new TableLayoutPanel();
            sideLayout.Dock = DockStyle.Fill;
            sideLayout.BackColor = Color.Transparent;
            sideLayout.ColumnCount = 1;
            sideLayout.RowCount = 6;
            sideLayout.RowStyles.Add(new RowStyle(SizeType.Absolute, 58F));
            sideLayout.RowStyles.Add(new RowStyle(SizeType.Absolute, 116F));
            sideLayout.RowStyles.Add(new RowStyle(SizeType.Absolute, 170F));
            sideLayout.RowStyles.Add(new RowStyle(SizeType.Percent, 100F));
            sideLayout.RowStyles.Add(new RowStyle(SizeType.Absolute, 86F));
            sideLayout.RowStyles.Add(new RowStyle(SizeType.Absolute, 34F));
            leftRail.Controls.Add(sideLayout);

            Panel brand = new Panel();
            brand.Dock = DockStyle.Fill;
            brand.BackColor = Color.Transparent;
            Label mark = CreateLabel("✦", 15F, FontStyle.Bold, Color.White);
            mark.TextAlign = ContentAlignment.MiddleCenter;
            mark.Location = new Point(0, 7);
            mark.Size = new Size(34, 34);
            mark.BackColor = Accent;
            ApplyRoundedRegion(mark, 8);
            Label title = CreateLabel("Oscar", 11F, FontStyle.Bold, TextMain);
            title.Location = new Point(44, 8);
            title.Size = new Size(178, 20);
            Label subtitle = CreateLabel("локальный агент", 8.8F, FontStyle.Regular, TextMuted);
            subtitle.Location = new Point(44, 29);
            subtitle.AutoSize = true;
            brand.Controls.Add(mark);
            brand.Controls.Add(title);
            brand.Controls.Add(subtitle);
            sideLayout.Controls.Add(brand, 0, 0);

            TableLayoutPanel nav = new TableLayoutPanel();
            nav.Dock = DockStyle.Fill;
            nav.ColumnCount = 1;
            nav.RowCount = 3;
            nav.RowStyles.Add(new RowStyle(SizeType.Absolute, 36F));
            nav.RowStyles.Add(new RowStyle(SizeType.Absolute, 36F));
            nav.RowStyles.Add(new RowStyle(SizeType.Absolute, 36F));
            nav.Controls.Add(CreateNavRow("Диалог", "1", true), 0, 0);
            nav.Controls.Add(CreateNavRow("Память", "", false), 0, 1);
            nav.Controls.Add(CreateNavRow("Источники", "0", false), 0, 2);
            sideLayout.Controls.Add(nav, 0, 1);

            TableLayoutPanel statusPanel = CreateSection("Состояние");
            _backendStatus = AddStatusRow(statusPanel, "Backend", "запуск", Warning);
            _modelStatus = AddStatusRow(statusPanel, "Модель", "ожидание", TextMuted);
            _hardwareStatus = AddStatusRow(statusPanel, "GPU/RAM", "проверка", TextMuted);
            _memoryStatus = AddStatusRow(statusPanel, "Память", "проверка", TextMuted);
            _backendStatus.Name = "BackendStatus";
            _modelStatus.Name = "ModelStatus";
            _hardwareStatus.Name = "HardwareStatus";
            _memoryStatus.Name = "MemoryStatus";
            sideLayout.Controls.Add(statusPanel, 0, 2);

            TableLayoutPanel sourcesPanel = CreateSection("Источники");
            _sourcesBox = new RichTextBox();
            _sourcesBox.Name = "SourcesOutput";
            _sourcesBox.AccessibleName = "Источники";
            _sourcesBox.BorderStyle = BorderStyle.None;
            _sourcesBox.BackColor = SidebarBg;
            _sourcesBox.ForeColor = TextMuted;
            _sourcesBox.Font = new Font("Segoe UI", 9F);
            _sourcesBox.ReadOnly = true;
            _sourcesBox.DetectUrls = true;
            _sourcesBox.Text = "Появятся после поиска или извлечения из памяти.";
            _sourcesBox.Dock = DockStyle.Fill;
            sourcesPanel.RowStyles.Add(new RowStyle(SizeType.Percent, 100F));
            sourcesPanel.Controls.Add(_sourcesBox, 0, sourcesPanel.RowCount++);
            sideLayout.Controls.Add(sourcesPanel, 0, 3);

            TableLayoutPanel sessionPanel = CreateSection("Сессия");
            _restartButton = CreateButton("Перезапустить backend", false);
            _restartButton.Name = "RestartBackendButton";
            _restartButton.AccessibleName = "Перезапустить backend";
            _restartButton.Dock = DockStyle.Fill;
            AddSectionControl(sessionPanel, _restartButton, 36F);
            _modeStatus = CreateLabel(_options.Mock ? "Mock режим включен" : "Реальная модель", 9F, FontStyle.Regular, _options.Mock ? Warning : Success);
            _modeStatus.Name = "ModeStatus";
            _modeStatus.Dock = DockStyle.Top;
            _modeStatus.Height = 26;
            AddSectionControl(sessionPanel, _modeStatus, 28F);
            sideLayout.Controls.Add(sessionPanel, 0, 4);

            _activityLabel = CreateLabel("Статус: ожидание", 8.8F, FontStyle.Regular, TextMuted);
            _activityLabel.Name = "ActivityStatus";
            _activityLabel.Dock = DockStyle.Fill;
            _activityLabel.TextAlign = ContentAlignment.MiddleLeft;
            _activityLabel.AutoEllipsis = true;
            sideLayout.Controls.Add(_activityLabel, 0, 5);

            TableLayoutPanel main = new TableLayoutPanel();
            main.Dock = DockStyle.Fill;
            main.ColumnCount = 1;
            main.RowCount = 5;
            main.RowStyles.Add(new RowStyle(SizeType.Absolute, 86F));
            main.RowStyles.Add(new RowStyle(SizeType.Absolute, 48F));
            main.RowStyles.Add(new RowStyle(SizeType.Percent, 100F));
            main.RowStyles.Add(new RowStyle(SizeType.Absolute, 60F));
            main.RowStyles.Add(new RowStyle(SizeType.Absolute, 108F));
            main.Padding = new Padding(24, 18, 24, 18);
            root.Controls.Add(main, 1, 0);

            Panel header = new Panel();
            header.Dock = DockStyle.Fill;
            header.BackColor = Color.Transparent;
            Label breadcrumb = CreateLabel("Oscar  ›  Диалог", 8.8F, FontStyle.Regular, TextMuted);
            breadcrumb.Location = new Point(0, 2);
            breadcrumb.Size = new Size(240, 20);
            Label headerTitle = CreateLabel("Новый диалог", 20F, FontStyle.Bold, TextMain);
            headerTitle.Location = new Point(0, 24);
            headerTitle.Size = new Size(320, 32);
            Label headerSub = CreateLabel("модель загрузится при первом ответе", 9.2F, FontStyle.Regular, TextMuted);
            headerSub.Location = new Point(1, 59);
            headerSub.Size = new Size(360, 22);
            _clearButton = CreateButton("Очистить", false);
            _clearButton.Name = "ClearChatButton";
            _clearButton.AccessibleName = "Очистить";
            _clearButton.Anchor = AnchorStyles.Top | AnchorStyles.Right;
            _clearButton.Size = new Size(98, 30);
            header.Resize += delegate
            {
                _clearButton.Location = new Point(header.Width - 98, 20);
            };
            header.Controls.Add(breadcrumb);
            header.Controls.Add(headerTitle);
            header.Controls.Add(headerSub);
            header.Controls.Add(_clearButton);
            main.Controls.Add(header, 0, 0);

            FlowLayoutPanel sessionStrip = new FlowLayoutPanel();
            sessionStrip.Dock = DockStyle.Fill;
            sessionStrip.FlowDirection = FlowDirection.LeftToRight;
            sessionStrip.WrapContents = true;
            sessionStrip.BackColor = Color.Transparent;
            sessionStrip.Padding = new Padding(0, 8, 0, 0);
            sessionStrip.Controls.Add(CreateFlowBadge("Готов", 76, Success, Color.FromArgb(20, 50, 30)));
            sessionStrip.Controls.Add(CreateFlowBadge("загрузка по запросу", 148, TextMuted, ControlBg));
            sessionStrip.Controls.Add(CreateFlowBadge("CUDA / CPU", 100, Success, Color.FromArgb(20, 50, 30)));
            sessionStrip.Controls.Add(CreateFlowBadge("память локально", 124, TextMuted, PanelSoft));
            main.Controls.Add(sessionStrip, 0, 1);

            _chatBox = new RichTextBox();
            _chatBox.Name = "ChatOutput";
            _chatBox.AccessibleName = "Чат";
            _chatBox.Dock = DockStyle.Fill;
            _chatBox.BorderStyle = BorderStyle.None;
            _chatBox.BackColor = PanelBg;
            _chatBox.ForeColor = TextMain;
            _chatBox.Font = new Font("Segoe UI", 10.2F);
            _chatBox.ReadOnly = true;
            _chatBox.DetectUrls = true;
            _chatBox.Padding = new Padding(14);
            main.Controls.Add(Wrap(_chatBox, 16), 0, 2);

            TableLayoutPanel suggestions = new TableLayoutPanel();
            suggestions.Dock = DockStyle.Fill;
            suggestions.ColumnCount = 3;
            suggestions.RowCount = 1;
            suggestions.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 33.33F));
            suggestions.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 33.33F));
            suggestions.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 33.34F));
            suggestions.BackColor = Color.Transparent;
            suggestions.Padding = new Padding(0, 8, 0, 8);
            suggestions.Controls.Add(CreateSuggestion("Собери свежий контекст", "Собери свежий контекст по задаче"), 0, 0);
            suggestions.Controls.Add(CreateSuggestion("Что уже в памяти?", "Что уже хранится в памяти?"), 1, 0);
            suggestions.Controls.Add(CreateSuggestion("Следующий шаг", "Разложи следующий шаг по плану"), 2, 0);
            main.Controls.Add(suggestions, 0, 3);

            Panel composer = CreateCard(12);
            composer.Dock = DockStyle.Fill;
            TableLayoutPanel composerLayout = new TableLayoutPanel();
            composerLayout.Dock = DockStyle.Fill;
            composerLayout.BackColor = Color.Transparent;
            composerLayout.ColumnCount = 2;
            composerLayout.RowCount = 1;
            composerLayout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100F));
            composerLayout.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 124F));
            _inputBox = new TextBox();
            _inputBox.Name = "PromptInput";
            _inputBox.AccessibleName = "Сообщение";
            _inputBox.Multiline = true;
            _inputBox.ScrollBars = ScrollBars.Vertical;
            _inputBox.BorderStyle = BorderStyle.None;
            _inputBox.Font = new Font("Segoe UI", 10.2F);
            _inputBox.Dock = DockStyle.Fill;
            _inputBox.BackColor = PanelBg;
            _inputBox.ForeColor = TextMain;
            _sendButton = CreateButton("Отправить", true);
            _sendButton.Name = "SendButton";
            _sendButton.AccessibleName = "Отправить";
            _sendButton.Dock = DockStyle.Fill;
            _sendButton.Enabled = false;
            composerLayout.Controls.Add(_inputBox, 0, 0);
            composerLayout.Controls.Add(_sendButton, 1, 0);
            composer.Controls.Add(composerLayout);
            main.Controls.Add(composer, 0, 4);

            Panel rightRail = CreateRail();
            rightRail.Padding = new Padding(14);
            rightRail.Paint += delegate(object sender, PaintEventArgs e)
            {
                using (Pen pen = new Pen(Line))
                {
                    e.Graphics.DrawLine(pen, 0, 0, 0, rightRail.Height);
                }
            };
            rightRail.Resize += delegate { rightRail.Invalidate(); };
            root.Controls.Add(rightRail, 2, 0);

            TableLayoutPanel rightLayout = new TableLayoutPanel();
            rightLayout.Dock = DockStyle.Fill;
            rightLayout.BackColor = Color.Transparent;
            rightLayout.ColumnCount = 1;
            rightLayout.RowCount = 5;
            rightLayout.RowStyles.Add(new RowStyle(SizeType.Absolute, 54F));
            rightLayout.RowStyles.Add(new RowStyle(SizeType.Absolute, 42F));
            rightLayout.RowStyles.Add(new RowStyle(SizeType.Absolute, 238F));
            rightLayout.RowStyles.Add(new RowStyle(SizeType.Absolute, 172F));
            rightLayout.RowStyles.Add(new RowStyle(SizeType.Percent, 100F));
            rightRail.Controls.Add(rightLayout);

            Panel inspectorHeader = new Panel();
            inspectorHeader.Dock = DockStyle.Fill;
            inspectorHeader.BackColor = Color.Transparent;
            Label inspectorCaption = CreateLabel("Inspector", 8F, FontStyle.Regular, TextMuted);
            inspectorCaption.Location = new Point(0, 6);
            inspectorCaption.Size = new Size(180, 18);
            Label inspectorTitle = CreateLabel("Сессия", 10.5F, FontStyle.Bold, TextMain);
            inspectorTitle.Location = new Point(0, 24);
            inspectorTitle.Size = new Size(180, 22);
            inspectorHeader.Controls.Add(inspectorCaption);
            inspectorHeader.Controls.Add(inspectorTitle);
            rightLayout.Controls.Add(inspectorHeader, 0, 0);
            rightLayout.Controls.Add(CreateInspectorTabs(), 0, 1);

            TableLayoutPanel settingsPanel = CreateSection("Модель");
            _webCheck = CreateCheckBox("Интернет", true);
            _memoryCheck = CreateCheckBox("Память", true);
            _webCheck.Name = "WebSearchCheck";
            _webCheck.AccessibleName = "Интернет";
            _memoryCheck.Name = "MemoryCheck";
            _memoryCheck.AccessibleName = "Память";
            _webCheck.CheckState = CheckState.Checked;
            _memoryCheck.CheckState = CheckState.Checked;
            AddSectionControl(settingsPanel, _webCheck, 30F);
            AddSectionControl(settingsPanel, _memoryCheck, 30F);

            _reasoningBox = new ComboBox();
            _reasoningBox.Name = "ReasoningBox";
            _reasoningBox.AccessibleName = "Reasoning";
            _reasoningBox.DropDownStyle = ComboBoxStyle.DropDownList;
            _reasoningBox.Items.AddRange(new object[] { "low", "medium", "high" });
            _reasoningBox.SelectedIndex = 1;
            StyleInput(_reasoningBox);
            AddSectionControl(settingsPanel, CreateField("Reasoning", _reasoningBox), 38F);

            _tokensBox = new NumericUpDown();
            _tokensBox.Name = "MaxTokensBox";
            _tokensBox.AccessibleName = "Max tokens";
            _tokensBox.Minimum = 32;
            _tokensBox.Maximum = 8192;
            _tokensBox.Value = 4096;
            _tokensBox.Increment = 64;
            StyleInput(_tokensBox);
            AddSectionControl(settingsPanel, CreateField("Max tokens", _tokensBox), 38F);

            _temperatureBox = new NumericUpDown();
            _temperatureBox.Name = "TemperatureBox";
            _temperatureBox.AccessibleName = "Temperature";
            _temperatureBox.Minimum = 0;
            _temperatureBox.Maximum = 1.5M;
            _temperatureBox.DecimalPlaces = 2;
            _temperatureBox.Increment = 0.05M;
            _temperatureBox.Value = 0.30M;
            StyleInput(_temperatureBox);
            AddSectionControl(settingsPanel, CreateField("Temperature", _temperatureBox), 38F);
            rightLayout.Controls.Add(settingsPanel, 0, 2);

            TableLayoutPanel resourcesPanel = CreateSection("Ресурсы");
            AddSectionControl(resourcesPanel, CreateStaticMetric("GPU", "см. состояние слева"), 44F);
            AddSectionControl(resourcesPanel, CreateStaticMetric("Backend", "http://127.0.0.1:7861"), 44F);
            AddSectionControl(resourcesPanel, CreateStaticMetric("UI", "native launcher"), 44F);
            rightLayout.Controls.Add(resourcesPanel, 0, 3);

            TableLayoutPanel runtimePanel = CreateSection("Runtime");
            Label runtimePath = CreateLabel(_projectRoot, 8.5F, FontStyle.Regular, TextMuted);
            runtimePath.Dock = DockStyle.Top;
            runtimePath.AutoEllipsis = true;
            AddSectionControl(runtimePanel, runtimePath, 42F);
            rightLayout.Controls.Add(runtimePanel, 0, 4);
        }

        private void WireEvents()
        {
            _sendButton.Click += delegate { SendCurrentMessage(); };
            _clearButton.Click += delegate { ClearChat(); };
            _restartButton.Click += delegate { RestartBackend(); };
            _inputBox.KeyDown += delegate(object sender, KeyEventArgs e)
            {
                if (e.KeyCode == Keys.Enter && !e.Shift)
                {
                    e.SuppressKeyPress = true;
                    SendCurrentMessage();
                }
            };
            _statusTimer.Tick += delegate { RefreshStatus(); };
        }

        private Panel CreateTrafficLight(Color color, Point location)
        {
            Panel light = new Panel();
            light.Size = new Size(12, 12);
            light.Location = location;
            light.BackColor = color;
            ApplyRoundedRegion(light, 6);
            light.Paint += delegate(object sender, PaintEventArgs e)
            {
                Rectangle rect = light.ClientRectangle;
                rect.Width -= 1;
                rect.Height -= 1;
                e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
                using (Pen pen = new Pen(Color.FromArgb(45, 0, 0, 0)))
                {
                    e.Graphics.DrawEllipse(pen, rect);
                }
            };
            return light;
        }

        private Label CreateBadge(string text, Color color, Color background)
        {
            Label badge = CreateLabel(text, 8.4F, FontStyle.Bold, color);
            badge.TextAlign = ContentAlignment.MiddleCenter;
            badge.BackColor = background;
            ApplyRoundedRegion(badge, 8);
            badge.Paint += delegate(object sender, PaintEventArgs e)
            {
                Rectangle rect = badge.ClientRectangle;
                rect.Width -= 1;
                rect.Height -= 1;
                e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
                using (GraphicsPath path = RoundedRectangle(rect, 8))
                using (Pen pen = new Pen(Color.FromArgb(60, color)))
                {
                    e.Graphics.DrawPath(pen, path);
                }
            };
            return badge;
        }

        private Label CreateFlowBadge(string text, int width, Color color, Color background)
        {
            Label badge = CreateBadge(text, color, background);
            badge.Size = new Size(width, 28);
            badge.Margin = new Padding(0, 0, 8, 0);
            return badge;
        }

        private Panel CreateNavRow(string labelText, string metaText, bool active)
        {
            Panel row = new Panel();
            row.Dock = DockStyle.Fill;
            row.Margin = new Padding(0, 0, 0, 6);
            row.BackColor = active ? Accent : Color.Transparent;
            ApplyRoundedRegion(row, 8);

            Label label = CreateLabel(labelText, 9.5F, FontStyle.Bold, active ? Color.White : TextMain);
            label.Location = new Point(12, 8);
            label.Size = new Size(150, 18);
            Label meta = CreateLabel(metaText, 8.2F, FontStyle.Regular, active ? Color.FromArgb(232, 245, 255) : TextMuted);
            meta.TextAlign = ContentAlignment.MiddleRight;
            meta.Size = new Size(46, 18);
            meta.Location = new Point(row.Width - 54, 8);
            row.Resize += delegate { meta.Location = new Point(row.Width - 54, 8); };
            row.Controls.Add(label);
            row.Controls.Add(meta);
            return row;
        }

        private Panel CreateInspectorTabs()
        {
            Panel shell = CreateCard(3);
            shell.Dock = DockStyle.Fill;
            shell.Margin = new Padding(0, 0, 0, 8);
            shell.BackColor = ControlBg;

            TableLayoutPanel tabs = new TableLayoutPanel();
            tabs.Dock = DockStyle.Fill;
            tabs.ColumnCount = 3;
            tabs.RowCount = 1;
            tabs.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 33.33F));
            tabs.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 33.33F));
            tabs.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 33.34F));
            tabs.Controls.Add(CreateTabLabel("Модель", true), 0, 0);
            tabs.Controls.Add(CreateTabLabel("Поиск", false), 1, 0);
            tabs.Controls.Add(CreateTabLabel("Ресурсы", false), 2, 0);
            shell.Controls.Add(tabs);
            return shell;
        }

        private Label CreateTabLabel(string text, bool active)
        {
            Label label = CreateLabel(text, 8.6F, FontStyle.Bold, active ? TextMain : TextMuted);
            label.Dock = DockStyle.Fill;
            label.Margin = new Padding(2);
            label.TextAlign = ContentAlignment.MiddleCenter;
            label.BackColor = active ? PanelBg : Color.Transparent;
            ApplyRoundedRegion(label, 7);
            return label;
        }

        private Panel CreatePanel()
        {
            Panel panel = new Panel();
            panel.BackColor = PanelBg;
            return panel;
        }

        private Panel CreateRail()
        {
            Panel panel = new Panel();
            panel.Dock = DockStyle.Fill;
            panel.BackColor = SidebarBg;
            return panel;
        }

        private Panel CreateCard(int padding)
        {
            Panel panel = CreatePanel();
            panel.Padding = new Padding(padding);
            AttachBorder(panel);
            return panel;
        }

        private Panel Wrap(Control child, int padding)
        {
            Panel panel = CreateCard(padding);
            panel.Dock = DockStyle.Fill;
            panel.Padding = new Padding(padding);
            child.Dock = DockStyle.Fill;
            panel.Controls.Add(child);
            return panel;
        }

        private Label CreateLabel(string text, float size, FontStyle style, Color color)
        {
            Label label = new Label();
            label.Text = text;
            label.Font = new Font("Segoe UI", size, style, GraphicsUnit.Point);
            label.ForeColor = color;
            label.BackColor = Color.Transparent;
            return label;
        }

        private Button CreateButton(string text, bool primary)
        {
            Button button = new Button();
            button.Text = text;
            button.Font = new Font("Segoe UI", 9.2F, FontStyle.Bold);
            button.FlatStyle = FlatStyle.Flat;
            button.FlatAppearance.BorderSize = 1;
            button.FlatAppearance.BorderColor = primary ? Accent : Line;
            button.FlatAppearance.MouseOverBackColor = primary ? AccentHover : ControlBg;
            button.FlatAppearance.MouseDownBackColor = primary ? AccentHover : AccentSoft;
            button.BackColor = primary ? Accent : PanelSoft;
            button.ForeColor = primary ? Color.White : TextMain;
            button.Cursor = Cursors.Hand;
            button.Margin = new Padding(0, 0, 8, 0);
            ApplyRoundedRegion(button, 8);
            return button;
        }

        private Button CreateSuggestion(string text, string prompt)
        {
            Button button = CreateButton(text, false);
            button.AutoSize = false;
            button.Dock = DockStyle.Fill;
            button.Height = 36;
            button.Margin = new Padding(0, 0, 8, 0);
            button.Padding = new Padding(12, 2, 12, 2);
            button.BackColor = PanelBg;
            button.FlatAppearance.BorderColor = Line;
            button.ForeColor = TextMain;
            button.Click += delegate
            {
                _inputBox.Text = prompt;
                _inputBox.Focus();
                _inputBox.SelectionStart = _inputBox.TextLength;
            };
            return button;
        }

        private CheckBox CreateCheckBox(string text, bool isChecked)
        {
            CheckBox check = new CheckBox();
            check.Text = text;
            check.Checked = isChecked;
            check.AutoSize = true;
            check.ForeColor = TextMain;
            check.Font = new Font("Segoe UI", 9.5F);
            check.Padding = new Padding(0, 2, 0, 2);
            return check;
        }

        private TableLayoutPanel CreateSection(string title)
        {
            TableLayoutPanel section = new TableLayoutPanel();
            section.Dock = DockStyle.Fill;
            section.ColumnCount = 1;
            section.RowCount = 1;
            section.Margin = new Padding(0, 0, 0, 12);
            section.Padding = new Padding(0, 8, 0, 0);
            section.BackColor = Color.Transparent;
            section.RowStyles.Add(new RowStyle(SizeType.Absolute, 26F));
            section.Paint += delegate(object sender, PaintEventArgs e)
            {
                using (Pen pen = new Pen(Color.FromArgb(70, Line)))
                {
                    e.Graphics.DrawLine(pen, 0, 0, section.Width, 0);
                }
            };
            section.Resize += delegate { section.Invalidate(); };

            Label label = CreateLabel(title.ToUpperInvariant(), 8.8F, FontStyle.Bold, TextMuted);
            label.Dock = DockStyle.Fill;
            label.TextAlign = ContentAlignment.MiddleLeft;
            section.Controls.Add(label, 0, 0);
            return section;
        }

        private void AddSectionControl(TableLayoutPanel panel, Control control, float height)
        {
            control.Dock = DockStyle.Top;
            panel.RowStyles.Add(new RowStyle(SizeType.Absolute, height));
            panel.Controls.Add(control, 0, panel.RowCount++);
        }

        private Label AddStatusRow(TableLayoutPanel panel, string name, string value, Color valueColor)
        {
            Label row = CreateLabel(name + ": " + value, 9.5F, FontStyle.Regular, valueColor);
            row.Dock = DockStyle.Top;
            row.AutoEllipsis = true;
            row.TextAlign = ContentAlignment.MiddleLeft;
            row.Padding = new Padding(8, 0, 8, 0);
            row.BackColor = PanelBg;
            row.Height = 30;
            AttachBorder(row);
            panel.RowStyles.Add(new RowStyle(SizeType.Absolute, 32F));
            panel.Controls.Add(row, 0, panel.RowCount++);
            return row;
        }

        private Panel CreateField(string caption, Control input)
        {
            Panel panel = new Panel();
            panel.Height = 34;
            panel.Dock = DockStyle.Top;
            Label label = CreateLabel(caption, 8.5F, FontStyle.Regular, TextMuted);
            label.Location = new Point(0, 8);
            label.Size = new Size(112, 20);
            input.Location = new Point(118, 3);
            input.Size = new Size(126, 26);
            panel.Controls.Add(label);
            panel.Controls.Add(input);
            return panel;
        }

        private Panel CreateStaticMetric(string labelText, string valueText)
        {
            Panel panel = new Panel();
            panel.Dock = DockStyle.Fill;
            panel.BackColor = PanelBg;
            panel.Padding = new Padding(10, 6, 10, 6);
            AttachBorder(panel);

            Label label = CreateLabel(labelText, 8F, FontStyle.Regular, TextMuted);
            label.Location = new Point(10, 6);
            label.Size = new Size(220, 16);
            Label value = CreateLabel(valueText, 9.2F, FontStyle.Bold, TextMain);
            value.Location = new Point(10, 22);
            value.Size = new Size(230, 18);
            value.AutoEllipsis = true;
            panel.Controls.Add(label);
            panel.Controls.Add(value);
            return panel;
        }

        private void StyleInput(Control control)
        {
            control.Font = new Font("Segoe UI", 9.5F);
            control.BackColor = PanelBg;
            control.ForeColor = TextMain;
        }

        private void AttachBorder(Control control)
        {
            ApplyRoundedRegion(control, 8);
            control.Paint += delegate(object sender, PaintEventArgs e)
            {
                Rectangle rect = control.ClientRectangle;
                rect.Width -= 1;
                rect.Height -= 1;
                e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
                using (GraphicsPath path = RoundedRectangle(rect, 8))
                using (Pen pen = new Pen(Line))
                {
                    e.Graphics.DrawPath(pen, path);
                }
            };
            control.Resize += delegate { control.Invalidate(); };
        }

        private void ApplyRoundedRegion(Control control, int radius)
        {
            control.Resize += delegate
            {
                SetRoundedRegion(control, radius);
            };
            SetRoundedRegion(control, radius);
        }

        private void SetRoundedRegion(Control control, int radius)
        {
            if (control.Width <= 0 || control.Height <= 0)
            {
                return;
            }

            Rectangle rect = new Rectangle(0, 0, control.Width, control.Height);
            GraphicsPath path = RoundedRectangle(rect, radius);
            Region oldRegion = control.Region;
            control.Region = new Region(path);
            path.Dispose();
            if (oldRegion != null)
            {
                oldRegion.Dispose();
            }
        }

        private static GraphicsPath RoundedRectangle(Rectangle rect, int radius)
        {
            GraphicsPath path = new GraphicsPath();
            int diameter = Math.Max(1, radius * 2);
            Rectangle arc = new Rectangle(rect.Left, rect.Top, diameter, diameter);

            path.AddArc(arc, 180, 90);
            arc.X = rect.Right - diameter;
            path.AddArc(arc, 270, 90);
            arc.Y = rect.Bottom - diameter;
            path.AddArc(arc, 0, 90);
            arc.X = rect.Left;
            path.AddArc(arc, 90, 90);
            path.CloseFigure();
            return path;
        }

        private void StartBackendIfNeeded()
        {
            ThreadPool.QueueUserWorkItem(delegate
            {
                if (IsHealthReady())
                {
                    _backendReady = true;
                    Ui(delegate
                    {
                        SetStatus(_backendStatus, "Backend: подключен", Success);
                        _sendButton.Enabled = true;
                        _activityLabel.Text = "Статус: backend уже был запущен";
                    });
                    return;
                }

                if (IsPortOpen("127.0.0.1", BackendPort))
                {
                    Ui(delegate
                    {
                        SetStatus(_backendStatus, "Backend: порт занят", Danger);
                        _activityLabel.Text = "Статус: порт 7861 занят не Oscar backend";
                    });
                    return;
                }

                try
                {
                    string script = Path.Combine(_projectRoot, "scripts", _options.Mock ? "backend-mock.ps1" : "backend.ps1");
                    Process process = StartPowerShell(script);
                    lock (_processLock)
                    {
                        _backendProcess = process;
                        _ownsBackend = true;
                    }
                    Ui(delegate
                    {
                        SetStatus(_backendStatus, "Backend: запуск", Warning);
                        _activityLabel.Text = "Статус: backend запускается";
                    });

                    if (WaitForBackendHealth(60))
                    {
                        _backendReady = true;
                        Ui(delegate
                        {
                            SetStatus(_backendStatus, "Backend: готов", Success);
                            _sendButton.Enabled = !_busy;
                            _activityLabel.Text = "Статус: backend готов";
                        });
                        RefreshStatus();
                    }
                    else
                    {
                        Ui(delegate
                        {
                            SetStatus(_backendStatus, "Backend: долго запускается", Warning);
                            _activityLabel.Text = "Статус: backend еще запускается";
                        });
                    }
                }
                catch (Exception ex)
                {
                    Ui(delegate
                    {
                        SetStatus(_backendStatus, "Backend: ошибка", Danger);
                        _activityLabel.Text = "Статус: " + ex.Message;
                    });
                }
            });
        }

        private Process StartPowerShell(string scriptPath)
        {
            ProcessStartInfo startInfo = new ProcessStartInfo();
            startInfo.FileName = "powershell.exe";
            startInfo.Arguments = "-NoProfile -ExecutionPolicy Bypass -File \"" + scriptPath + "\"";
            startInfo.WorkingDirectory = _projectRoot;
            startInfo.UseShellExecute = false;
            startInfo.RedirectStandardOutput = true;
            startInfo.RedirectStandardError = true;
            startInfo.CreateNoWindow = true;

            Process process = new Process();
            process.StartInfo = startInfo;
            process.EnableRaisingEvents = true;
            process.OutputDataReceived += delegate(object sender, DataReceivedEventArgs e)
            {
                if (!string.IsNullOrEmpty(e.Data))
                {
                    Ui(delegate { _activityLabel.Text = "Backend: " + TrimMiddle(e.Data, 92); });
                }
            };
            process.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs e)
            {
                if (!string.IsNullOrEmpty(e.Data))
                {
                    Ui(delegate { _activityLabel.Text = "Backend: " + TrimMiddle(e.Data, 92); });
                }
            };
            process.Exited += delegate
            {
                if (!_cleanupStarted)
                {
                    Ui(delegate
                    {
                        _backendReady = false;
                        _sendButton.Enabled = false;
                        SetStatus(_backendStatus, "Backend: остановлен", Danger);
                    });
                }
            };

            process.Start();
            process.BeginOutputReadLine();
            process.BeginErrorReadLine();
            return process;
        }

        private void RestartBackend()
        {
            if (_busy)
            {
                return;
            }

            _backendReady = false;
            _sendButton.Enabled = false;
            SetStatus(_backendStatus, "Backend: перезапуск", Warning);
            CleanupBackend();
            _cleanupStarted = false;
            StartBackendIfNeeded();
        }

        private void CleanupBackend()
        {
            if (_cleanupStarted)
            {
                return;
            }
            _cleanupStarted = true;

            lock (_processLock)
            {
                if (!_ownsBackend || _backendProcess == null)
                {
                    return;
                }

                try
                {
                    if (!_backendProcess.HasExited)
                    {
                        ProcessStartInfo startInfo = new ProcessStartInfo();
                        startInfo.FileName = "taskkill.exe";
                        startInfo.Arguments = "/PID " + _backendProcess.Id + " /T /F";
                        startInfo.UseShellExecute = false;
                        startInfo.RedirectStandardOutput = true;
                        startInfo.RedirectStandardError = true;
                        startInfo.CreateNoWindow = true;
                        using (Process killer = Process.Start(startInfo))
                        {
                            if (killer != null)
                            {
                                killer.WaitForExit(5000);
                            }
                        }
                    }
                }
                catch
                {
                }
            }
        }

        private void RefreshStatus()
        {
            if (_statusRefreshRunning)
            {
                return;
            }

            _statusRefreshRunning = true;
            ThreadPool.QueueUserWorkItem(delegate
            {
                try
                {
                    Dictionary<string, object> health = GetJson("/api/health", 2500);
                    Dictionary<string, object> hardware = GetJson("/api/hardware", 2500);
                    Ui(delegate { ApplyStatus(health, hardware); });
                }
                catch
                {
                    Ui(delegate
                    {
                        _backendReady = false;
                        _sendButton.Enabled = false;
                        SetStatus(_backendStatus, "Backend: ожидание", Warning);
                    });
                }
                finally
                {
                    _statusRefreshRunning = false;
                }
            });
        }

        private void ApplyStatus(Dictionary<string, object> health, Dictionary<string, object> hardware)
        {
            _backendReady = true;
            _sendButton.Enabled = !_busy;
            SetStatus(_backendStatus, "Backend: готов", Success);

            Dictionary<string, object> model = GetDict(health, "model");
            if (model != null)
            {
                bool loaded = GetBool(model, "loaded");
                bool mock = GetBool(model, "mock");
                string modelText = loaded ? "Модель: загружена" : "Модель: ожидание";
                if (mock)
                {
                    modelText = "Модель: mock";
                }
                SetStatus(_modelStatus, modelText, loaded || mock ? Success : TextMuted);
            }

            Dictionary<string, object> memory = GetDict(health, "memory");
            if (memory != null)
            {
                int documents = GetInt(memory, "documents");
                int chunks = GetInt(memory, "chunks");
                SetStatus(_memoryStatus, "Память: " + documents + " док / " + chunks + " фраг", TextMuted);
            }

            bool cuda = GetBool(hardware, "cuda_available");
            string gpuName = GetString(hardware, "gpu_name");
            double ram = GetDouble(hardware, "ram_available_gb");
            string gpu = string.IsNullOrEmpty(gpuName) ? (cuda ? "CUDA" : "CPU") : gpuName;
            string hardwareText = "GPU/RAM: " + TrimMiddle(gpu, 28);
            if (ram > 0)
            {
                hardwareText += " / " + ram.ToString("0.0") + "GB free";
            }
            SetStatus(_hardwareStatus, hardwareText, cuda ? Success : TextMuted);
        }

        private void SendCurrentMessage()
        {
            if (_busy)
            {
                return;
            }

            string text = _inputBox.Text.Trim();
            if (text.Length == 0)
            {
                return;
            }

            if (!_backendReady)
            {
                AppendSystemMessage("Backend еще не готов. Подожди пару секунд.");
                return;
            }

            _busy = true;
            _sendButton.Enabled = false;
            _inputBox.Clear();

            Dictionary<string, string> userMessage = MakeMessage("user", text);
            _messages.Add(userMessage);
            AppendUserMessage(text);
            BeginAssistantMessage();
            _sourcesBox.Text = "Источники готовятся...";
            _activityLabel.Text = "Статус: запрос отправлен";

            string payload = BuildChatPayload();

            ThreadPool.QueueUserWorkItem(delegate
            {
                StringBuilder answer = new StringBuilder();
                bool hadError = false;
                try
                {
                    StreamChat(payload, answer);
                }
                catch (Exception ex)
                {
                    hadError = true;
                    Ui(delegate
                    {
                        AppendAssistantToken("\nОшибка: " + ex.Message + "\n");
                        _activityLabel.Text = "Статус: ошибка запроса";
                    });
                }
                finally
                {
                    if (!hadError && answer.Length > 0)
                    {
                        _messages.Add(MakeMessage("assistant", answer.ToString()));
                    }

                    Ui(delegate
                    {
                        AppendAssistantToken("\n");
                        _busy = false;
                        _sendButton.Enabled = _backendReady;
                        _activityLabel.Text = hadError ? "Статус: готов после ошибки" : "Статус: готов";
                    });
                }
            });
        }

        private string BuildChatPayload()
        {
            Dictionary<string, object> payload = new Dictionary<string, object>();
            payload["messages"] = _messages.ToArray();
            payload["web_search"] = _webCheck.Checked;
            payload["use_memory"] = _memoryCheck.Checked;
            payload["reasoning_effort"] = Convert.ToString(_reasoningBox.SelectedItem);
            payload["max_new_tokens"] = Convert.ToInt32(_tokensBox.Value);
            payload["temperature"] = Convert.ToDouble(_temperatureBox.Value);
            payload["top_p"] = 0.9;
            return _json.Serialize(payload);
        }

        private string GetApiToken()
        {
            try
            {
                string secretsDir = Path.Combine(_projectRoot, "..", "secrets");
                string tokenFile = Path.Combine(secretsDir, "oscar_token.txt");
                if (File.Exists(tokenFile))
                {
                    string existing = File.ReadAllText(tokenFile, Encoding.UTF8).Trim().TrimStart('\uFEFF');
                    if (!string.IsNullOrEmpty(existing))
                    {
                        return existing;
                    }
                }

                Directory.CreateDirectory(secretsDir);
                string token = CreateApiToken();
                File.WriteAllText(tokenFile, token, new UTF8Encoding(false));
                return token;
            }
            catch { }
            return "";
        }

        private static string CreateApiToken()
        {
            byte[] bytes = new byte[32];
            using (RandomNumberGenerator rng = RandomNumberGenerator.Create())
            {
                rng.GetBytes(bytes);
            }

            StringBuilder builder = new StringBuilder(bytes.Length * 2);
            for (int index = 0; index < bytes.Length; index++)
            {
                builder.Append(bytes[index].ToString("x2"));
            }
            return builder.ToString();
        }

        private void StreamChat(string payload, StringBuilder answer)
        {
            HttpWebRequest request = (HttpWebRequest)WebRequest.Create(ApiBase + "/api/chat/stream");
            request.Method = "POST";
            request.ContentType = "application/json; charset=utf-8";
            request.Accept = "text/event-stream";
            request.Timeout = Timeout.Infinite;
            request.ReadWriteTimeout = Timeout.Infinite;

            string token = GetApiToken();
            if (!string.IsNullOrEmpty(token))
            {
                request.Headers["X-Oscar-Token"] = token;
            }

            byte[] body = Encoding.UTF8.GetBytes(payload);
            request.ContentLength = body.Length;
            using (Stream stream = request.GetRequestStream())
            {
                stream.Write(body, 0, body.Length);
            }

            using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
            using (Stream responseStream = response.GetResponseStream())
            using (StreamReader reader = new StreamReader(responseStream, Encoding.UTF8))
            {
                string eventName = null;
                string line;
                while ((line = reader.ReadLine()) != null)
                {
                    if (line.StartsWith("event:", StringComparison.OrdinalIgnoreCase))
                    {
                        eventName = line.Substring("event:".Length).Trim();
                    }
                    else if (line.StartsWith("data:", StringComparison.OrdinalIgnoreCase))
                    {
                        HandleSse(eventName, line.Substring("data:".Length).Trim(), answer);
                        eventName = null;
                    }
                }
            }
        }

        private void HandleSse(string eventName, string data, StringBuilder answer)
        {
            Dictionary<string, object> parsed = _json.DeserializeObject(data) as Dictionary<string, object>;
            if (parsed == null)
            {
                return;
            }

            if (StringComparer.OrdinalIgnoreCase.Equals(eventName, "status"))
            {
                string message = GetString(parsed, "message");
                Ui(delegate { _activityLabel.Text = "Статус: " + CleanBackendText(message); });
            }
            else if (StringComparer.OrdinalIgnoreCase.Equals(eventName, "sources"))
            {
                Ui(delegate { _sourcesBox.Text = RenderSources(parsed); });
            }
            else if (StringComparer.OrdinalIgnoreCase.Equals(eventName, "token"))
            {
                string token = GetString(parsed, "token");
                answer.Append(token);
                Ui(delegate { AppendAssistantToken(token); });
            }
            else if (StringComparer.OrdinalIgnoreCase.Equals(eventName, "error"))
            {
                string message = GetString(parsed, "message");
                throw new InvalidOperationException(message);
            }
        }

        private string RenderSources(Dictionary<string, object> parsed)
        {
            object rawSources;
            if (!parsed.TryGetValue("sources", out rawSources) || rawSources == null)
            {
                return "Источников нет.";
            }

            IEnumerable items = rawSources as IEnumerable;
            if (items == null)
            {
                return "Источников нет.";
            }

            StringBuilder sb = new StringBuilder();
            int count = 0;
            foreach (object item in items)
            {
                Dictionary<string, object> source = item as Dictionary<string, object>;
                if (source == null)
                {
                    continue;
                }

                count++;
                string id = Convert.ToString(GetInt(source, "id"));
                string title = GetString(source, "title");
                string url = GetString(source, "url");
                string excerpt = GetString(source, "excerpt");

                sb.Append("[").Append(id).Append("] ").Append(title).AppendLine();
                if (!string.IsNullOrEmpty(url))
                {
                    sb.AppendLine(url);
                }
                if (!string.IsNullOrEmpty(excerpt))
                {
                    sb.AppendLine(TrimMiddle(excerpt.Replace("\n", " "), 240));
                }
                sb.AppendLine();
            }

            return count == 0 ? "Источников нет." : sb.ToString().Trim();
        }

        private void AppendSystemMessage(string text)
        {
            AppendBlock("Система", text, TextMuted, Color.FromArgb(248, 250, 252));
        }

        private void AppendUserMessage(string text)
        {
            AppendBlock("Ты", text, Accent, Color.FromArgb(245, 249, 255));
        }

        private void BeginAssistantMessage()
        {
            _chatBox.SelectionStart = _chatBox.TextLength;
            _chatBox.SelectionLength = 0;
            _chatBox.SelectionColor = Success;
            _chatBox.SelectionFont = new Font(_chatBox.Font, FontStyle.Bold);
            _chatBox.AppendText((_chatBox.TextLength == 0 ? "" : "\n\n") + "Oscar\n");
            _chatBox.SelectionFont = _chatBox.Font;
            _chatBox.SelectionColor = TextMain;
            _chatBox.ScrollToCaret();
        }

        private void AppendAssistantToken(string token)
        {
            _chatBox.SelectionStart = _chatBox.TextLength;
            _chatBox.SelectionLength = 0;
            _chatBox.SelectionColor = TextMain;
            _chatBox.SelectionFont = _chatBox.Font;
            _chatBox.AppendText(token);
            _chatBox.ScrollToCaret();
        }

        private void AppendBlock(string speaker, string text, Color speakerColor, Color background)
        {
            _chatBox.SelectionStart = _chatBox.TextLength;
            _chatBox.SelectionLength = 0;
            _chatBox.SelectionBackColor = background;
            _chatBox.SelectionColor = speakerColor;
            _chatBox.SelectionFont = new Font(_chatBox.Font, FontStyle.Bold);
            _chatBox.AppendText((_chatBox.TextLength == 0 ? "" : "\n\n") + speaker + "\n");
            _chatBox.SelectionColor = TextMain;
            _chatBox.SelectionFont = _chatBox.Font;
            _chatBox.AppendText(text + "\n");
            _chatBox.SelectionBackColor = _chatBox.BackColor;
            _chatBox.ScrollToCaret();
        }

        private void ClearChat()
        {
            if (_busy)
            {
                return;
            }

            _messages.Clear();
            _chatBox.Clear();
            _sourcesBox.Text = "Появятся после поиска или извлечения из памяти.";
            AppendSystemMessage("Чат очищен. Backend и память не тронуты.");
        }

        private Dictionary<string, string> MakeMessage(string role, string content)
        {
            Dictionary<string, string> message = new Dictionary<string, string>();
            message["role"] = role;
            message["content"] = content;
            return message;
        }

        private Dictionary<string, object> GetJson(string path, int timeoutMs)
        {
            HttpWebRequest request = (HttpWebRequest)WebRequest.Create(ApiBase + path);
            request.Method = "GET";
            request.Timeout = timeoutMs;
            request.ReadWriteTimeout = timeoutMs;

            using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
            using (Stream stream = response.GetResponseStream())
            using (StreamReader reader = new StreamReader(stream, Encoding.UTF8))
            {
                return _json.DeserializeObject(reader.ReadToEnd()) as Dictionary<string, object>;
            }
        }

        private bool IsHealthReady()
        {
            try
            {
                Dictionary<string, object> health = GetJson("/api/health", 1500);
                return health != null && GetBool(health, "ok");
            }
            catch
            {
                return false;
            }
        }

        private bool WaitForBackendHealth(int timeoutSeconds)
        {
            DateTime deadline = DateTime.UtcNow.AddSeconds(timeoutSeconds);
            while (DateTime.UtcNow < deadline)
            {
                if (IsHealthReady())
                {
                    return true;
                }
                Thread.Sleep(1000);
            }
            return false;
        }

        private bool IsPortOpen(string host, int port)
        {
            try
            {
                using (TcpClient client = new TcpClient())
                {
                    IAsyncResult result = client.BeginConnect(host, port, null, null);
                    bool connected = result.AsyncWaitHandle.WaitOne(500);
                    if (!connected)
                    {
                        return false;
                    }
                    client.EndConnect(result);
                    return true;
                }
            }
            catch
            {
                return false;
            }
        }

        private static string FindProjectRoot()
        {
            string dir = AppDomain.CurrentDomain.BaseDirectory;
            for (int i = 0; i < 8 && !string.IsNullOrEmpty(dir); i++)
            {
                if (File.Exists(Path.Combine(dir, "scripts", "backend.ps1")) &&
                    Directory.Exists(Path.Combine(dir, "backend")))
                {
                    return Path.GetFullPath(dir);
                }

                DirectoryInfo parent = Directory.GetParent(dir);
                dir = parent == null ? null : parent.FullName;
            }

            throw new DirectoryNotFoundException("Положи Oscar.exe в папку проекта Oscar.");
        }

        private void SetStatus(Label label, string text, Color color)
        {
            label.Text = text;
            label.ForeColor = color;
        }

        private void Ui(Action action)
        {
            if (IsDisposed)
            {
                return;
            }

            try
            {
                if (InvokeRequired)
                {
                    BeginInvoke(action);
                }
                else
                {
                    action();
                }
            }
            catch
            {
            }
        }

        private static Dictionary<string, object> GetDict(Dictionary<string, object> source, string key)
        {
            object value;
            if (source != null && source.TryGetValue(key, out value))
            {
                return value as Dictionary<string, object>;
            }
            return null;
        }

        private static string GetString(Dictionary<string, object> source, string key)
        {
            object value;
            if (source != null && source.TryGetValue(key, out value) && value != null)
            {
                return Convert.ToString(value);
            }
            return string.Empty;
        }

        private static bool GetBool(Dictionary<string, object> source, string key)
        {
            object value;
            if (source != null && source.TryGetValue(key, out value) && value != null)
            {
                try
                {
                    return Convert.ToBoolean(value);
                }
                catch
                {
                    return false;
                }
            }
            return false;
        }

        private static int GetInt(Dictionary<string, object> source, string key)
        {
            object value;
            if (source != null && source.TryGetValue(key, out value) && value != null)
            {
                try
                {
                    return Convert.ToInt32(value);
                }
                catch
                {
                    return 0;
                }
            }
            return 0;
        }

        private static double GetDouble(Dictionary<string, object> source, string key)
        {
            object value;
            if (source != null && source.TryGetValue(key, out value) && value != null)
            {
                try
                {
                    return Convert.ToDouble(value);
                }
                catch
                {
                    return 0;
                }
            }
            return 0;
        }

        private static string TrimMiddle(string text, int max)
        {
            if (string.IsNullOrEmpty(text) || text.Length <= max)
            {
                return text;
            }

            int keep = Math.Max(8, (max - 3) / 2);
            return text.Substring(0, keep) + "..." + text.Substring(text.Length - keep);
        }

        private static string CleanBackendText(string text)
        {
            if (string.IsNullOrEmpty(text))
            {
                return "работа";
            }

            if (text.IndexOf("Р", StringComparison.Ordinal) >= 0)
            {
                if (text.IndexOf("Готов", StringComparison.OrdinalIgnoreCase) < 0 &&
                    text.IndexOf("Генер", StringComparison.OrdinalIgnoreCase) < 0)
                {
                    return "локальная обработка";
                }
            }

            return text;
        }
    }
}
