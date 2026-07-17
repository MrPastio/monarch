import { Audio } from "@remotion/media";
import { TransitionSeries, linearTiming } from "@remotion/transitions";
import { fade } from "@remotion/transitions/fade";
import { slide } from "@remotion/transitions/slide";
import {
  AbsoluteFill,
  Composition,
  Easing,
  Img,
  Sequence,
  interpolate,
  staticFile,
  useCurrentFrame,
} from "remotion";
import {
  Bot,
  Boxes,
  BrainCircuit,
  Check,
  Cpu,
  LockKeyhole,
  ShieldCheck,
  Sparkles,
  WifiOff,
} from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { COLORS, FONT } from "./theme";

const FPS = 30;
const TRANSITION_FRAMES = 8;
const SCENE_DURATIONS = [72, 88, 140, 90, 96, 90] as const;

export const TIKTOK_DURATION =
  SCENE_DURATIONS.reduce((sum, duration) => sum + duration, 0) -
  TRANSITION_FRAMES * (SCENE_DURATIONS.length - 1);

const easeOut = Easing.bezier(0.16, 1, 0.3, 1);
const transitionTiming = linearTiming({ durationInFrames: TRANSITION_FRAMES });

const clamp = {
  extrapolateLeft: "clamp" as const,
  extrapolateRight: "clamp" as const,
};

const enter = (frame: number, from = 0, duration = 20) =>
  interpolate(frame, [from, from + duration], [0, 1], {
    ...clamp,
    easing: easeOut,
  });

const Background: React.FC<{ hot?: boolean }> = ({ hot = false }) => {
  const frame = useCurrentFrame();
  const drift = interpolate(frame, [0, 140], [-70, 70], clamp);

  return (
    <AbsoluteFill
      style={{
        overflow: "hidden",
        background: hot
          ? "radial-gradient(circle at 50% 36%, rgba(255,138,0,.22), transparent 42%), linear-gradient(155deg, #100903, #050505 56%, #020202)"
          : "radial-gradient(circle at 50% 34%, rgba(255,194,71,.11), transparent 38%), linear-gradient(155deg, #090807, #030303 62%, #000)",
      }}
    >
      <div
        style={{
          position: "absolute",
          inset: -160,
          opacity: 0.18,
          backgroundImage:
            "linear-gradient(rgba(255,255,255,.05) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.05) 1px, transparent 1px)",
          backgroundSize: "84px 84px",
          translate: `${drift * 0.18}px ${drift * 0.3}px`,
          rotate: "-8deg",
          maskImage: "radial-gradient(circle, black, transparent 72%)",
        }}
      />
      <div
        style={{
          position: "absolute",
          width: 860,
          height: 860,
          borderRadius: "50%",
          left: -500,
          top: -400,
          background: "radial-gradient(circle, rgba(255,138,0,.28), transparent 70%)",
          filter: "blur(24px)",
          translate: `${drift}px ${drift * 0.45}px`,
        }}
      />
      <div
        style={{
          position: "absolute",
          width: 980,
          height: 980,
          borderRadius: "50%",
          right: -590,
          bottom: -450,
          background: "radial-gradient(circle, rgba(255,194,71,.18), transparent 72%)",
          filter: "blur(28px)",
          translate: `${-drift}px ${-drift * 0.35}px`,
        }}
      />
      <div
        style={{
          position: "absolute",
          inset: 28,
          borderRadius: 46,
          border: "1px solid rgba(255,255,255,.05)",
        }}
      />
    </AbsoluteFill>
  );
};

const Stage: React.FC<{ children: ReactNode; hot?: boolean; style?: CSSProperties }> = ({
  children,
  hot,
  style,
}) => (
  <AbsoluteFill
    style={{
      overflow: "hidden",
      backgroundColor: COLORS.black,
      color: COLORS.white,
      fontFamily: FONT,
      ...style,
    }}
  >
    <Background hot={hot} />
    <AbsoluteFill style={{ padding: "118px 72px 126px" }}>{children}</AbsoluteFill>
  </AbsoluteFill>
);

