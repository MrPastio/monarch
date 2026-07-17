import { Audio } from "@remotion/media";
import {
  AbsoluteFill,
  Composition,
  Easing,
  Img,
  Sequence,
  interpolate,
  random,
  staticFile,
  useCurrentFrame,
} from "remotion";
import {
  Bot,
  BrainCircuit,
  Database,
  FolderCode,
  LockKeyhole,
  Mic2,
  Network,
  ShieldCheck,
  Terminal,
} from "lucide-react";
import type { CSSProperties, ReactNode } from "react";

const FPS = 30;
const BEAT = 12;
export const PHONK_DURATION = 456;

const BLACK = "#050505";
const WHITE = "#fffdf7";
const ORANGE = "#ff7a00";
const YELLOW = "#ffd84a";
const DISPLAY_FONT = 'Impact, Haettenschweiler, "Arial Narrow Bold", sans-serif';
const UI_FONT = '"Arial Black", "Segoe UI", sans-serif';
const clamp = { extrapolateLeft: "clamp" as const, extrapolateRight: "clamp" as const };
const ease = Easing.bezier(0.16, 1, 0.3, 1);

const MODULES = [
  { name: "OSCAR", code: "01", icon: Bot },
  { name: "SECURITY", code: "02", icon: ShieldCheck },
  { name: "VOICE", code: "03", icon: Mic2 },
  { name: "MODELS", code: "04", icon: BrainCircuit },
  { name: "WORKSPACE", code: "05", icon: FolderCode },
  { name: "MEMORY", code: "06", icon: Database },
  { name: "SAFE", code: "07", icon: LockKeyhole },
  { name: "ASTRA", code: "08", icon: Network },
] as const;

const enter = (frame: number, start = 0, duration = 8) =>
  interpolate(frame, [start, start + duration], [0, 1], { ...clamp, easing: ease });

const beatPunch = (frame: number) => {
  const phase = ((frame % BEAT) + BEAT) % BEAT;
  return interpolate(phase, [0, 2, 8, BEAT], [1, 0.08, 0, 0], clamp);
};

const Stage: React.FC<{
  children: ReactNode;
  inverse?: boolean;
  accent?: boolean;
  style?: CSSProperties;
}> = ({ children, inverse = false, accent = false, style }) => (
  <AbsoluteFill
    style={{
      overflow: "hidden",
      backgroundColor: accent ? ORANGE : inverse ? WHITE : BLACK,
      color: inverse || accent ? BLACK : WHITE,
      fontFamily: UI_FONT,
      ...style,
    }}
  >
    {children}
  </AbsoluteFill>
);

const CornerMarks: React.FC<{ inverse?: boolean }> = ({ inverse = false }) => {
  const color = inverse ? BLACK : WHITE;
  return (
    <>
      {["top-left", "top-right", "bottom-left", "bottom-right"].map((corner) => {
        const [vertical, horizontal] = corner.split("-");
        return (
          <div
            key={corner}
            style={{
              position: "absolute",
              [vertical]: 38,
              [horizontal]: 38,
              width: 52,
              height: 52,
              borderTop: vertical === "top" ? `5px solid ${color}` : undefined,
              borderBottom: vertical === "bottom" ? `5px solid ${color}` : undefined,
              borderLeft: horizontal === "left" ? `5px solid ${color}` : undefined,
              borderRight: horizontal === "right" ? `5px solid ${color}` : undefined,
              opacity: 0.65,
            }}
          />
        );
      })}
    </>
  );
};

const InkTexture: React.FC<{ inverse?: boolean; strength?: number }> = ({
  inverse = false,
  strength = 0.2,
}) => {
  const frame = useCurrentFrame();
  const offset = (frame * 17) % 68;
  return (
    <AbsoluteFill style={{ pointerEvents: "none", opacity: strength, mixBlendMode: inverse ? "multiply" : "screen" }}>
      <div
        style={{
          position: "absolute",
          inset: -80,
          backgroundImage: `radial-gradient(circle, ${inverse ? BLACK : WHITE} 1.5px, transparent 1.7px)`,
          backgroundSize: "12px 12px",
          translate: `${offset}px ${-offset * 0.46}px`,
          rotate: "-7deg",
          maskImage: "linear-gradient(115deg, transparent 8%, black 32%, black 68%, transparent 92%)",
        }}
      />
      {Array.from({ length: 14 }, (_, index) => (
        <div
          key={index}
          style={{
            position: "absolute",
            left: -100 + random(`scratch-x-${index}`) * 1050,
            top: random(`scratch-y-${index}`) * 1920,
            width: 260 + random(`scratch-w-${index}`) * 760,
            height: 2 + random(`scratch-h-${index}`) * 7,
            background: inverse ? BLACK : WHITE,
            rotate: `${-16 + random(`scratch-r-${index}`) * 32}deg`,
            opacity: 0.22 + random(`scratch-o-${index}`) * 0.36,
          }}
        />
      ))}
    </AbsoluteFill>
  );
};

