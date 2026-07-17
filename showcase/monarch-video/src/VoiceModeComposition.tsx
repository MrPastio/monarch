import type {CSSProperties} from "react";
import {
  AbsoluteFill,
  Composition,
  Easing,
  interpolate,
  useCurrentFrame,
} from "remotion";
import {COLORS, EASE, FONT} from "./theme";

const FPS = 30;
const STATE_DURATION = 84;
const STATE_COUNT = 5;

export const VOICE_MODE_DURATION = STATE_DURATION * STATE_COUNT;

const clamp = {
  extrapolateLeft: "clamp" as const,
  extrapolateRight: "clamp" as const,
};

const ease = Easing.bezier(...EASE);
const morphFrames = [0, 72, 96, 156, 180, 240, 264, 324, 348, VOICE_MODE_DURATION - 1];

const STATES = [
  {
    number: "01",
    name: "ОЖИДАНИЕ",
    title: "Спокойное присутствие",
    description: "Медленное дыхание. Oscar готов к разговору.",
  },
  {
    number: "02",
    name: "СЛУШАЕТ",
    title: "Живой отклик на голос",
    description: "Halo и ядро мягко следуют громкости и паузам.",
  },
  {
    number: "03",
    name: "ДУМАЕТ",
    title: "Мысль собирает форму",
    description: "Орб становится пластичнее, частицы показывают процесс.",
  },
  {
    number: "04",
    name: "ОТВЕЧАЕТ",
    title: "Ответ ощущается живым",
    description: "Свет и форма раскрываются в ритме синтезированной речи.",
  },
  {
    number: "05",
    name: "ПАУЗА",
    title: "Тихая, устойчивая пауза",
    description: "Движение замирает, состояние разговора сохраняется.",
  },
] as const;

const morph = (frame: number, values: readonly [number, number, number, number, number]) =>
  interpolate(
    frame,
    morphFrames,
    [
      values[0],
      values[0],
      values[1],
      values[1],
      values[2],
      values[2],
      values[3],
      values[3],
      values[4],
      values[4],
    ],
    {...clamp, easing: ease},
  );

const stateOpacity = (frame: number, index: number) => {
  const start = index * STATE_DURATION;
  const end = (index + 1) * STATE_DURATION;
  const fadeIn = index === 0
    ? 1
    : interpolate(frame, [start - 12, start + 12], [0, 1], {...clamp, easing: ease});
  const fadeOut = index === STATE_COUNT - 1
    ? 1
    : interpolate(frame, [end - 12, end + 12], [1, 0], {...clamp, easing: ease});

  return fadeIn * fadeOut;
};

type Point = {x: number; y: number};

const smoothClosedPath = (points: readonly Point[]) => {
  const point = (index: number) => points[(index + points.length) % points.length];
  const first = point(0);
  let path = `M ${first.x.toFixed(2)} ${first.y.toFixed(2)}`;

  for (let index = 0; index < points.length; index += 1) {
    const previous = point(index - 1);
    const current = point(index);
    const next = point(index + 1);
    const afterNext = point(index + 2);
    const controlOne = {
      x: current.x + (next.x - previous.x) / 6,
      y: current.y + (next.y - previous.y) / 6,
    };
    const controlTwo = {
      x: next.x - (afterNext.x - current.x) / 6,
      y: next.y - (afterNext.y - current.y) / 6,
    };

    path += ` C ${controlOne.x.toFixed(2)} ${controlOne.y.toFixed(2)}, ${controlTwo.x.toFixed(2)} ${controlTwo.y.toFixed(2)}, ${next.x.toFixed(2)} ${next.y.toFixed(2)}`;
  }

  return `${path} Z`;
};

const blobPath = ({
  motionFrame,
  radius,
  deformation,
  phase,
  direction = 1,
}: {
  motionFrame: number;
  radius: number;
  deformation: number;
  phase: number;
  direction?: number;
}) => {
  const points = Array.from({length: 16}, (_, index) => {
    const angle = (index / 16) * Math.PI * 2;
    const wave =
      Math.sin(angle * 3 + motionFrame * 0.035 * direction + phase) * 0.52 +
      Math.sin(angle * 5 - motionFrame * 0.026 * direction + phase * 1.7) * 0.31 +
      Math.sin(angle * 2 + motionFrame * 0.018 + phase * 0.6) * 0.17;
    const localRadius = radius * (1 + deformation * wave);

    return {
      x: 300 + Math.cos(angle) * localRadius,
      y: 300 + Math.sin(angle) * localRadius,
    };
  });

  return smoothClosedPath(points);
};