const Glass: React.FC<{ children: ReactNode; style?: CSSProperties; glow?: boolean }> = ({
  children,
  style,
  glow = false,
}) => (
  <div
    style={{
      position: "relative",
      overflow: "hidden",
      borderRadius: 52,
      border: glow
        ? "1px solid rgba(255,194,71,.48)"
        : "1px solid rgba(255,255,255,.12)",
      background: glow
        ? "linear-gradient(145deg, rgba(51,35,12,.78), rgba(10,10,10,.78))"
        : "linear-gradient(145deg, rgba(30,30,28,.78), rgba(8,8,8,.78))",
      boxShadow: glow
        ? "0 44px 130px rgba(255,138,0,.20), inset 0 1px 0 rgba(255,255,255,.12)"
        : "0 40px 120px rgba(0,0,0,.50), inset 0 1px 0 rgba(255,255,255,.08)",
      backdropFilter: "blur(28px)",
      ...style,
    }}
  >
    {children}
  </div>
);

const Label: React.FC<{ children: ReactNode; delay?: number }> = ({ children, delay = 0 }) => {
  const frame = useCurrentFrame();
  const p = enter(frame, delay, 16);

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        alignSelf: "flex-start",
        gap: 14,
        padding: "13px 20px",
        borderRadius: 999,
        border: "1px solid rgba(255,194,71,.34)",
        background: "rgba(255,138,0,.10)",
        color: COLORS.yellow,
        fontSize: 27,
        fontWeight: 800,
        letterSpacing: 2.4,
        textTransform: "uppercase",
        opacity: p,
        translate: `${interpolate(p, [0, 1], [-36, 0])}px 0px`,
      }}
    >
      <span
        style={{
          width: 12,
          height: 12,
          borderRadius: "50%",
          background: COLORS.orange,
          boxShadow: `0 0 22px ${COLORS.orange}`,
        }}
      />
      {children}
    </div>
  );
};

const Word: React.FC<{
  children: ReactNode;
  delay: number;
  accent?: boolean;
  muted?: boolean;
  size?: number;
}> = ({ children, delay, accent = false, muted = false, size = 122 }) => {
  const frame = useCurrentFrame();
  const p = enter(frame, delay, 15);
  const kick = interpolate(frame, [delay, delay + 3, delay + 9], [0.92, 1.055, 1], clamp);

  return (
    <div
      style={{
        fontSize: size,
        lineHeight: 0.88,
        letterSpacing: -5.2,
        fontWeight: 900,
        color: accent ? COLORS.gold : muted ? "rgba(247,245,239,.54)" : COLORS.white,
        opacity: p,
        scale: kick,
        translate: `0px ${interpolate(p, [0, 1], [72, 0])}px`,
        textShadow: accent ? "0 0 50px rgba(255,138,0,.38)" : undefined,
      }}
    >
      {children}
    </div>
  );
};

const Screen: React.FC<{
  src: string;
  delay?: number;
  style?: CSSProperties;
  zoom?: number;
}> = ({ src, delay = 0, style, zoom = 1 }) => {
  const frame = useCurrentFrame();
  const p = enter(frame, delay, 18);
  const drift = interpolate(frame, [delay, delay + 90], [0, -34], clamp);

  return (
    <Glass
      glow
      style={{
        width: 760,
        height: 1644,
        borderRadius: 74,
        padding: 14,
        opacity: p,
        scale: interpolate(p, [0, 1], [0.82, 1]) * zoom,
        rotate: `${interpolate(p, [0, 1], [5, 0])}deg`,
        translate: `0px ${interpolate(p, [0, 1], [100, 0]) + drift}px`,
        ...style,
      }}
    >
      <Img
        src={staticFile(src)}
        style={{
          width: "100%",
          height: "100%",
          objectFit: "cover",
          borderRadius: 60,
        }}
      />
      <div
        style={{
          position: "absolute",
          inset: 14,
          borderRadius: 60,
          boxShadow: "inset 0 0 0 1px rgba(255,255,255,.08)",
          pointerEvents: "none",
        }}
      />
    </Glass>
  );
};