const ThresholdMascot: React.FC<{
  src: string;
  invert?: boolean;
  style?: CSSProperties;
  colorFlash?: boolean;
}> = ({ src, invert = false, style, colorFlash = false }) => {
  const frame = useCurrentFrame();
  const flash = colorFlash && frame % 24 <= 2;
  return (
    <Img
      src={staticFile(src)}
      style={{
        objectFit: "contain",
        filter: flash
          ? "saturate(1.15) contrast(125%)"
          : invert
            ? "grayscale(1) contrast(900%) brightness(118%) invert(1)"
            : "grayscale(1) contrast(900%) brightness(92%)",
        ...style,
      }}
    />
  );
};

const SlashTitle: React.FC<{
  children: ReactNode;
  frame: number;
  delay?: number;
  inverse?: boolean;
  size?: number;
  accent?: boolean;
  style?: CSSProperties;
}> = ({ children, frame, delay = 0, inverse = false, size = 160, accent = false, style }) => {
  const p = enter(frame, delay, 7);
  return (
    <div
      style={{
        fontFamily: DISPLAY_FONT,
        fontSize: size,
        lineHeight: 0.78,
        letterSpacing: -3,
        textTransform: "uppercase",
        color: accent ? ORANGE : inverse ? BLACK : WHITE,
        WebkitTextStroke: accent ? `2px ${BLACK}` : undefined,
        textShadow: `${interpolate(p, [0, 1], [22, 5])}px 7px 0 ${accent ? YELLOW : inverse ? "#cfcfcf" : "#393939"}`,
        opacity: p,
        translate: `${interpolate(p, [0, 1], [-210, 0])}px 0px`,
        ...style,
      }}
    >
      {children}
    </div>
  );
};

const StencilHook: React.FC = () => {
  const frame = useCurrentFrame();
  const punch = beatPunch(frame);
  const zoom = interpolate(frame, [0, 47], [1.2, 1.72], { ...clamp, easing: Easing.in(Easing.quad) });
  const jitter = frame > 29 ? Math.sin(frame * 8.2) * 15 : 0;
  return (
    <Stage inverse>
      <CornerMarks inverse />
      <ThresholdMascot
        src="mascot-idle.png"
        style={{
          position: "absolute",
          width: 980,
          height: 1280,
          left: 340,
          top: 90,
          scale: zoom + punch * 0.07,
          translate: `${jitter}px ${-110 - frame * 2.5}px`,
        }}
      />
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 190,
          height: 470,
          background: BLACK,
          clipPath: "polygon(0 13%, 100% 0, 100% 100%, 0 100%)",
        }}
      />
      <div style={{ position: "absolute", left: 64, right: 64, bottom: 244 }}>
        <SlashTitle frame={frame} delay={2} size={190}>НЕ ЧАТ-БОТ.</SlashTitle>
        <div
          style={{
            marginTop: 44,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            color: YELLOW,
            fontSize: 30,
            fontWeight: 900,
            letterSpacing: 4,
            opacity: enter(frame, 14, 6),
          }}
        >
          <span>LOCAL AI SYSTEM</span>
          <span>FRAME // 001</span>
        </div>
      </div>
      <div
        style={{
          position: "absolute",
          left: 52,
          top: 100,
          padding: "10px 18px",
          background: ORANGE,
          color: BLACK,
          fontSize: 26,
          fontWeight: 900,
          letterSpacing: 3,
          rotate: "-4deg",
        }}
      >
        OFFLINE BY DESIGN
      </div>
      <InkTexture inverse strength={0.24} />
    </Stage>
  );
};

