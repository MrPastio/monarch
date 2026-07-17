import {
  Activity,
  Bot,
  Box,
  BrainCircuit,
  Check,
  CircleGauge,
  Cpu,
  Database,
  FileText,
  Fingerprint,
  FolderKanban,
  HardDrive,
  Languages,
  LockKeyhole,
  MemoryStick,
  MessageCircle,
  Mic2,
  Network,
  ScanLine,
  Search,
  Send,
  ShieldCheck,
  Sparkles,
  TerminalSquare,
  Workflow,
  WifiOff,
} from "lucide-react";
import {
  AbsoluteFill,
  Easing,
  interpolate,
  useCurrentFrame,
} from "remotion";
import {
  Copy,
  Glass,
  Headline,
  IconTile,
  Kicker,
  Logo,
  Pill,
  ProgressLine,
  SceneIndex,
  Stage,
  enter,
  pulse,
} from "./components";
import { COLORS, EASE } from "./theme";

const ease = Easing.bezier(...EASE);

export const HeroScene: React.FC = () => {
  const frame = useCurrentFrame();
  const title = enter(frame, 24, 42);
  const ring = interpolate(frame, [0, 180], [0.82, 1.08], {
    easing: Easing.inOut(Easing.sin),
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <Stage accent="gold">
      <AbsoluteFill style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
        {[620, 470, 330].map((size, index) => (
          <div
            key={size}
            style={{
              position: "absolute",
              width: size,
              height: size,
              borderRadius: "50%",
              border: `1px solid rgba(255,194,71,${0.14 + index * 0.05})`,
              scale: ring * (1 - index * 0.025),
              opacity: enter(frame, index * 8, 30),
            }}
          />
        ))}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 30,
            zIndex: 2,
          }}
        >
          <Logo size={210} delay={4} />
          <div
            style={{
              fontSize: 116,
              lineHeight: 0.9,
              letterSpacing: 24,
              paddingLeft: 24,
              fontWeight: 760,
              color: COLORS.white,
              opacity: title,
              translate: `0px ${interpolate(title, [0, 1], [34, 0])}px`,
            }}
          >
            MONARCH
          </div>
          <div
            style={{
              fontSize: 38,
              color: COLORS.muted,
              fontWeight: 470,
              letterSpacing: 0.4,
              opacity: enter(frame, 44, 34),
            }}
          >
            Локальная AI-экосистема, которая работает на тебя
          </div>
          <div style={{ display: "flex", gap: 14, marginTop: 8 }}>
            <Pill icon={WifiOff} delay={64} active>Local-first</Pill>
            <Pill icon={Workflow} delay={72}>Модульная</Pill>
            <Pill icon={ShieldCheck} delay={80}>Защищённая</Pill>
          </div>
        </div>
        <div
          style={{
            position: "absolute",
            bottom: 54,
            fontSize: 18,
            letterSpacing: 5,
            textTransform: "uppercase",
            color: "rgba(255,255,255,.36)",
            opacity: enter(frame, 92, 30),
          }}
        >
          Project presentation · 2026
        </div>
      </AbsoluteFill>
    </Stage>
  );
};

