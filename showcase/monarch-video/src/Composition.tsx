import { Audio } from "@remotion/media";
import { TransitionSeries, linearTiming } from "@remotion/transitions";
import { fade } from "@remotion/transitions/fade";
import { slide } from "@remotion/transitions/slide";
import {
  AbsoluteFill,
  Composition,
  interpolate,
  staticFile,
} from "remotion";
import {
  CoreScene,
  ExperienceScene,
  FinalScene,
  HeroScene,
  LocalFirstScene,
  ModulesScene,
  OscarScene,
  SafeScene,
  SecurityScene,
} from "./scenes";

const TRANSITION_FRAMES = 18;
const SCENE_DURATIONS = [180, 180, 210, 210, 210, 210, 180, 195, 180] as const;

export const TOTAL_DURATION = SCENE_DURATIONS.reduce((sum, duration) => sum + duration, 0)
  - TRANSITION_FRAMES * (SCENE_DURATIONS.length - 1);

const transitionTiming = linearTiming({ durationInFrames: TRANSITION_FRAMES });

const MonarchVideo: React.FC = () => (
  <AbsoluteFill style={{ backgroundColor: "#050505" }}>
    <Audio
      src={staticFile("monarch-ambient.mp3")}
      volume={(frame) => interpolate(
        frame,
        [0, 60, TOTAL_DURATION - 90, TOTAL_DURATION],
        [0, 0.42, 0.42, 0],
        { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
      )}
    />
    <TransitionSeries>
      <TransitionSeries.Sequence durationInFrames={SCENE_DURATIONS[0]}>
        <HeroScene />
      </TransitionSeries.Sequence>
      <TransitionSeries.Transition presentation={fade()} timing={transitionTiming} />

      <TransitionSeries.Sequence durationInFrames={SCENE_DURATIONS[1]}>
        <LocalFirstScene />
      </TransitionSeries.Sequence>
      <TransitionSeries.Transition presentation={slide({ direction: "from-right" })} timing={transitionTiming} />

      <TransitionSeries.Sequence durationInFrames={SCENE_DURATIONS[2]}>
        <CoreScene />
      </TransitionSeries.Sequence>
      <TransitionSeries.Transition presentation={fade()} timing={transitionTiming} />

      <TransitionSeries.Sequence durationInFrames={SCENE_DURATIONS[3]}>
        <OscarScene />
      </TransitionSeries.Sequence>
      <TransitionSeries.Transition presentation={slide({ direction: "from-bottom" })} timing={transitionTiming} />

      <TransitionSeries.Sequence durationInFrames={SCENE_DURATIONS[4]}>
        <ModulesScene />
      </TransitionSeries.Sequence>
      <TransitionSeries.Transition presentation={fade()} timing={transitionTiming} />

      <TransitionSeries.Sequence durationInFrames={SCENE_DURATIONS[5]}>
        <SecurityScene />
      </TransitionSeries.Sequence>
      <TransitionSeries.Transition presentation={slide({ direction: "from-left" })} timing={transitionTiming} />

      <TransitionSeries.Sequence durationInFrames={SCENE_DURATIONS[6]}>
        <SafeScene />
      </TransitionSeries.Sequence>
      <TransitionSeries.Transition presentation={fade()} timing={transitionTiming} />

      <TransitionSeries.Sequence durationInFrames={SCENE_DURATIONS[7]}>
        <ExperienceScene />
      </TransitionSeries.Sequence>
      <TransitionSeries.Transition presentation={slide({ direction: "from-bottom" })} timing={transitionTiming} />

      <TransitionSeries.Sequence durationInFrames={SCENE_DURATIONS[8]}>
        <FinalScene />
      </TransitionSeries.Sequence>
    </TransitionSeries>
  </AbsoluteFill>
);

export const MonarchComposition: React.FC = () => (
  <Composition
    id="MonarchProject"
    component={MonarchVideo}
    durationInFrames={TOTAL_DURATION}
    fps={30}
    width={1920}
    height={1080}
    defaultProps={{}}
  />
);