const LogoShock: React.FC = () => {
  const frame = useCurrentFrame();
  const punch = beatPunch(frame);
  const whiteFrame = frame < 3 || (frame >= 24 && frame < 27);
  return (
    <Stage inverse={whiteFrame} accent={frame >= 43}>
      <CornerMarks inverse={whiteFrame || frame >= 43} />
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "grid",
          placeItems: "center",
          scale: 0.84 + enter(frame, 0, 7) * 0.16 + punch * 0.09,
          rotate: `${Math.sin(frame * 2.4) * (frame < 10 ? 3 : 0.5)}deg`,
        }}
      >
        <div
          style={{
            width: 750,
            height: 1060,
            background: whiteFrame ? BLACK : WHITE,
            clipPath: "polygon(5% 0, 100% 7%, 93% 96%, 0 100%)",
            boxShadow: `28px 28px 0 ${ORANGE}`,
            display: "grid",
            placeItems: "center",
          }}
        >
          <Img
            src={staticFile("monarch-mark.png")}
            style={{
              width: 660,
              height: 820,
              objectFit: "contain",
              filter: whiteFrame ? "grayscale(1) contrast(900%) invert(1)" : "grayscale(1) contrast(900%)",
            }}
          />
        </div>
      </div>
      <div
        style={{
          position: "absolute",
          left: -26,
          right: -26,
          bottom: 135,
          padding: "18px 0",
          background: frame >= 43 ? BLACK : ORANGE,
          color: frame >= 43 ? WHITE : BLACK,
          fontFamily: DISPLAY_FONT,
          fontSize: 74,
          letterSpacing: 5,
          textAlign: "center",
          rotate: "-3deg",
        }}
      >
        MONARCH // MONARCH // MONARCH
      </div>
      <InkTexture inverse={whiteFrame || frame >= 43} strength={0.17} />
    </Stage>
  );
};

const ModuleGrid: React.FC = () => {
  const frame = useCurrentFrame();
  const inverse = Math.floor(frame / BEAT) % 2 === 1;
  return (
    <Stage inverse={inverse}>
      <CornerMarks inverse={inverse} />
      <div style={{ position: "absolute", left: 58, right: 58, top: 100 }}>
        <div style={{ color: ORANGE, fontSize: 28, fontWeight: 900, letterSpacing: 6 }}>
          MODULAR CORE // 08 SIGNALS
        </div>
        <SlashTitle frame={frame} delay={0} inverse={inverse} size={158} style={{ marginTop: 34 }}>
          ONE SYSTEM.
        </SlashTitle>
        <SlashTitle frame={frame} delay={8} inverse={inverse} size={158} accent>
          MANY POWERS.
        </SlashTitle>
      </div>
      <div
        style={{
          position: "absolute",
          left: 56,
          right: 56,
          top: 610,
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 18,
        }}
      >
        {MODULES.map((module, index) => {
          const visible = enter(frame, 18 + index * 5, 5);
          const Icon = module.icon;
          const hot = index === Math.floor(frame / BEAT) % MODULES.length;
          return (
            <div
              key={module.name}
              style={{
                minHeight: 216,
                padding: "26px 28px",
                border: `5px solid ${hot ? ORANGE : inverse ? BLACK : WHITE}`,
                background: hot ? ORANGE : inverse ? WHITE : BLACK,
                color: hot ? BLACK : inverse ? BLACK : WHITE,
                display: "flex",
                flexDirection: "column",
                justifyContent: "space-between",
                opacity: visible,
                translate: `${interpolate(visible, [0, 1], [index % 2 ? 130 : -130, 0])}px 0px`,
                scale: hot ? 1.035 : 1,
                rotate: `${index % 2 ? 1.2 : -1.2}deg`,
                boxShadow: hot ? `12px 12px 0 ${inverse ? BLACK : WHITE}` : undefined,
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                <Icon size={57} strokeWidth={2.8} />
                <span style={{ fontSize: 25, fontWeight: 900 }}>{module.code}</span>
              </div>
              <div style={{ fontFamily: DISPLAY_FONT, fontSize: 58, letterSpacing: 1 }}>{module.name}</div>
            </div>
          );
        })}
      </div>
      <InkTexture inverse={inverse} strength={0.13} />
    </Stage>
  );
};

const MascotPoster: React.FC = () => {
  const frame = useCurrentFrame();
  const secondPose = frame >= 48;
  const punch = beatPunch(frame);
  return (
    <Stage inverse>
      <CornerMarks inverse />
      <div
        style={{
          position: "absolute",
          left: -130,
          top: 270,
          width: 1080,
          height: 1080,
          border: `36px solid ${BLACK}`,
          borderRadius: "50%",
          scale: 0.92 + punch * 0.035,
        }}
      />
      <ThresholdMascot
        src={secondPose ? "mascot-success.png" : "mascot-thinking.png"}
        colorFlash
        style={{
          position: "absolute",
          width: 1040,
          height: 1280,
          left: 80,
          top: 255,
          scale: 1 + punch * 0.08,
          translate: `${Math.sin(frame * 4.1) * (punch * 8)}px 0px`,
        }}
      />
      <div style={{ position: "absolute", left: 58, right: 58, top: 90 }}>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 27, fontWeight: 900, letterSpacing: 4 }}>
          <span>OSCAR // LOCAL AGENT</span>
          <span>SUBJECT 09</span>
        </div>
      </div>
      <div
        style={{
          position: "absolute",
          left: -30,
          right: -30,
          bottom: 220,
          padding: "26px 72px 34px",
          background: BLACK,
          rotate: "-4deg",
        }}
      >
        <SlashTitle frame={frame} delay={2} size={170}>THINK. ACT.</SlashTitle>
        <SlashTitle frame={frame} delay={10} size={170} accent>STAY LOCAL.</SlashTitle>
      </div>
      <div
        style={{
          position: "absolute",
          right: 48,
          top: 210,
          padding: "15px 22px",
          background: ORANGE,
          fontFamily: DISPLAY_FONT,
          fontSize: 45,
          rotate: "8deg",
          boxShadow: `9px 9px 0 ${BLACK}`,
        }}
      >
        MASCOT MODE
      </div>
      <InkTexture inverse strength={0.25} />
    </Stage>
  );
};