const Stat: React.FC<{ value: string; label: string; delay: number }> = ({ value, label, delay }) => {
  const frame = useCurrentFrame();
  const p = enter(frame, delay, 18);

  return (
    <Glass
      style={{
        padding: "24px 28px",
        borderRadius: 28,
        opacity: p,
        scale: interpolate(p, [0, 1], [0.72, 1]),
      }}
    >
      <div style={{ color: COLORS.gold, fontSize: 60, lineHeight: 0.92, fontWeight: 900 }}>{value}</div>
      <div style={{ marginTop: 9, color: COLORS.muted, fontSize: 25, fontWeight: 650 }}>{label}</div>
    </Glass>
  );
};

const HookScene: React.FC = () => {
  const frame = useCurrentFrame();
  const shake = frame >= 46 && frame <= 55 ? Math.sin(frame * 4.8) * 9 : 0;
  const cloudStrike = interpolate(frame, [46, 58], [0, 1], clamp);

  return (
    <Stage hot>
      <AbsoluteFill
        style={{
          padding: "150px 72px 150px",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          translate: `${shake}px 0px`,
        }}
      >
        <Label>не очередной чат-бот</Label>
        <div style={{ display: "flex", flexDirection: "column", gap: 24, marginTop: 62 }}>
          <Word delay={7}>ТВОЙ AI</Word>
          <Word delay={15} muted>НЕ ДОЛЖЕН</Word>
          <Word delay={23}>ЖИТЬ В</Word>
          <div style={{ position: "relative", alignSelf: "flex-start" }}>
            <Word delay={31} accent size={142}>ОБЛАКЕ.</Word>
            <div
              style={{
                position: "absolute",
                left: -20,
                right: -20,
                top: "52%",
                height: 18,
                borderRadius: 99,
                background: COLORS.orange,
                boxShadow: `0 0 34px ${COLORS.orange}`,
                scale: `${cloudStrike} 1`,
                transformOrigin: "left center",
              }}
            />
          </div>
        </div>
        <div
          style={{
            marginTop: 60,
            color: COLORS.muted,
            fontSize: 38,
            lineHeight: 1.24,
            fontWeight: 560,
            opacity: enter(frame, 46, 18),
          }}
        >
          Файлы. Память. Модели. Защита.
          <br />
          Всё должно оставаться у тебя.
        </div>
      </AbsoluteFill>
    </Stage>
  );
};

const RevealScene: React.FC = () => {
  const frame = useCurrentFrame();
  const ring = interpolate(frame, [0, 88], [0.76, 1.22], {
    ...clamp,
    easing: Easing.inOut(Easing.sin),
  });
  const logo = enter(frame, 4, 20);

  return (
    <Stage>
      <AbsoluteFill
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          textAlign: "center",
          padding: "120px 72px 150px",
        }}
      >
        {[680, 500, 340].map((size, index) => (
          <div
            key={size}
            style={{
              position: "absolute",
              width: size,
              height: size,
              borderRadius: "50%",
              border: `1px solid rgba(255,194,71,${0.10 + index * 0.08})`,
              scale: ring * (1 - index * 0.04),
              opacity: logo,
            }}
          />
        ))}
        <div
          style={{
            width: 310,
            height: 310,
            borderRadius: 74,
            overflow: "hidden",
            background: "#020202",
            border: "1px solid rgba(255,194,71,.42)",
            boxShadow: "0 0 110px rgba(255,138,0,.28)",
            opacity: logo,
            scale: interpolate(logo, [0, 1], [0.54, 1]),
            rotate: `${interpolate(logo, [0, 1], [-12, 0])}deg`,
            zIndex: 2,
          }}
        >
          <Img src={staticFile("monarch-icon.png")} style={{ width: "100%", height: "100%" }} />
        </div>
        <div style={{ marginTop: 70, zIndex: 2 }}>
          <Word delay={18} size={126}>MONARCH</Word>
          <div
            style={{
              marginTop: 24,
              color: COLORS.gold,
              fontSize: 44,
              fontWeight: 760,
              letterSpacing: -1.4,
              opacity: enter(frame, 34, 18),
            }}
          >
            LOCAL AI. REAL CONTROL.
          </div>
        </div>
      </AbsoluteFill>
    </Stage>
  );
};

