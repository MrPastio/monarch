import type { CSSProperties, ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import {
  AbsoluteFill,
  Easing,
  Img,
  interpolate,
  staticFile,
  useCurrentFrame,
} from "remotion";
import { COLORS, EASE, FONT } from "./theme";

export const enter = (frame: number, from = 0, duration = 30) =>
  interpolate(frame, [from, from + duration], [0, 1], {
    easing: Easing.bezier(...EASE),
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

export const pulse = (frame: number, length = 90, min = 0.72, max = 1) =>
  interpolate(frame % length, [0, length / 2, length], [min, max, min], {
    easing: Easing.inOut(Easing.sin),
  });

export const Background: React.FC<{ accent?: "orange" | "gold" }> = ({ accent = "orange" }) => {
  const frame = useCurrentFrame();
  const hue = accent === "orange" ? COLORS.orange : COLORS.gold;
  const drift = interpolate(frame, [0, 210], [-40, 45], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill
      style={{
        overflow: "hidden",
        background: `radial-gradient(circle at 50% 36%, ${hue}12 0%, transparent 38%), linear-gradient(145deg, #060606 0%, #0A0907 54%, #030303 100%)`,
        fontFamily: FONT,
        color: COLORS.white,
      }}
    >
      <div
        style={{
          position: "absolute",
          inset: 0,
          opacity: 0.16,
          backgroundImage:
            "linear-gradient(rgba(255,255,255,.05) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.05) 1px, transparent 1px)",
          backgroundSize: "72px 72px",
          translate: `${drift * 0.18}px ${drift * 0.08}px`,
          maskImage: "radial-gradient(circle at center, black, transparent 76%)",
        }}
      />
      <div
        style={{
          position: "absolute",
          width: 620,
          height: 620,
          borderRadius: "50%",
          left: -280,
          top: -310,
          background: `radial-gradient(circle, ${COLORS.orange}1E, transparent 68%)`,
          translate: `${drift}px ${drift * 0.5}px`,
          filter: "blur(14px)",
        }}
      />
      <div
        style={{
          position: "absolute",
          width: 760,
          height: 760,
          borderRadius: "50%",
          right: -420,
          bottom: -460,
          background: `radial-gradient(circle, ${COLORS.gold}18, transparent 70%)`,
          translate: `${-drift}px ${-drift * 0.45}px`,
          filter: "blur(18px)",
        }}
      />
      <div
        style={{
          position: "absolute",
          inset: 26,
          border: "1px solid rgba(255,255,255,.045)",
          borderRadius: 34,
        }}
      />
    </AbsoluteFill>
  );
};

export const Stage: React.FC<{ children: ReactNode; accent?: "orange" | "gold" }> = ({ children, accent }) => (
  <AbsoluteFill style={{ overflow: "hidden", backgroundColor: COLORS.black }}>
    <Background accent={accent} />
    <AbsoluteFill style={{ padding: "92px 108px", fontFamily: FONT, color: COLORS.white }}>
      {children}
    </AbsoluteFill>
  </AbsoluteFill>
);

export const Glass: React.FC<{
  children: ReactNode;
  style?: CSSProperties;
  glow?: boolean;
}> = ({ children, style, glow = false }) => (
  <div
    style={{
      position: "relative",
      borderRadius: 30,
      border: `1px solid ${glow ? "rgba(255, 194, 71, .42)" : "rgba(255,255,255,.11)"}`,
      background: glow
        ? "linear-gradient(145deg, rgba(41,31,13,.72), rgba(12,12,12,.76))"
        : "linear-gradient(145deg, rgba(28,28,27,.74), rgba(10,10,10,.70))",
      boxShadow: glow
        ? "0 34px 100px rgba(255,138,0,.12), inset 0 1px 0 rgba(255,255,255,.10)"
        : "0 28px 90px rgba(0,0,0,.34), inset 0 1px 0 rgba(255,255,255,.07)",
      backdropFilter: "blur(24px)",
      WebkitBackdropFilter: "blur(24px)",
      ...style,
    }}
  >
    {children}
  </div>
);

export const Kicker: React.FC<{ children: ReactNode; delay?: number }> = ({ children, delay = 0 }) => {
  const frame = useCurrentFrame();
  const p = enter(frame, delay, 24);
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 13,
        fontSize: 24,
        letterSpacing: 4.2,
        textTransform: "uppercase",
        fontWeight: 800,
        color: COLORS.gold,
        opacity: p,
        translate: `${interpolate(p, [0, 1], [-20, 0])}px 0px`,
      }}
    >
      <span style={{ width: 34, height: 3, borderRadius: 99, background: COLORS.orange }} />
      {children}
    </div>
  );
};

export const Headline: React.FC<{
  children: ReactNode;
  delay?: number;
  align?: "left" | "center";
  size?: number;
  width?: number | string;
}> = ({ children, delay = 8, align = "left", size = 86, width = 1120 }) => {
  const frame = useCurrentFrame();
  const p = enter(frame, delay, 34);
  return (
    <div
      style={{
        width,
        textAlign: align,
        fontSize: size,
        lineHeight: 0.98,
        letterSpacing: -4.4,
        fontWeight: 760,
        color: COLORS.white,
        opacity: p,
        translate: `0px ${interpolate(p, [0, 1], [34, 0])}px`,
      }}
    >
      {children}
    </div>
  );
};

