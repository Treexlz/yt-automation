import type {Episode, Scene, WordTiming} from './types';

export const FPS = 30;

/** Seconds of silence after each scene's narration. */
const SCENE_TAIL = 0.5;

export const estimateSeconds = (text: string) => {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return words / 2.6 + 0.4; // ~156 words per minute
};

export const sceneSeconds = (s: Scene) =>
  (s.durationSec ?? estimateSeconds(s.narration)) + SCENE_TAIL;

export type ResolvedRegion = {
  countries: string[];
  color: string;
  label?: string;
  labelAt?: [number, number];
};

export type TimedScene = Omit<Scene, 'regions'> & {
  regions: ResolvedRegion[];
  from: number;
  frames: number;
};

const resolveRegions = (ep: Episode, s: Scene): ResolvedRegion[] =>
  (s.regions ?? []).map((r) => {
    const f = r.faction ? ep.factions?.[r.faction] : undefined;
    if (r.faction && !f) console.warn(`Unknown faction "${r.faction}" in scene ${s.id}`);
    const remove = new Set(r.remove ?? []);
    const countries = [...new Set([...(f?.countries ?? []), ...(r.countries ?? [])])].filter(
      (c) => !remove.has(c),
    );
    return {
      countries,
      color: r.color ?? f?.color ?? '#9b2d3a',
      label: r.label,
      labelAt: r.labelAt,
    };
  });

export const timeline = (ep: Episode): TimedScene[] => {
  let from = 0;
  return ep.scenes.map((s) => {
    const frames = Math.max(1, Math.round(sceneSeconds(s) * FPS));
    const t = {...s, regions: resolveRegions(ep, s), from, frames};
    from += frames;
    return t;
  });
};

export const totalFrames = (ep: Episode) =>
  timeline(ep).reduce((n, s) => n + s.frames, 0);

/**
 * Word timings for captions. Uses real timings from the TTS engine when
 * the pipeline supplied them, otherwise spreads words across the narration
 * in proportion to their length.
 */
export const wordTimings = (s: Scene): WordTiming[] => {
  if (s.words && s.words.length > 0) return s.words;
  const words = s.narration.trim().split(/\s+/).filter(Boolean);
  const dur = s.durationSec ?? estimateSeconds(s.narration);
  const weights = words.map((w) => w.length + 2);
  const total = weights.reduce((a, b) => a + b, 0);
  let t = 0;
  return words.map((text, i) => {
    const len = (weights[i] / total) * dur;
    const wt = {text, start: t, end: t + len};
    t += len;
    return wt;
  });
};