const ProductMontageScene: React.FC = () => {
  const frame = useCurrentFrame();
  const first = interpolate(frame, [0, 48, 61, 69], [0, 1, 1, 0], clamp);
  const second = interpolate(frame, [55, 69, 112, 124], [0, 1, 1, 0], clamp);
  const third = interpolate(frame, [110, 124, 140], [0, 1, 1], clamp);

  return (
    <Stage>
      <AbsoluteFill style={{ padding: "105px 72px 108px" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 18, zIndex: 5 }}>
          <Label>живой интерфейс Monarch</Label>
          <div style={{ fontSize: 82, lineHeight: 0.94, letterSpacing: -4, fontWeight: 900 }}>
            НЕ МАКЕТ.
            <br />
            <span style={{ color: COLORS.gold }}>РАБОЧАЯ СИСТЕМА.</span>
          </div>
        </div>

        <div style={{ position: "absolute", left: 160, top: 340, opacity: first }}>
          <Screen src="live-project-mobile.png" zoom={0.94} />
        </div>
        <div style={{ position: "absolute", left: 160, top: 340, opacity: second }}>
          <Screen src="live-models-mobile.png" zoom={0.94} />
        </div>
        <div style={{ position: "absolute", left: 160, top: 340, opacity: third }}>
          <Screen src="live-security-mobile.png" zoom={0.94} />
        </div>

        <div
          style={{
            position: "absolute",
            left: 72,
            right: 72,
            bottom: 114,
            display: "grid",
            gridTemplateColumns: "repeat(3, 1fr)",
            gap: 14,
            zIndex: 8,
          }}
        >
          <Stat value="17" label="модулей" delay={18} />
          <Stat value="134" label="возможности" delay={28} />
          <Stat value="4" label="модели" delay={38} />
        </div>
      </AbsoluteFill>
    </Stage>
  );
};

const OscarScene: React.FC = () => {
  const frame = useCurrentFrame();
  const text = enter(frame, 5, 20);
  const screen = enter(frame, 18, 22);
  const iconPulse = interpolate(frame % 42, [0, 21, 42], [0.96, 1.06, 0.96], {
    easing: Easing.inOut(Easing.sin),
  });

  return (
    <Stage hot>
      <AbsoluteFill style={{ padding: "104px 72px 116px" }}>
        <div style={{ opacity: text, zIndex: 4 }}>
          <Label>Oscar</Label>
          <div
            style={{
              marginTop: 28,
              fontSize: 92,
              lineHeight: 0.92,
              letterSpacing: -4.8,
              fontWeight: 900,
            }}
          >
            ОН ВИДИТ
            <br />
            <span style={{ color: COLORS.gold }}>ПРОЕКТ ЦЕЛИКОМ.</span>
          </div>
        </div>

        <div
          style={{
            position: "absolute",
            left: 142,
            top: 410,
            opacity: screen,
            scale: interpolate(screen, [0, 1], [0.82, 1]),
          }}
        >
          <Screen src="live-chat-mobile.png" zoom={0.96} />
        </div>

        <Glass
          glow
          style={{
            position: "absolute",
            left: 65,
            right: 65,
            bottom: 116,
            padding: "25px 28px",
            borderRadius: 30,
            display: "flex",
            alignItems: "center",
            gap: 18,
            opacity: enter(frame, 38, 18),
            zIndex: 8,
          }}
        >
          <div
            style={{
              width: 72,
              height: 72,
              borderRadius: 22,
              display: "grid",
              placeItems: "center",
              background: "rgba(255,138,0,.14)",
              scale: iconPulse,
            }}
          >
            <Bot size={40} color={COLORS.gold} />
          </div>
          <div>
            <div style={{ fontSize: 33, fontWeight: 820 }}>Контекст не теряется</div>
            <div style={{ marginTop: 5, color: COLORS.muted, fontSize: 25 }}>Память · файлы · задачи · runtime</div>
          </div>
        </Glass>
      </AbsoluteFill>
    </Stage>
  );
};