const Background: React.FC<{motionFrame: number; intensity: number}> = ({
  motionFrame,
  intensity,
}) => {
  const drift = interpolate(motionFrame, [0, 342], [-28, 34], clamp);

  return (
    <AbsoluteFill
      style={{
        overflow: "hidden",
        background:
          "radial-gradient(circle at 50% 43%, rgba(255,138,0,.12), transparent 34%), linear-gradient(145deg, #080705 0%, #050505 48%, #020202 100%)",
      }}
    >
      <div
        style={{
          position: "absolute",
          inset: -120,
          opacity: 0.11,
          backgroundImage:
            "linear-gradient(rgba(255,255,255,.045) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.045) 1px, transparent 1px)",
          backgroundSize: "76px 76px",
          translate: `${drift * 0.22}px ${drift * 0.12}px`,
          rotate: "-4deg",
          maskImage: "radial-gradient(circle at 50% 45%, black, transparent 73%)",
        }}
      />
      <div
        style={{
          position: "absolute",
          width: 860,
          height: 860,
          left: "50%",
          top: "43%",
          marginLeft: -430,
          marginTop: -430,
          borderRadius: "50%",
          opacity: 0.25 + intensity * 0.25,
          scale: 0.94 + intensity * 0.08,
          background: "radial-gradient(circle, rgba(255,138,0,.25), rgba(255,194,71,.06) 42%, transparent 72%)",
          filter: "blur(42px)",
        }}
      />
      <div
        style={{
          position: "absolute",
          width: 660,
          height: 660,
          left: -390,
          top: -390,
          borderRadius: "50%",
          background: "radial-gradient(circle, rgba(255,194,71,.11), transparent 70%)",
          translate: `${drift}px ${drift * 0.4}px`,
          filter: "blur(18px)",
        }}
      />
      <div
        style={{
          position: "absolute",
          width: 760,
          height: 760,
          right: -460,
          bottom: -510,
          borderRadius: "50%",
          background: "radial-gradient(circle, rgba(255,138,0,.08), transparent 70%)",
          translate: `${-drift}px ${-drift * 0.35}px`,
          filter: "blur(26px)",
        }}
      />
      <div
        style={{
          position: "absolute",
          inset: 28,
          borderRadius: 34,
          border: "1px solid rgba(255,255,255,.045)",
          boxShadow: "inset 0 1px 0 rgba(255,255,255,.025)",
        }}
      />
    </AbsoluteFill>
  );
};

const PixelHalo: React.FC<{
  frame: number;
  motionFrame: number;
  listening: number;
  thinking: number;
  speaking: number;
  paused: number;
}> = ({frame, motionFrame, listening, thinking, speaking, paused}) => {
  const haloStrength = morph(frame, [0.25, 0.72, 0.88, 0.82, 0.14]);

  return (
    <div style={{position: "absolute", inset: 0}}>
      {Array.from({length: 64}, (_, index) => {
        const baseAngle = (index / 64) * Math.PI * 2;
        const angle = baseAngle + motionFrame * 0.0028;
        const voiceWave =
          (Math.sin(motionFrame * 0.36 + baseAngle * 4) +
            Math.sin(motionFrame * 0.17 - baseAngle * 7)) *
          0.5;
        const thoughtWave = Math.sin(motionFrame * 0.11 + index * 1.73);
        const speechWave = Math.sin(motionFrame * 0.48 + baseAngle * 5.5);
        const radius =
          246 +
          Math.sin(index * 2.13) * 9 +
          listening * (12 + voiceWave * 13) +
          thinking * (22 + thoughtWave * 16) +
          speaking * (18 + speechWave * 19);
        const size = 3 + (index % 5) * 0.85 + (thinking + speaking) * 1.4;
        const flicker = 0.55 + Math.sin(motionFrame * 0.16 + index * 2.41) * 0.25;
        const opacity = Math.max(
          0.03,
          Math.min(0.94, haloStrength * flicker * (1 - paused * 0.78)),
        );

        return (
          <div
            key={index}
            style={{
              position: "absolute",
              left: 300 + Math.cos(angle) * radius - size / 2,
              top: 300 + Math.sin(angle) * radius - size / 2,
              width: size,
              height: size,
              borderRadius: index % 3 === 0 ? 2 : "50%",
              rotate: `${(index * 17 + motionFrame * 0.18) % 360}deg`,
              opacity,
              background: index % 4 === 0 ? COLORS.white : index % 2 === 0 ? COLORS.gold : COLORS.orange,
              boxShadow: `0 0 ${8 + haloStrength * 16}px rgba(255,138,0,${0.18 + haloStrength * 0.45})`,
            }}
          />
        );
      })}
    </div>
  );
};

