// Shape of an episode script. The Python pipeline fills in `audio`,
// `durationSec` and `words` for each scene before rendering.

export type LonLat = [number, number];

export type Camera = {
  /** Map centre as [longitude, latitude]. */
  center: LonLat;
  /** 1 = whole world fits the frame width. 4–6 is roughly "Europe". */
  zoom: number;
};

export type Faction = {
  color: string;
  countries: string[];
};

export type Region = {
  /** Start from a faction defined at the episode level… */
  faction?: string;
  /** …and/or list modern country names (see docs/countries.txt). Added to the faction's. */
  countries?: string[];
  /** Country names to remove from the faction for this scene. */
  remove?: string[];
  /** Overrides the faction colour. */
  color?: string;
  /** Optional label drawn at `labelAt` (or the centroid of the first country). */
  label?: string;
  labelAt?: LonLat;
};

export type MapLabel = {
  text: string;
  coord: LonLat;
  /** "city" draws a dot; "area" is larger, spaced-out text with no dot. */
  kind?: 'city' | 'area';
};

export type Arrow = {
  from: LonLat;
  to: LonLat;
  color?: string;
};

export type WordTiming = {
  text: string;
  /** Seconds from the start of the scene. */
  start: number;
  end: number;
};

export type Scene = {
  id: string;
  narration: string;
  camera: Camera;
  regions?: Region[];
  labels?: MapLabel[];
  arrows?: Arrow[];
  /** Big text card shown over the map for this scene. */
  title?: string;
  /** Small year/date badge, e.g. "476 AD". */
  year?: string;

  // Filled in by the pipeline:
  audio?: string;
  durationSec?: number;
  words?: WordTiming[];
};

export type Episode = {
  title: string;
  /** Short line shown at the top of vertical videos for the whole runtime. */
  hook?: string;
  /** Optional background music file in video/public/, e.g. "music/bed.mp3". */
  music?: string;
  musicVolume?: number;
  /** Reusable country groups, e.g. "rome": {color, countries}. */
  factions?: Record<string, Faction>;
  scenes: Scene[];
};