const SecurityScene: React.FC = () => {
  const frame = useCurrentFrame();
  const cards = [
    { icon: WifiOff, title: "LOCAL-FIRST", copy: "данные остаются рядом" },
    { icon: ShieldCheck, title: "PERMISSION GATE", copy: "риск под твоим контролем" },
    { icon: LockKeyhole, title: "MONARCH SAFE", copy: "отдельный зашифрованный контур" },
  ];

  return (
    <Stage>
      <AbsoluteFill style={{ padding: "118px 72px 122px", display: "flex", flexDirection: "column" }}>
        <Label>security by design</Label>
        <div
          style={{
            marginTop: 34,
            fontSize: 104,
            lineHeight: 0.88,
            letterSpacing: -5.4,
            fontWeight: 900,
          }}
        >
          НЕ ДОВЕРЯЙ.
          <br />
          <span style={{ color: COLORS.gold }}>ПРОВЕРЯЙ.</span>
        </div>

        <div style={{ display: "grid", gap: 18, marginTop: 68 }}>
          {cards.map((card, index) => {
            const p = enter(frame, 17 + index * 13, 18);
            const Icon = card.icon;
            return (
              <Glass
                key={card.title}
                glow={index === 1}
                style={{
                  padding: "30px 32px",
                  borderRadius: 34,
                  display: "grid",
                  gridTemplateColumns: "88px 1fr",
                  alignItems: "center",
                  gap: 24,
                  opacity: p,
                  translate: `${interpolate(p, [0, 1], [90, 0])}px 0px`,
                }}
              >
                <div
                  style={{
                    width: 88,
                    height: 88,
                    borderRadius: 28,
                    display: "grid",
                    placeItems: "center",
                    background: index === 1 ? "rgba(255,138,0,.16)" : "rgba(255,255,255,.055)",
                  }}
                >
                  <Icon size={46} color={index === 1 ? COLORS.gold : COLORS.white} strokeWidth={1.8} />
                </div>
                <div>
                  <div style={{ color: index === 1 ? COLORS.gold : COLORS.white, fontSize: 39, fontWeight: 880 }}>
                    {card.title}
                  </div>
                  <div style={{ marginTop: 7, color: COLORS.muted, fontSize: 27, fontWeight: 560 }}>
                    {card.copy}
                  </div>
                </div>
              </Glass>
            );
          })}
        </div>

        <div
          style={{
            marginTop: "auto",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 14,
            color: COLORS.yellow,
            fontSize: 31,
            fontWeight: 760,
            opacity: enter(frame, 60, 18),
          }}
        >
          <Check size={32} /> Интернет для проверки выключен по умолчанию
        </div>
      </AbsoluteFill>
    </Stage>
  );
};

const FinalScene: React.FC = () => {
  const frame = useCurrentFrame();
  const logo = enter(frame, 2, 18);
  const pulse = interpolate(frame % 56, [0, 28, 56], [0.94, 1.06, 0.94], {
    easing: Easing.inOut(Easing.sin),
  });
  const featureIcons = [Cpu, Boxes, BrainCircuit, ShieldCheck];

  return (
    <Stage hot>
      <AbsoluteFill
        style={{
          padding: "126px 72px 128px",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          textAlign: "center",
        }}
      >
        <div
          style={{
            width: 260,
            height: 260,
            borderRadius: 66,
            overflow: "hidden",
            border: "1px solid rgba(255,194,71,.46)",
            boxShadow: "0 0 120px rgba(255,138,0,.32)",
            opacity: logo,
            scale: interpolate(logo, [0, 1], [0.54, 1]) * pulse,
          }}
        >
          <Img src={staticFile("monarch-icon.png")} style={{ width: "100%", height: "100%" }} />
        </div>

        <div style={{ marginTop: 68 }}>
          <Word delay={12} size={132}>MONARCH</Word>
        </div>
        <div
          style={{
            marginTop: 30,
            fontSize: 59,
            lineHeight: 1.03,
            letterSpacing: -2.8,
            fontWeight: 820,
            opacity: enter(frame, 25, 18),
          }}
        >
          ЛОКАЛЬНЫЙ.
          <br />
          МОДУЛЬНЫЙ.
          <br />
          <span style={{ color: COLORS.gold }}>ТВОЙ.</span>
        </div>

        <div style={{ display: "flex", gap: 18, marginTop: 62 }}>
          {featureIcons.map((Icon, index) => {
            const p = enter(frame, 36 + index * 7, 14);
            return (
              <Glass
                key={index}
                glow={index === 3}
                style={{
                  width: 112,
                  height: 112,
                  borderRadius: 34,
                  display: "grid",
                  placeItems: "center",
                  opacity: p,
                  scale: interpolate(p, [0, 1], [0.62, 1]),
                }}
              >
                <Icon size={54} color={index === 3 ? COLORS.gold : COLORS.white} strokeWidth={1.7} />
              </Glass>
            );
          })}
        </div>

        <div
          style={{
            position: "absolute",
            bottom: 96,
            display: "flex",
            alignItems: "center",
            gap: 12,
            color: COLORS.yellow,
            fontSize: 28,
            fontWeight: 760,
            letterSpacing: 2.2,
            textTransform: "uppercase",
            opacity: enter(frame, 58, 16),
          }}
        >
          <Sparkles size={30} /> Local intelligence · real control
        </div>
      </AbsoluteFill>
    </Stage>
  );
};