const ThoughtParticles: React.FC<{
  motionFrame: number;
  thinking: number;
  speaking: number;
}> = ({motionFrame, thinking, speaking}) => {
  const visibility = Math.min(1, thinking * 1.12 + speaking * 0.34);

  return (
    <div style={{position: "absolute", inset: 0}}>
      {Array.from({length: 12}, (_, index) => {
        const direction = index % 2 === 0 ? 1 : -1;
        const angle = (index / 12) * Math.PI * 2 + motionFrame * 0.009 * direction;
        const orbit = 188 + (index % 4) * 31 + Math.sin(motionFrame * 0.08 + index) * 13;
        const size = 7 + (index % 4) * 2.5;
        const pulse = 0.55 + Math.sin(motionFrame * 0.15 + index * 1.9) * 0.34;

        return (
          <div
            key={index}
            style={{
              position: "absolute",
              left: 300 + Math.cos(angle) * orbit - size / 2,
              top: 300 + Math.sin(angle) * orbit - size / 2,
              width: size,
              height: size,
              borderRadius: "50%",
              opacity: visibility * Math.max(0.12, pulse),
              scale: 0.78 + pulse * 0.34,
              background: index % 3 === 0 ? COLORS.white : index % 2 === 0 ? COLORS.gold : COLORS.orange,
              boxShadow: `0 0 ${18 + size}px ${index % 3 === 0 ? "rgba(255,255,255,.48)" : "rgba(255,138,0,.56)"}`,
            }}
          />
        );
      })}
    </div>
  );
};

const VoiceOrb: React.FC<{frame: number}> = ({frame}) => {
  const motionFrame = interpolate(frame, [0, 324, 348, VOICE_MODE_DURATION - 1], [0, 324, 342, 342], clamp);
  const listening = morph(frame, [0, 1, 0, 0, 0]);
  const thinking = morph(frame, [0, 0, 1, 0, 0]);
  const speaking = morph(frame, [0, 0, 0, 1, 0]);
  const paused = morph(frame, [0, 0, 0, 0, 1]);
  const energy = morph(frame, [0.24, 0.82, 0.74, 1, 0.08]);
  const radius = morph(frame, [160, 177, 158, 184, 168]);
  const deformation = morph(frame, [0.025, 0.055, 0.17, 0.115, 0.012]);
  const breath = (Math.sin(motionFrame * 0.075) + 1) / 2;
  const voicePulse = (Math.sin(motionFrame * 0.43) + Math.sin(motionFrame * 0.19 + 1.4)) * 0.5;
  const activePulse = listening * voicePulse * 0.035 + speaking * voicePulse * 0.05;
  const orbScale = 0.98 + breath * 0.018 + activePulse - paused * 0.015;
  const intro = interpolate(frame, [0, 18], [0, 1], {...clamp, easing: ease});
  const outerPath = blobPath({motionFrame, radius: radius + 25, deformation: deformation * 0.88, phase: 1.3, direction: -1});
  const corePath = blobPath({motionFrame, radius, deformation, phase: 0.2});
  const innerPath = blobPath({motionFrame, radius: radius * 0.71, deformation: deformation * 0.72, phase: 2.7, direction: -1});
  const ringOpacity = morph(frame, [0.12, 0.38, 0.25, 0.34, 0.07]);

  return (
    <div
      style={{
        position: "relative",
        width: 600,
        height: 600,
        opacity: intro,
        scale: interpolate(intro, [0, 1], [0.78, 1]) * orbScale,
      }}
    >
      <div
        style={{
          position: "absolute",
          inset: 58,
          borderRadius: "50%",
          background: `radial-gradient(circle, rgba(255,194,71,${0.1 + energy * 0.16}), rgba(255,138,0,${0.05 + energy * 0.11}) 42%, transparent 72%)`,
          filter: "blur(34px)",
          scale: 1.08 + energy * 0.12,
        }}
      />

      {[510, 548, 586].map((size, index) => (
        <div
          key={size}
          style={{
            position: "absolute",
            left: (600 - size) / 2,
            top: (600 - size) / 2,
            width: size,
            height: size,
            borderRadius: "50%",
            border: `1px solid rgba(255,194,71,${ringOpacity * (0.74 - index * 0.15)})`,
            opacity: 0.82 - index * 0.18,
            scale: 1 + Math.sin(motionFrame * 0.052 + index * 1.8) * (0.006 + energy * 0.008),
          }}
        />
      ))}

      <PixelHalo
        frame={frame}
        motionFrame={motionFrame}
        listening={listening}
        thinking={thinking}
        speaking={speaking}
        paused={paused}
      />
      <ThoughtParticles motionFrame={motionFrame} thinking={thinking} speaking={speaking} />

      <svg
        width="600"
        height="600"
        viewBox="0 0 600 600"
        style={{position: "absolute", inset: 0, overflow: "visible"}}
      >
        <defs>
          <radialGradient id="voice-core" cx="39%" cy="32%" r="72%">
            <stop offset="0%" stopColor="#FFF8E8" />
            <stop offset="22%" stopColor="#FFE29A" />
            <stop offset="54%" stopColor="#FFC247" />
            <stop offset="78%" stopColor="#FF8A00" />
            <stop offset="100%" stopColor="#351302" />
          </radialGradient>
          <radialGradient id="voice-inner" cx="36%" cy="28%" r="78%">
            <stop offset="0%" stopColor="#FFFFFF" stopOpacity=".96" />
            <stop offset="34%" stopColor="#FFE8A8" stopOpacity=".82" />
            <stop offset="100%" stopColor="#FF8A00" stopOpacity="0" />
          </radialGradient>
          <filter id="voice-aura" x="-45%" y="-45%" width="190%" height="190%">
            <feGaussianBlur stdDeviation="24" />
          </filter>
          <filter id="voice-glow" x="-35%" y="-35%" width="170%" height="170%">
            <feGaussianBlur stdDeviation="8" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        <path
          d={outerPath}
          fill="#FF8A00"
          opacity={0.08 + energy * 0.2}
          filter="url(#voice-aura)"
        />
        <path
          d={outerPath}
          fill="rgba(255,138,0,.16)"
          stroke="rgba(255,194,71,.38)"
          strokeWidth={1.2 + energy * 1.3}
          opacity={0.48 + energy * 0.36}
        />
        <path
          d={corePath}
          fill="url(#voice-core)"
          stroke="rgba(255,238,190,.72)"
          strokeWidth={0.9 + energy * 1.1}
          opacity={0.62 + energy * 0.34 - paused * 0.12}
          filter="url(#voice-glow)"
        />
        <path
          d={innerPath}
          fill="url(#voice-inner)"
          opacity={0.16 + listening * 0.2 + thinking * 0.26 + speaking * 0.52}
          style={{mixBlendMode: "screen"}}
        />
      </svg>

      <div
        style={{
          position: "absolute",
          left: 228,
          top: 216,
          width: 104,
          height: 72,
          borderRadius: "50%",
          rotate: "-18deg",
          opacity: 0.12 + energy * 0.28,
          background: "radial-gradient(ellipse, rgba(255,255,255,.86), transparent 72%)",
          filter: "blur(7px)",
          mixBlendMode: "screen",
        }}
      />
    </div>
  );
};

