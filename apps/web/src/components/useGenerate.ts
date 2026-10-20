import { useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import { GENERATE_EVENT, takePipeline, VideoPipeline } from "../pipeline";
import { useEditor } from "../store";
import { GenerateStatus, loadPrefs, savePrefs, type AgentPrefs, type GenerateState } from "./GeneratePanel";

const POLL_MS = 1500;

/** The agent run of a project: polled status, the user's mode, start and stop. */
export function useGenerate(projectId: string) {
  const [state, setState] = useState<GenerateState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [prefs, setPrefs] = useState<AgentPrefs>(loadPrefs);
  /** The page opened while the team was already working (reload, or came back to the video). */
  const [resumed, setResumed] = useState(false);
  const running = state?.status === GenerateStatus.Running;

  useEffect(() => {
    let alive = true;
    let first = true;
    const tick = () =>
      api.generateStatus(projectId).then(
        (s) => {
          if (!alive) return;
          if (first && s.status === GenerateStatus.Running) setResumed(true);
          first = false;
          setState(s);
        },
        () => undefined,
      );
    void tick();
    const timer = setInterval(tick, POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [projectId]);

  const start = async (instruction = "", references: string[] = [], extra: { resume?: boolean; sfxOnly?: boolean } = {}) => {
    setError(null);
    try {
      setState(await api.generate(projectId, instruction, prefs, references, extra));
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    }
  };

  // Videos fresh from the wizard start by themselves (after their captions, if they have a voice).
  const startRef = useRef(start);
  startRef.current = start;
  useEffect(() => {
    if (takePipeline(projectId, VideoPipeline.Generate)) void startRef.current();
    const onGo = (e: Event) => (e as CustomEvent<string>).detail === projectId && void startRef.current();
    window.addEventListener(GENERATE_EVENT, onGo);
    return () => window.removeEventListener(GENERATE_EVENT, onGo);
  }, [projectId]);

  // The canvas overlay shows the build too.
  useEffect(() => {
    useEditor.setState({ agentRun: state });
  }, [state]);
  useEffect(() => () => useEditor.setState({ agentRun: null }), []);

  return {
    state,
    running,
    resumed,
    error,
    prefs,
    updatePrefs: (p: Partial<AgentPrefs>) => {
      const next = { ...prefs, ...p };
      setPrefs(next);
      savePrefs(next);
    },
    start,
    resume: () => start("", [], { resume: true }),
    addSound: () => start("", [], { sfxOnly: true }),
    stop: () => void api.stopGenerate(projectId).then(setState),
  };
}

export type Generation = ReturnType<typeof useGenerate>;