export const LocalFirstScene: React.FC = () => {
  const frame = useCurrentFrame();
  const device = enter(frame, 32, 38);
  const orbit = interpolate(frame, [0, 180], [0, 12], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <Stage>
      <SceneIndex number="01" label="Local-first" />
      <div style={{ height: "100%", display: "grid", gridTemplateColumns: "0.92fr 1.08fr", gap: 92, alignItems: "center" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 32 }}>
          <Kicker>Приватность по умолчанию</Kicker>
          <Headline size={96} width={720}>Вся сила — рядом.</Headline>
          <Copy width={650} size={36}>
            Модели, память, логи и настройки живут локально. Ты сохраняешь скорость, контекст и контроль.
          </Copy>
          <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginTop: 12 }}>
            <Pill icon={HardDrive} delay={54} active>На устройстве</Pill>
            <Pill icon={WifiOff} delay={62}>Без облачной зависимости</Pill>
          </div>
        </div>

        <div style={{ position: "relative", height: 720, display: "grid", placeItems: "center" }}>
          <div
            style={{
              position: "absolute",
              width: 620,
              height: 620,
              borderRadius: "50%",
              border: "1px dashed rgba(255,194,71,.22)",
              rotate: `${orbit}deg`,
              scale: pulse(frame, 120, 0.985, 1.015),
              opacity: device,
            }}
          />
          <Glass
            glow
            style={{
              width: 590,
              height: 420,
              padding: 30,
              opacity: device,
              scale: interpolate(device, [0, 1], [0.82, 1]),
              translate: `${interpolate(device, [0, 1], [60, 0])}px 0px`,
            }}
          >
            <div style={{ height: 44, display: "flex", alignItems: "center", justifyContent: "space-between", borderBottom: "1px solid rgba(255,255,255,.08)" }}>
              <div style={{ display: "flex", gap: 8 }}>
                {[COLORS.orange, COLORS.gold, "#3B3B38"].map((color) => <span key={color} style={{ width: 11, height: 11, borderRadius: "50%", background: color }} />)}
              </div>
              <span style={{ fontSize: 17, color: COLORS.muted, letterSpacing: 1.4 }}>LOCAL RUNTIME</span>
            </div>
            <div style={{ height: 305, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 24 }}>
              <div style={{ width: 118, height: 118, borderRadius: 34, display: "grid", placeItems: "center", background: "rgba(255,138,0,.12)", border: "1px solid rgba(255,194,71,.38)" }}>
                <Cpu size={64} color={COLORS.gold} strokeWidth={1.7} />
              </div>
              <div style={{ fontSize: 34, fontWeight: 730 }}>Monarch Runtime</div>
              <div style={{ width: 290 }}>
                <ProgressLine progress={interpolate(frame, [50, 118], [0, 1], { easing: ease, extrapolateLeft: "clamp", extrapolateRight: "clamp" })} />
              </div>
              <span style={{ fontSize: 21, color: COLORS.muted }}>Готов · локальная модель активна</span>
            </div>
          </Glass>
          <IconTile icon={Database} label="Память" detail="локально" delay={58} active style={{ position: "absolute", left: 0, top: 116, width: 228 }} />
          <IconTile icon={FileText} label="Логи" detail="под контролем" delay={68} style={{ position: "absolute", right: 0, top: 128, width: 248 }} />
          <IconTile icon={LockKeyhole} label="Секреты" detail="не в облаке" delay={78} style={{ position: "absolute", right: 4, bottom: 80, width: 250 }} />
        </div>
      </div>
    </Stage>
  );
};