const Header: React.FC<{frame: number}> = ({frame}) => {
  const intro = interpolate(frame, [4, 24], [0, 1], {...clamp, easing: ease});

  return (
    <div
      style={{
        height: 56,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        opacity: intro,
        translate: `0px ${interpolate(intro, [0, 1], [-14, 0])}px`,
      }}
    >
      <div style={{display: "flex", alignItems: "center", gap: 18}}>
        <div
          style={{
            width: 40,
            height: 40,
            borderRadius: 13,
            display: "grid",
            placeItems: "center",
            border: "1px solid rgba(255,194,71,.38)",
            background: "linear-gradient(145deg, rgba(255,138,0,.18), rgba(12,12,12,.72))",
            boxShadow: "0 12px 34px rgba(255,138,0,.12), inset 0 1px 0 rgba(255,255,255,.12)",
          }}
        >
          <div style={{width: 10, height: 10, borderRadius: "50%", background: COLORS.gold, boxShadow: `0 0 18px ${COLORS.orange}`}} />
        </div>
        <div>
          <div style={{fontSize: 20, fontWeight: 820, letterSpacing: 3.4}}>MONARCH</div>
          <div style={{marginTop: 2, color: COLORS.muted, fontSize: 15, fontWeight: 650, letterSpacing: 2.2}}>VOICE MODE · MOTION SYSTEM</div>
        </div>
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 11,
          padding: "10px 16px",
          borderRadius: 999,
          border: "1px solid rgba(255,255,255,.09)",
          background: "rgba(18,18,16,.54)",
          boxShadow: "inset 0 1px 0 rgba(255,255,255,.06)",
          color: COLORS.muted,
          fontSize: 16,
          fontWeight: 680,
          letterSpacing: 1.5,
        }}
      >
        <span style={{width: 7, height: 7, borderRadius: "50%", background: COLORS.orange, boxShadow: `0 0 12px ${COLORS.orange}`}} />
        1920 × 1080 · 30 FPS
      </div>
    </div>
  );
};