const BeatFlash: React.FC = () => {
  const frame = useCurrentFrame();
  const beats = [0, 64, 144, 276, 358, 446];
  const flash = Math.max(
    ...beats.map((beat) => interpolate(frame, [beat, beat + 2, beat + 6], [0, 0.34, 0], clamp)),
  );

  return (
    <AbsoluteFill
      style={{
        background: "linear-gradient(145deg, rgba(255,255,255,.78), rgba(255,138,0,.35))",
        opacity: flash,
        pointerEvents: "none",
      }}
    />
  );
};

const MonarchTikTokVideo: React.FC = () => (
  <AbsoluteFill style={{ backgroundColor: COLORS.black }}>
    <Audio
      src={staticFile("monarch-ambient.mp3")}
      volume={(frame) =>
        interpolate(frame, [0, 18, TIKTOK_DURATION - 40, TIKTOK_DURATION], [0, 0.52, 0.52, 0], clamp)
      }
    />
    <Sequence durationInFrames={46}>
      <Audio src={staticFile("vine-boom.wav")} volume={0.58} />
    </Sequence>
    {[64, 144, 276, 358, 446].map((from) => (
      <Sequence key={from} from={from} durationInFrames={24}>
        <Audio src={staticFile("whoosh.wav")} volume={0.72} />
      </Sequence>
    ))}
    {[186, 230, 338].map((from) => (
      <Sequence key={from} from={from} durationInFrames={18}>
        <Audio src={staticFile("mouse-click.wav")} volume={0.44} />
      </Sequence>
    ))}
    <Sequence from={446} durationInFrames={46}>
      <Audio src={staticFile("vine-boom.wav")} volume={0.42} />
    </Sequence>

    <TransitionSeries>
      <TransitionSeries.Sequence durationInFrames={SCENE_DURATIONS[0]}>
        <HookScene />
      </TransitionSeries.Sequence>
      <TransitionSeries.Transition
        presentation={slide({ direction: "from-bottom" })}
        timing={transitionTiming}
      />

      <TransitionSeries.Sequence durationInFrames={SCENE_DURATIONS[1]}>
        <RevealScene />
      </TransitionSeries.Sequence>
      <TransitionSeries.Transition presentation={fade()} timing={transitionTiming} />

      <TransitionSeries.Sequence durationInFrames={SCENE_DURATIONS[2]}>
        <ProductMontageScene />
      </TransitionSeries.Sequence>
      <TransitionSeries.Transition
        presentation={slide({ direction: "from-right" })}
        timing={transitionTiming}
      />

      <TransitionSeries.Sequence durationInFrames={SCENE_DURATIONS[3]}>
        <OscarScene />
      </TransitionSeries.Sequence>
      <TransitionSeries.Transition
        presentation={slide({ direction: "from-left" })}
        timing={transitionTiming}
      />

      <TransitionSeries.Sequence durationInFrames={SCENE_DURATIONS[4]}>
        <SecurityScene />
      </TransitionSeries.Sequence>
      <TransitionSeries.Transition presentation={fade()} timing={transitionTiming} />

      <TransitionSeries.Sequence durationInFrames={SCENE_DURATIONS[5]}>
        <FinalScene />
      </TransitionSeries.Sequence>
    </TransitionSeries>

    <BeatFlash />
  </AbsoluteFill>
);

export const MonarchTikTokComposition: React.FC = () => (
  <Composition
    id="MonarchTikTok"
    component={MonarchTikTokVideo}
    durationInFrames={TIKTOK_DURATION}
    fps={FPS}
    width={1080}
    height={1920}
    defaultProps={{}}
  />
);
