import "./index.css";
import { MonarchComposition } from "./Composition";
import { MonarchTikTokComposition } from "./TikTokComposition";
import { MonarchVoiceModeComposition } from "./VoiceModeComposition";
import { MonarchPhonkComposition } from "./PhonkEditComposition";

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <MonarchComposition />
      <MonarchTikTokComposition />
      <MonarchVoiceModeComposition />
      <MonarchPhonkComposition />
    </>
  );
};