export const Copy: React.FC<{
  children: ReactNode;
  delay?: number;
  align?: "left" | "center";
  width?: number | string;
  size?: number;
}> = ({ children, delay = 26, align = "left", width = 760, size = 35 }) => {
  const frame = useCurrentFrame();
  const p = enter(frame, delay, 30);
  return (
    <div
      style={{
        width,
        textAlign: align,
        fontSize: size,
        lineHeight: 1.32,
        fontWeight: 460,
        color: COLORS.muted,
        opacity: p,
        translate: `0px ${interpolate(p, [0, 1], [24, 0])}px`,
      }}
    >
      {children}
    </div>
  );
};

export const Logo: React.FC<{ size?: number; delay?: number; glow?: boolean }> = ({
  size = 118,
  delay = 0,
  glow = true,
}) => {
  const frame = useCurrentFrame();
  const p = enter(frame, delay, 34);
  return (
    <div
      style={{
        width: size,
        height: size,
        display: "grid",
        placeItems: "center",
        opacity: p,
        overflow: "hidden",
        borderRadius: size * 0.22,
        border: `1px solid ${glow ? "rgba(255,194,71,.30)" : "rgba(255,255,255,.10)"}`,
        background: "#020202",
        boxShadow: glow ? `0 18px 60px ${COLORS.orange}24` : undefined,
      }}
    >
      <Img
        src={staticFile("monarch-icon.png")}
        style={{
          width: "100%",
          height: "100%",
          objectFit: "contain",
          scale: interpolate(p, [0, 1], [0.76, 1]),
          filter: glow ? `drop-shadow(0 0 24px ${COLORS.orange}44)` : undefined,
        }}
      />
    </div>
  );
};

export const Pill: React.FC<{
  icon?: LucideIcon;
  children: ReactNode;
  delay?: number;
  active?: boolean;
}> = ({ icon: Icon, children, delay = 0, active = false }) => {
  const frame = useCurrentFrame();
  const p = enter(frame, delay, 24);
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "13px 20px",
        borderRadius: 999,
        border: active ? "1px solid rgba(255,194,71,.50)" : "1px solid rgba(255,255,255,.12)",
        background: active ? "rgba(255,138,0,.12)" : "rgba(255,255,255,.045)",
        color: active ? COLORS.yellow : COLORS.white,
        fontSize: 24,
        fontWeight: 650,
        opacity: p,
        translate: `0px ${interpolate(p, [0, 1], [18, 0])}px`,
      }}
    >
      {Icon ? <Icon size={24} strokeWidth={2.2} color={active ? COLORS.gold : COLORS.muted} /> : null}
      {children}
    </div>
  );
};

export const IconTile: React.FC<{
  icon: LucideIcon;
  label: string;
  detail?: string;
  delay?: number;
  active?: boolean;
  style?: CSSProperties;
}> = ({ icon: Icon, label, detail, delay = 0, active = false, style }) => {
  const frame = useCurrentFrame();
  const p = enter(frame, delay, 28);
  return (
    <Glass
      glow={active}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 17,
        padding: "19px 22px",
        opacity: p,
        scale: interpolate(p, [0, 1], [0.82, 1]),
        translate: `0px ${interpolate(p, [0, 1], [24, 0])}px`,
        ...style,
      }}
    >
      <div
        style={{
          width: 52,
          height: 52,
          borderRadius: 17,
          display: "grid",
          placeItems: "center",
          background: active ? "rgba(255,138,0,.16)" : "rgba(255,255,255,.055)",
          border: `1px solid ${active ? "rgba(255,194,71,.38)" : "rgba(255,255,255,.08)"}`,
          flex: "0 0 auto",
        }}
      >
        <Icon size={28} strokeWidth={2.1} color={active ? COLORS.gold : COLORS.white} />
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span style={{ fontSize: 25, fontWeight: 720, color: COLORS.white }}>{label}</span>
        {detail ? <span style={{ fontSize: 19, color: COLORS.muted }}>{detail}</span> : null}
      </div>
    </Glass>
  );
};

export const ProgressLine: React.FC<{
  progress: number;
  vertical?: boolean;
  style?: CSSProperties;
}> = ({ progress, vertical = false, style }) => (
  <div
    style={{
      position: "relative",
      overflow: "hidden",
      width: vertical ? 3 : "100%",
      height: vertical ? "100%" : 3,
      borderRadius: 99,
      background: "rgba(255,255,255,.10)",
      ...style,
    }}
  >
    <div
      style={{
        position: "absolute",
        left: 0,
        top: 0,
        width: vertical ? "100%" : `${Math.max(0, Math.min(1, progress)) * 100}%`,
        height: vertical ? `${Math.max(0, Math.min(1, progress)) * 100}%` : "100%",
        borderRadius: 99,
        background: `linear-gradient(90deg, ${COLORS.orange}, ${COLORS.gold})`,
        boxShadow: `0 0 22px ${COLORS.orange}AA`,
      }}
    />
  </div>
);

export const SceneIndex: React.FC<{ number: string; label: string }> = ({ number, label }) => {
  const frame = useCurrentFrame();
  const p = enter(frame, 10, 24);
  return (
    <div
      style={{
        position: "absolute",
        right: 108,
        top: 54,
        display: "flex",
        alignItems: "center",
        gap: 13,
        opacity: p,
        color: COLORS.muted,
        fontSize: 19,
        letterSpacing: 2.4,
        textTransform: "uppercase",
      }}
    >
      <span style={{ color: COLORS.gold, fontWeight: 800 }}>{number}</span>
      <span style={{ width: 30, height: 1, background: "rgba(255,255,255,.22)" }} />
      {label}
    </div>
  );
};
