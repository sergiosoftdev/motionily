import { LibraryGrid } from "../assets/AssetSources";
import { MotionilyLayout } from "../shell/MotionilyLayout";
import { useAgentName } from "../agentName";

/** Everything agents found, cut out or generated for this account's videos, reused across them. */
export function LibraryScreen() {
  const agent = useAgentName();
  return (
    <MotionilyLayout title="Library" description={`Everything ${agent} found, cut out or generated for your videos, reused across them. Where it searches is in Settings › Asset sources.`}>
      <LibraryGrid />
    </MotionilyLayout>
  );
}