export const CoreScene: React.FC = () => {
  const frame = useCurrentFrame();
  const routeProgress = interpolate(frame, [44, 174], [0, 1], {
    easing: Easing.bezier(0.45, 0, 0.55, 1),
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const nodes = [
    { label: "Намерение", detail: "понимает задачу", icon: MessageCircle },
    { label: "Router Mesh", detail: "оценивает контекст", icon: Workflow },
    { label: "Модель", detail: "выбирает профиль", icon: BrainCircuit },
    { label: "Capability", detail: "выполняет действие", icon: Sparkles },
  ];

  return (
    <Stage accent="gold">
      <SceneIndex number="02" label="Умное ядро" />
      <div style={{ display: "flex", flexDirection: "column", height: "100%", gap: 30 }}>
        <Kicker>Control plane</Kicker>
        <Headline size={88} width={1200}>Один запрос. Умный маршрут.</Headline>
        <Copy width={1100} size={34}>
          Monarch понимает намерение, выбирает подходящую модель и передаёт работу нужному модулю.
        </Copy>
        <Glass glow style={{ marginTop: 30, flex: 1, padding: "52px 58px", display: "flex", alignItems: "center" }}>
          <div style={{ position: "absolute", left: 150, right: 150, top: "50%", translate: "0px -2px" }}>
            <ProgressLine progress={routeProgress} />
          </div>
          <div style={{ width: "100%", display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 38, zIndex: 2 }}>
            {nodes.map(({ label, detail, icon: Icon }, index) => {
              const threshold = index / (nodes.length - 1);
              const lit = interpolate(routeProgress, [Math.max(0, threshold - 0.11), threshold + 0.03], [0, 1], {
                extrapolateLeft: "clamp",
                extrapolateRight: "clamp",
              });
              const appear = enter(frame, 30 + index * 10, 30);
              return (
                <div key={label} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 20, opacity: appear }}>
                  <div
                    style={{
                      width: 132,
                      height: 132,
                      borderRadius: 40,
                      display: "grid",
                      placeItems: "center",
                      background: `linear-gradient(145deg, rgba(255,138,0,${0.06 + lit * 0.16}), rgba(255,255,255,.035))`,
                      border: `1px solid rgba(255,194,71,${0.15 + lit * 0.52})`,
                      boxShadow: `0 0 ${Math.round(lit * 56)}px rgba(255,138,0,${lit * 0.28})`,
                      scale: 0.94 + lit * 0.08,
                    }}
                  >
                    <Icon size={64} strokeWidth={1.8} color={lit > 0.45 ? COLORS.gold : COLORS.muted} />
                  </div>
                  <div style={{ fontSize: 29, fontWeight: 740, color: lit > 0.4 ? COLORS.white : COLORS.muted }}>{label}</div>
                  <div style={{ fontSize: 20, color: COLORS.muted, textAlign: "center" }}>{detail}</div>
                </div>
              );
            })}
          </div>
          <div
            style={{
              position: "absolute",
              right: 42,
              top: 34,
              display: "flex",
              alignItems: "center",
              gap: 10,
              fontSize: 18,
              color: COLORS.gold,
              opacity: enter(frame, 154, 24),
            }}
          >
            <Check size={20} /> Адаптивный выбор завершён
          </div>
        </Glass>
      </div>
    </Stage>
  );
};