const StateLabels: React.FC<{frame: number}> = ({frame}) => (
  <div style={{position: "relative", height: 87, textAlign: "center"}}>
    {STATES.map((state, index) => {
      const opacity = stateOpacity(frame, index);
      return (
        <div
          key={state.name}
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            opacity,
            translate: `0px ${interpolate(opacity, [0, 1], [12, 0])}px`,
          }}
        >
          <div style={{display: "flex", alignItems: "center", gap: 11, color: COLORS.gold, fontSize: 17, fontWeight: 820, letterSpacing: 3.2}}>
            <span>{state.number}</span>
            <span style={{width: 26, height: 1, background: "rgba(255,194,71,.56)"}} />
            <span>{state.name}</span>
          </div>
          <div style={{marginTop: 7, color: COLORS.white, fontSize: 37, lineHeight: 1, fontWeight: 760, letterSpacing: -1.2}}>
            {state.title}
          </div>
          <div style={{marginTop: 7, color: COLORS.muted, fontSize: 21, lineHeight: 1.15, fontWeight: 500}}>
            {state.description}
          </div>
        </div>
      );
    })}
  </div>
);

const StateRail: React.FC<{frame: number}> = ({frame}) => {
  const intro = interpolate(frame, [18, 38], [0, 1], {...clamp, easing: ease});

  return (
    <div
      style={{
        height: 62,
        display: "grid",
        gridTemplateColumns: "repeat(5, 1fr)",
        alignItems: "center",
        padding: "0 16px",
        borderRadius: 22,
        border: "1px solid rgba(255,255,255,.085)",
        background: "linear-gradient(145deg, rgba(28,27,24,.67), rgba(8,8,8,.74))",
        boxShadow: "0 20px 70px rgba(0,0,0,.28), inset 0 1px 0 rgba(255,255,255,.07)",
        backdropFilter: "blur(22px)",
        WebkitBackdropFilter: "blur(22px)",
        opacity: intro,
        translate: `0px ${interpolate(intro, [0, 1], [16, 0])}px`,
      }}
    >
      {STATES.map((state, index) => {
        const active = stateOpacity(frame, index);
        const segmentStyle: CSSProperties = {
          height: 34,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 10,
          borderRight: index === STATES.length - 1 ? undefined : "1px solid rgba(255,255,255,.075)",
          color: active > 0.5 ? COLORS.white : "rgba(247,245,239,.38)",
          fontSize: 15,
          fontWeight: 760,
          letterSpacing: 1.25,
        };

        return (
          <div key={state.name} style={segmentStyle}>
            <span
              style={{
                width: 7 + active * 3,
                height: 7 + active * 3,
                borderRadius: "50%",
                background: active > 0.2 ? COLORS.gold : "rgba(255,255,255,.18)",
                boxShadow: active > 0.2 ? `0 0 ${8 + active * 14}px ${COLORS.orange}` : undefined,
                opacity: 0.5 + active * 0.5,
              }}
            />
            <span>{state.name}</span>
          </div>
        );
      })}
    </div>
  );
};

const MonarchVoiceModeVideo: React.FC = () => {
  const frame = useCurrentFrame();
  const motionFrame = interpolate(frame, [0, 324, 348, VOICE_MODE_DURATION - 1], [0, 324, 342, 342], clamp);
  const intensity = morph(frame, [0.24, 0.82, 0.74, 1, 0.08]);

  return (
    <AbsoluteFill style={{backgroundColor: COLORS.black, color: COLORS.white, fontFamily: FONT}}>
      <Background motionFrame={motionFrame} intensity={intensity} />
      <AbsoluteFill
        style={{
          padding: "100px 104px",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <Header frame={frame} />

        <div style={{flex: 1, minHeight: 0, display: "grid", placeItems: "center"}}>
          <VoiceOrb frame={frame} />
        </div>

        <div style={{height: 166, display: "flex", flexDirection: "column", gap: 17}}>
          <StateLabels frame={frame} />
          <StateRail frame={frame} />
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

export const MonarchVoiceModeComposition: React.FC = () => (
  <Composition
    id="MonarchVoiceMode"
    component={MonarchVoiceModeVideo}
    durationInFrames={VOICE_MODE_DURATION}
    fps={FPS}
    width={1920}
    height={1080}
    defaultProps={{}}
  />
);