const ModuleRush: React.FC = () => {
  const frame = useCurrentFrame();
  const active = Math.min(MODULES.length - 1, Math.floor(frame / BEAT));
  const ActiveIcon = MODULES[active].icon;
  return (
    <Stage>
      <CornerMarks />
      <div
        style={{
          position: "absolute",
          left: 70,
          top: 90,
          color: YELLOW,
          fontSize: 27,
          fontWeight: 900,
          letterSpacing: 5,
        }}
      >
        LIVE MODULE FEED // {String(active + 1).padStart(2, "0")}
      </div>
      <div
        style={{
          position: "absolute",
          left: 70,
          right: 70,
          top: 300,
          height: 760,
          display: "grid",
          placeItems: "center",
          border: `8px solid ${WHITE}`,
          background: active % 3 === 1 ? WHITE : ORANGE,
          color: BLACK,
          boxShadow: `26px 26px 0 ${active % 3 === 1 ? ORANGE : WHITE}`,
          rotate: `${Math.sin(frame / 13) * 2.2}deg`,
          scale: 0.96 + beatPunch(frame) * 0.08,
        }}
      >
        <ActiveIcon size={330} strokeWidth={1.6} />
        <div
          style={{
            position: "absolute",
            bottom: 46,
            left: 46,
            fontFamily: DISPLAY_FONT,
            fontSize: 128,
            letterSpacing: 2,
          }}
        >
          {MODULES[active].name}
        </div>
      </div>
      <div style={{ position: "absolute", left: 0, right: 0, bottom: 210 }}>
        {MODULES.slice(0, 5).map((module, index) => {
          const direction = index % 2 ? 1 : -1;
          const drift = ((frame * (12 + index * 2) * direction) % 760) - 380;
          return (
            <div
              key={module.name}
              style={{
                height: 104,
                display: "flex",
                alignItems: "center",
                gap: 30,
                padding: "0 58px",
                background: index === active % 5 ? ORANGE : index % 2 ? WHITE : BLACK,
                color: index === active % 5 || index % 2 ? BLACK : WHITE,
                borderTop: `3px solid ${WHITE}`,
                borderBottom: `3px solid ${WHITE}`,
                fontFamily: DISPLAY_FONT,
                fontSize: 67,
                letterSpacing: 3,
                translate: `${drift}px 0px`,
              }}
            >
              {Array.from({ length: 4 }, (_, repeat) => (
                <span key={repeat}>{module.name} //</span>
              ))}
            </div>
          );
        })}
      </div>
      <InkTexture strength={0.16} />
    </Stage>
  );
};