export const OscarScene: React.FC = () => {
  const frame = useCurrentFrame();
  const windowIn = enter(frame, 18, 38);
  const userIn = enter(frame, 62, 24);
  const answerIn = enter(frame, 88, 28);
  const words = "Понял контекст. Подключаю Workspace и Memory, затем соберу результат локально.".split(" ");
  const visibleWords = Math.floor(interpolate(frame, [104, 176], [0, words.length], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  }));

  return (
    <Stage>
      <SceneIndex number="03" label="Oscar" />
      <div style={{ display: "flex", flexDirection: "column", height: "100%", gap: 26 }}>
        <div style={{ display: "flex", alignItems: "end", justifyContent: "space-between" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
            <Kicker>Интеллектуальный слой</Kicker>
            <Headline size={82} width={1000}>Oscar понимает задачу целиком.</Headline>
          </div>
          <Pill icon={Bot} delay={44} active>Локально · готов</Pill>
        </div>

        <Glass
          glow
          style={{
            flex: 1,
            display: "grid",
            gridTemplateColumns: "250px 1fr 270px",
            overflow: "hidden",
            opacity: windowIn,
            scale: interpolate(windowIn, [0, 1], [0.91, 1]),
            translate: `0px ${interpolate(windowIn, [0, 1], [40, 0])}px`,
          }}
        >
          <div style={{ padding: 28, borderRight: "1px solid rgba(255,255,255,.08)", background: "rgba(255,255,255,.018)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 38 }}>
              <Logo size={46} glow={false} />
              <div>
                <div style={{ fontSize: 23, fontWeight: 760 }}>Oscar</div>
                <div style={{ fontSize: 15, color: COLORS.muted }}>local AI workspace</div>
              </div>
            </div>
            {["Диалог", "Память", "Проект", "Защита", "Модели"].map((label, index) => (
              <div
                key={label}
                style={{
                  height: 52,
                  borderRadius: 14,
                  display: "flex",
                  alignItems: "center",
                  padding: "0 16px",
                  marginBottom: 7,
                  gap: 12,
                  color: index === 0 ? COLORS.yellow : COLORS.muted,
                  background: index === 0 ? "rgba(255,138,0,.10)" : "transparent",
                  border: index === 0 ? "1px solid rgba(255,194,71,.30)" : "1px solid transparent",
                  fontSize: 19,
                }}
              >
                {index === 0 ? <MessageCircle size={20} /> : index === 1 ? <Database size={20} /> : index === 2 ? <FolderKanban size={20} /> : index === 3 ? <ShieldCheck size={20} /> : <Cpu size={20} />}
                {label}
              </div>
            ))}
          </div>

          <div style={{ padding: "32px 44px", display: "flex", flexDirection: "column" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", paddingBottom: 20, borderBottom: "1px solid rgba(255,255,255,.07)" }}>
              <span style={{ fontSize: 21, fontWeight: 680 }}>Новый диалог</span>
              <div style={{ display: "flex", gap: 8 }}>
                <Pill icon={CircleGauge} delay={34}>Auto</Pill>
                <Pill icon={BrainCircuit} delay={42} active>Deep Thinking</Pill>
              </div>
            </div>
            <div style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "center", gap: 20 }}>
              <div
                style={{
                  alignSelf: "flex-end",
                  maxWidth: 590,
                  padding: "18px 22px",
                  borderRadius: "22px 22px 6px 22px",
                  background: "rgba(255,255,255,.075)",
                  border: "1px solid rgba(255,255,255,.10)",
                  fontSize: 25,
                  opacity: userIn,
                  translate: `${interpolate(userIn, [0, 1], [24, 0])}px 0px`,
                }}
              >
                Собери презентацию всего проекта
              </div>
              <div
                style={{
                  alignSelf: "flex-start",
                  maxWidth: 690,
                  padding: "20px 23px",
                  borderRadius: "22px 22px 22px 6px",
                  background: "rgba(255,138,0,.08)",
                  border: "1px solid rgba(255,194,71,.24)",
                  fontSize: 24,
                  lineHeight: 1.45,
                  minHeight: 86,
                  opacity: answerIn,
                  translate: `${interpolate(answerIn, [0, 1], [-24, 0])}px 0px`,
                }}
              >
                {words.slice(0, visibleWords).join(" ")}
                {visibleWords < words.length ? <span style={{ color: COLORS.gold }}> ●</span> : null}
              </div>
            </div>
            <div style={{ height: 66, borderRadius: 20, border: "1px solid rgba(255,255,255,.10)", display: "flex", alignItems: "center", padding: "0 20px", color: COLORS.muted, fontSize: 19 }}>
              Сообщение Oscar…
              <div style={{ marginLeft: "auto", width: 42, height: 42, borderRadius: 14, display: "grid", placeItems: "center", background: "rgba(255,138,0,.14)", color: COLORS.gold }}>
                <Send size={21} />
              </div>
            </div>
          </div>

          <div style={{ padding: 28, borderLeft: "1px solid rgba(255,255,255,.08)", background: "rgba(255,255,255,.014)" }}>
            <div style={{ fontSize: 16, color: COLORS.muted, letterSpacing: 2.8, textTransform: "uppercase", marginBottom: 28 }}>Контекст</div>
            <IconTile icon={FolderKanban} label="Проект" detail="подключён" delay={78} active style={{ marginBottom: 12 }} />
            <IconTile icon={Database} label="Память" detail="найден контекст" delay={92} style={{ marginBottom: 12 }} />
            <IconTile icon={Cpu} label="Модель" detail="выбрана автоматически" delay={106} />
          </div>
        </Glass>
      </div>
    </Stage>
  );
};

export const ModulesScene: React.FC = () => {
  const frame = useCurrentFrame();
  const modules = [
    { label: "Workspace", detail: "файлы и проекты", icon: FolderKanban, x: 40, y: 40 },
    { label: "Memory", detail: "долгий контекст", icon: Database, x: 404, y: 16 },
    { label: "Models", detail: "локальные профили", icon: BrainCircuit, x: 760, y: 76 },
    { label: "Voice", detail: "голосовое управление", icon: Mic2, x: 780, y: 424 },
    { label: "Telegram", detail: "задачи на связи", icon: Send, x: 404, y: 500 },
    { label: "Diagnostics", detail: "здоровье системы", icon: Activity, x: 20, y: 416 },
  ];
  const line = interpolate(frame, [34, 150], [0, 1], {
    easing: Easing.bezier(0.45, 0, 0.55, 1),
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <Stage accent="gold">
      <SceneIndex number="04" label="Модули" />
      <div style={{ display: "grid", gridTemplateColumns: "610px 1fr", gap: 76, height: "100%", alignItems: "center" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 30 }}>
          <Kicker>Federated system</Kicker>
          <Headline size={90} width={600}>Каждый модуль силён сам.</Headline>
          <Copy width={580} size={34}>Вместе они превращаются в единую персональную экосистему с общими контрактами и безопасным выполнением.</Copy>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            <Pill icon={Box} delay={54} active>Расширяемая</Pill>
            <Pill icon={Workflow} delay={64}>Согласованная</Pill>
          </div>
        </div>
        <div style={{ position: "relative", width: 1064, height: 690 }}>
          <svg viewBox="0 0 1064 690" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", overflow: "visible" }}>
            {modules.map((module) => (
              <line
                key={module.label}
                x1="532"
                y1="345"
                x2={module.x + 120}
                y2={module.y + 48}
                stroke="rgba(255,194,71,.34)"
                strokeWidth="2"
                strokeDasharray="700"
                strokeDashoffset={700 - line * 700}
              />
            ))}
          </svg>
          <div style={{ position: "absolute", left: 398, top: 208, width: 268, height: 268, borderRadius: "50%", border: "1px solid rgba(255,194,71,.26)", display: "grid", placeItems: "center", scale: pulse(frame, 120, 0.98, 1.025), boxShadow: "0 0 100px rgba(255,138,0,.16)" }}>
            <div style={{ width: 196, height: 196, borderRadius: "50%", display: "grid", placeItems: "center", background: "radial-gradient(circle, rgba(255,138,0,.16), rgba(12,12,12,.82))", border: "1px solid rgba(255,194,71,.42)" }}>
              <Logo size={128} delay={18} />
            </div>
          </div>
          {modules.map((module, index) => (
            <IconTile
              key={module.label}
              icon={module.icon}
              label={module.label}
              detail={module.detail}
              delay={44 + index * 12}
              active={index === 0 || index === 2}
              style={{ position: "absolute", left: module.x, top: module.y, width: 258 }}
            />
          ))}
        </div>
      </div>
    </Stage>
  );
};

export const SecurityScene: React.FC = () => {
  const frame = useCurrentFrame();
  const scan = interpolate(frame % 120, [0, 120], [-170, 170]);
  const radar = interpolate(frame, [0, 210], [0, 16], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const sensors = [
    { icon: TerminalSquare, label: "Процессы", left: 8, top: 72 },
    { icon: Network, label: "Сеть", left: 404, top: 14 },
    { icon: HardDrive, label: "Устройства", left: 452, top: 424 },
    { icon: Fingerprint, label: "Целостность", left: 2, top: 466 },
  ];

  return (
    <Stage>
      <SceneIndex number="05" label="Security" />
      <div style={{ display: "grid", gridTemplateColumns: "760px 1fr", gap: 84, height: "100%", alignItems: "center" }}>
        <div style={{ position: "relative", height: 730 }}>
          <div style={{ position: "absolute", left: 136, top: 92, width: 500, height: 500, borderRadius: "50%", border: "1px dashed rgba(255,194,71,.22)", rotate: `${radar}deg` }} />
          <div style={{ position: "absolute", left: 190, top: 146, width: 392, height: 392, borderRadius: "50%", border: "1px solid rgba(255,255,255,.08)", display: "grid", placeItems: "center", background: "radial-gradient(circle, rgba(255,138,0,.12), rgba(5,5,5,.25) 62%, transparent 63%)" }}>
            <Glass glow style={{ width: 270, height: 300, display: "grid", placeItems: "center", overflow: "hidden", opacity: enter(frame, 20, 36), scale: interpolate(enter(frame, 20, 36), [0, 1], [0.78, 1]) }}>
              <ShieldCheck size={142} strokeWidth={1.35} color={COLORS.gold} />
              <div style={{ position: "absolute", width: 300, height: 2, top: "50%", left: -15, translate: `0px ${scan}px`, background: `linear-gradient(90deg, transparent, ${COLORS.gold}, transparent)`, boxShadow: `0 0 22px ${COLORS.orange}` }} />
              <span style={{ position: "absolute", bottom: 28, fontSize: 20, color: COLORS.yellow, fontWeight: 680 }}>Защита активна</span>
            </Glass>
          </div>
          {sensors.map((sensor, index) => (
            <IconTile key={sensor.label} icon={sensor.icon} label={sensor.label} delay={52 + index * 14} active={index === 1} style={{ position: "absolute", left: sensor.left, top: sensor.top, width: 232 }} />
          ))}
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 28 }}>
          <Kicker>Monarch Security</Kicker>
          <Headline size={88} width={760}>Защита встроена в архитектуру.</Headline>
          <Copy width={720} size={34}>Сенсоры наблюдают, Permission Gate сохраняет контроль, а аудит фиксирует важные решения.</Copy>
          <div style={{ display: "grid", gap: 12, marginTop: 12 }}>
            <IconTile icon={ScanLine} label="Локальные сенсоры" detail="сеть, процессы, устройства, posture" delay={64} active />
            <IconTile icon={ShieldCheck} label="Подтверждение действий" detail="рискованные операции проходят через gate" delay={76} />
            <IconTile icon={FileText} label="Аудит и карантин" detail="проверяемая история и безопасная изоляция" delay={88} />
          </div>
        </div>
      </div>
    </Stage>
  );
};

export const SafeScene: React.FC = () => {
  const frame = useCurrentFrame();
  const vault = enter(frame, 24, 38);
  const lock = interpolate(frame, [82, 122], [0, 1], { easing: ease, extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const files = ["Документы", "Ключи", "Личные данные"];

  return (
    <Stage accent="gold">
      <SceneIndex number="06" label="Monarch Safe" />
      <div style={{ display: "grid", gridTemplateColumns: "0.9fr 1.1fr", gap: 96, alignItems: "center", height: "100%" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 30 }}>
          <Kicker>Изолированное хранилище</Kicker>
          <Headline size={90} width={700}>Отдельный зашифрованный сейф.</Headline>
          <Copy width={650} size={34}>Monarch Safe хранит чувствительные файлы в desktop-only контуре с привязкой к устройству и PIN-защитой.</Copy>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            <Pill icon={Fingerprint} delay={58} active>Device-bound</Pill>
            <Pill icon={LockKeyhole} delay={68}>Зашифровано</Pill>
            <Pill icon={WifiOff} delay={78}>Изолировано</Pill>
          </div>
        </div>

        <div style={{ position: "relative", height: 730, display: "grid", placeItems: "center" }}>
          <Glass glow style={{ width: 590, height: 590, borderRadius: 70, display: "grid", placeItems: "center", opacity: vault, scale: interpolate(vault, [0, 1], [0.78, 1]), rotate: `${interpolate(vault, [0, 1], [-4, 0])}deg` }}>
            <div style={{ width: 414, height: 414, borderRadius: "50%", border: "3px solid rgba(255,194,71,.38)", display: "grid", placeItems: "center", boxShadow: "inset 0 0 90px rgba(255,138,0,.08)" }}>
              <div style={{ width: 292, height: 292, borderRadius: "50%", border: "1px solid rgba(255,255,255,.14)", display: "grid", placeItems: "center", rotate: `${interpolate(frame, [0, 180], [-16, 8], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })}deg` }}>
                <div style={{ width: 176, height: 176, borderRadius: 52, display: "grid", placeItems: "center", background: "rgba(255,138,0,.12)", border: "1px solid rgba(255,194,71,.40)", scale: 0.9 + lock * 0.1 }}>
                  <LockKeyhole size={92} strokeWidth={1.5} color={COLORS.gold} />
                </div>
              </div>
            </div>
            {[0, 90, 180, 270].map((angle) => (
              <span key={angle} style={{ position: "absolute", width: 18, height: 18, borderRadius: "50%", background: COLORS.gold, left: 286 + Math.cos((angle * Math.PI) / 180) * 238, top: 286 + Math.sin((angle * Math.PI) / 180) * 238, boxShadow: `0 0 18px ${COLORS.orange}` }} />
            ))}
          </Glass>
          {files.map((label, index) => {
            const p = enter(frame, 44 + index * 14, 28);
            return (
              <div
                key={label}
                style={{
                  position: "absolute",
                  left: -24 + index * 34,
                  top: 170 + index * 98,
                  width: 260,
                  height: 78,
                  borderRadius: 20,
                  display: "flex",
                  alignItems: "center",
                  gap: 15,
                  padding: "0 20px",
                  background: "rgba(20,20,18,.88)",
                  border: "1px solid rgba(255,255,255,.11)",
                  boxShadow: "0 18px 50px rgba(0,0,0,.34)",
                  fontSize: 21,
                  fontWeight: 650,
                  opacity: p,
                  translate: `${interpolate(p, [0, 1], [-80, 0])}px 0px`,
                }}
              >
                <FileText size={28} color={COLORS.gold} /> {label}
              </div>
            );
          })}
          <div style={{ position: "absolute", bottom: 24, display: "flex", alignItems: "center", gap: 12, fontSize: 22, color: COLORS.yellow, opacity: enter(frame, 116, 28) }}>
            <Check size={24} /> Сейф закрыт и защищён
          </div>
        </div>
      </div>
    </Stage>
  );
};

export const ExperienceScene: React.FC = () => {
  const frame = useCurrentFrame();
  const windowIn = enter(frame, 28, 38);
  const sideCards = [
    { icon: Languages, label: "RU · BG · UK · EN", detail: "встроенное определение языка" },
    { icon: Mic2, label: "Voice", detail: "локальный голосовой режим" },
    { icon: Send, label: "Telegram", detail: "задачи и напоминания" },
    { icon: MemoryStick, label: "Local models", detail: "Fast · Balanced · Deep" },
  ];

  return (
    <Stage>
      <SceneIndex number="07" label="Опыт" />
      <div style={{ display: "flex", flexDirection: "column", height: "100%", gap: 28 }}>
        <div style={{ display: "flex", alignItems: "end", justifyContent: "space-between" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
            <Kicker>Один интерфейс</Kicker>
            <Headline size={84} width={1100}>Много способов работать.</Headline>
          </div>
          <Copy width={580} size={30} align="left">Desktop, голос, Telegram и локальный API остаются частями одной системы.</Copy>
        </div>
        <div style={{ flex: 1, display: "grid", gridTemplateColumns: "1fr 390px", gap: 26 }}>
          <Glass glow style={{ overflow: "hidden", opacity: windowIn, scale: interpolate(windowIn, [0, 1], [0.92, 1]), translate: `0px ${interpolate(windowIn, [0, 1], [34, 0])}px` }}>
            <div style={{ height: 62, display: "flex", alignItems: "center", padding: "0 24px", borderBottom: "1px solid rgba(255,255,255,.08)", gap: 10 }}>
              {[COLORS.orange, COLORS.gold, "#3B3B38"].map((color) => <span key={color} style={{ width: 11, height: 11, borderRadius: "50%", background: color }} />)}
              <span style={{ marginLeft: 18, fontSize: 17, color: COLORS.muted }}>Monarch Desktop</span>
              <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8, fontSize: 17, color: COLORS.yellow }}><span style={{ width: 8, height: 8, borderRadius: "50%", background: COLORS.gold, boxShadow: `0 0 12px ${COLORS.orange}` }} /> Local runtime</span>
            </div>
            <div style={{ height: "calc(100% - 62px)", display: "grid", gridTemplateColumns: "190px 1fr" }}>
              <div style={{ padding: 22, borderRight: "1px solid rgba(255,255,255,.07)", background: "rgba(255,255,255,.016)" }}>
                <div style={{ display: "flex", justifyContent: "center", marginBottom: 32 }}><Logo size={62} glow={false} /></div>
                {["Диалог", "Память", "Проект", "Защита", "Модели"].map((item, index) => (
                  <div key={item} style={{ height: 45, borderRadius: 13, display: "flex", alignItems: "center", padding: "0 13px", marginBottom: 6, fontSize: 17, color: index === 0 ? COLORS.yellow : COLORS.muted, background: index === 0 ? "rgba(255,138,0,.10)" : "transparent" }}>{item}</div>
                ))}
              </div>
              <div style={{ padding: 34, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 25 }}>
                <div style={{ width: 124, height: 124, borderRadius: 40, display: "grid", placeItems: "center", background: "rgba(255,138,0,.11)", border: "1px solid rgba(255,194,71,.30)", scale: pulse(frame, 100, 0.97, 1.03) }}>
                  <Bot size={66} color={COLORS.gold} strokeWidth={1.5} />
                </div>
                <div style={{ fontSize: 39, fontWeight: 740 }}>Чем могу помочь?</div>
                <div style={{ fontSize: 22, color: COLORS.muted }}>Файлы, анализ, память, защита — в одном контексте</div>
                <div style={{ display: "flex", gap: 10 }}>
                  <Pill icon={Search} delay={70}>Найти</Pill>
                  <Pill icon={Workflow} delay={80} active>Спланировать</Pill>
                  <Pill icon={FileText} delay={90}>Создать</Pill>
                </div>
                <div style={{ width: "72%", height: 64, borderRadius: 19, border: "1px solid rgba(255,255,255,.10)", display: "flex", alignItems: "center", padding: "0 20px", color: COLORS.muted, marginTop: 16 }}>
                  Сообщение Oscar…
                  <Mic2 size={22} style={{ marginLeft: "auto" }} />
                  <div style={{ width: 40, height: 40, borderRadius: 13, display: "grid", placeItems: "center", background: "rgba(255,138,0,.14)", marginLeft: 10 }}><Send size={20} color={COLORS.gold} /></div>
                </div>
              </div>
            </div>
          </Glass>
          <div style={{ display: "grid", gap: 13 }}>
            {sideCards.map((card, index) => <IconTile key={card.label} icon={card.icon} label={card.label} detail={card.detail} delay={48 + index * 13} active={index === 0 || index === 2} />)}
          </div>
        </div>
      </div>
    </Stage>
  );
};

export const FinalScene: React.FC = () => {
  const frame = useCurrentFrame();
  const glow = pulse(frame, 100, 0.72, 1);
  return (
    <Stage accent="gold">
      <AbsoluteFill style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div style={{ position: "absolute", width: 760, height: 760, borderRadius: "50%", background: `radial-gradient(circle, rgba(255,138,0,${0.10 * glow}), transparent 68%)`, scale: glow }} />
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center", gap: 30, zIndex: 2 }}>
          <Logo size={190} delay={4} />
          <Kicker delay={20}>Monarch</Kicker>
          <Headline size={96} width={1240} align="center" delay={28}>Твоя локальная AI-экосистема.</Headline>
          <Copy width={1050} size={38} align="center" delay={48}>Приватная. Модульная. Умная. Под твоим контролем.</Copy>
          <div style={{ display: "flex", gap: 14, marginTop: 12 }}>
            <Pill icon={Cpu} delay={68} active>Local AI</Pill>
            <Pill icon={Workflow} delay={76}>Единое ядро</Pill>
            <Pill icon={ShieldCheck} delay={84}>Security by design</Pill>
          </div>
          <Glass glow style={{ marginTop: 28, padding: "20px 34px", borderRadius: 22, fontSize: 26, color: COLORS.yellow, fontWeight: 680, opacity: enter(frame, 104, 30) }}>
            Создан расти вместе с тобой
          </Glass>
        </div>
        <div style={{ position: "absolute", bottom: 52, fontSize: 17, letterSpacing: 4.2, textTransform: "uppercase", color: "rgba(255,255,255,.34)", opacity: enter(frame, 120, 24) }}>Local-first · Modular · Secure</div>
      </AbsoluteFill>
    </Stage>
  );
};