const FinalPoster: React.FC = () => {
  const frame = useCurrentFrame();
  const punch = beatPunch(frame);
  const settle = enter(frame, 8, 12);
  return (
    <Stage>
      <CornerMarks />
      <div
        style={{
          position: "absolute",
          left: 50,
          right: 50,
          top: 58,
          height: 1800,
          border: `7px solid ${WHITE}`,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            position: "absolute",
            width: 880,
            height: 880,
            borderRadius: "50%",
            background: ORANGE,
            top: 155,
            left: 100,
            scale: 0.86 + settle * 0.14 + punch * 0.045,
          }}
        />
        <ThresholdMascot
          src="mascot-coding.png"
          invert
          colorFlash
          style={{
            position: "absolute",
            width: 930,
            height: 1080,
            left: 74,
            top: 110,
            scale: 0.9 + settle * 0.1 + punch * 0.05,
          }}
        />
        <Img
          src={staticFile("monarch-icon.png")}
          style={{
            position: "absolute",
            width: 156,
            height: 156,
            left: 54,
            top: 52,
            filter: "grayscale(1) contrast(900%)",
            boxShadow: `10px 10px 0 ${WHITE}`,
          }}
        />
        <div style={{ position: "absolute", left: 46, right: 46, bottom: 400 }}>
          <SlashTitle frame={frame} delay={5} size={170}>LOCAL.</SlashTitle>
          <SlashTitle frame={frame} delay={11} size={170}>MODULAR.</SlashTitle>
          <SlashTitle frame={frame} delay={17} size={185} accent>YOURS.</SlashTitle>
        </div>
        <div
          style={{
            position: "absolute",
            left: 48,
            right: 48,
            bottom: 74,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <div>
            <div style={{ fontFamily: DISPLAY_FONT, fontSize: 78, letterSpacing: 6 }}>MONARCH</div>
            <div style={{ color: YELLOW, fontSize: 25, fontWeight: 900, letterSpacing: 4 }}>
              LOCAL INTELLIGENCE // REAL CONTROL
            </div>
          </div>
          <Terminal size={96} color={ORANGE} strokeWidth={2.3} />
        </div>
      </div>
      <InkTexture strength={0.18} />
    </Stage>
  );
};

const GlobalGlitch: React.FC = () => {
  const frame = useCurrentFrame();
  const cuts = [0, 48, 96, 180, 276, 372];
  const distance = Math.min(...cuts.map((cut) => Math.abs(frame - cut)));
  const active = distance <= 3;
  const flash = Math.max(
    ...cuts.map((cut) => interpolate(frame, [cut, cut + 1, cut + 4], [0, 0.82, 0], clamp)),
  );
  if (!active && flash <= 0) return null;
  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      <AbsoluteFill style={{ background: frame % 2 ? WHITE : ORANGE, opacity: flash }} />
      {Array.from({ length: 12 }, (_, index) => (
        <div
          key={index}
          style={{
            position: "absolute",
            left: -120,
            right: -120,
            top: index * 158 + ((frame * 37 + index * 53) % 110),
            height: 8 + random(`glitch-height-${index}`) * 42,
            background: index % 3 === 0 ? ORANGE : index % 2 ? WHITE : BLACK,
            translate: `${(random(`glitch-${index}-${frame}`) - 0.5) * 620}px 0px`,
            opacity: 0.88,
          }}
        />
      ))}
    </AbsoluteFill>
  );
};

const BeatOverlay: React.FC = () => {
  const frame = useCurrentFrame();
  const hit = beatPunch(frame);
  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      <AbsoluteFill style={{ border: `${8 + hit * 14}px solid ${frame % (BEAT * 4) < BEAT ? ORANGE : WHITE}`, opacity: 0.1 + hit * 0.16 }} />
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: `${18 + ((frame * 43) % 94)}%`,
          height: 3,
          background: WHITE,
          opacity: hit * 0.24,
        }}
      />
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: "repeating-linear-gradient(0deg, rgba(255,255,255,.055) 0 2px, transparent 2px 7px)",
          opacity: 0.42,
        }}
      />
    </AbsoluteFill>
  );
};

const MonarchPhonkVideo: React.FC = () => (
  <AbsoluteFill style={{ backgroundColor: BLACK }}>
    <Audio
      src={staticFile("monarch-phonk-original.wav")}
      volume={(frame) => interpolate(frame, [0, 8, PHONK_DURATION - 14, PHONK_DURATION], [0, 0.78, 0.78, 0], clamp)}
    />
    <Sequence durationInFrames={48}><StencilHook /></Sequence>
    <Sequence from={48} durationInFrames={48}><LogoShock /></Sequence>
    <Sequence from={96} durationInFrames={84}><ModuleGrid /></Sequence>
    <Sequence from={180} durationInFrames={96}><MascotPoster /></Sequence>
    <Sequence from={276} durationInFrames={96}><ModuleRush /></Sequence>
    <Sequence from={372} durationInFrames={84}><FinalPoster /></Sequence>
    <BeatOverlay />
    <GlobalGlitch />
  </AbsoluteFill>
);

export const MonarchPhonkComposition: React.FC = () => (
  <Composition
    id="MonarchPhonkEdit"
    component={MonarchPhonkVideo}
    durationInFrames={PHONK_DURATION}
    fps={FPS}
    width={1080}
    height={1920}
    defaultProps={{}}
  />
);
