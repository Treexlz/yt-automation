import React, {useMemo} from 'react';
import {Easing, interpolate, interpolateColors} from 'remotion';
import {geoArea, geoCentroid, geoContains, geoGraticule10, geoMercator, geoPath} from 'd3-geo';
import {feature, merge} from 'topojson-client';
import type {Feature, FeatureCollection, MultiPolygon, Polygon} from 'geojson';
import type {GeometryCollection, Topology} from 'topojson-specification';
import topoJson from 'world-atlas/countries-50m.json';
import type {Camera, LonLat} from './types';
import type {ResolvedRegion, TimedScene} from './timing';
import {theme} from './theme';

type CountryProps = {name: string};
type Country = Feature<Polygon | MultiPolygon, CountryProps>;

const topo = topoJson as unknown as Topology<{
  countries: GeometryCollection<CountryProps>;
}>;
// France's map shape includes French Guiana, Réunion etc. Split those off
// so "France" in a script only colours the European mainland and Corsica.
// They stay on the map as "France (overseas)".
const MAINLAND_BOX: Record<string, [number, number, number, number]> = {
  France: [-10, 35, 15, 55], // [minLon, minLat, maxLon, maxLat]
};

const splitOverseas = (c: Country): Country[] => {
  const box = MAINLAND_BOX[c.properties.name];
  if (!box || c.geometry.type !== 'MultiPolygon') return [c];
  const inBox = (coords: Polygon['coordinates']) => {
    const [lon, lat] = geoCentroid({type: 'Polygon', coordinates: coords});
    return lon >= box[0] && lat >= box[1] && lon <= box[2] && lat <= box[3];
  };
  const main = c.geometry.coordinates.filter(inBox);
  const rest = c.geometry.coordinates.filter((p) => !inBox(p));
  return [
    {...c, geometry: {type: 'MultiPolygon', coordinates: main}},
    {
      ...c,
      properties: {name: `${c.properties.name} (overseas)`},
      geometry: {type: 'MultiPolygon', coordinates: rest},
    },
  ];
};

const countries = (
  feature(topo, topo.objects.countries) as FeatureCollection<
    Polygon | MultiPolygon,
    CountryProps
  >
).features
  .filter((f) => f.properties.name !== 'Antarctica')
  .flatMap((f) => splitOverseas(f as Country));

const geometriesByName = new Map(
  topo.objects.countries.geometries.map((g) => [(g.properties as CountryProps).name, g]),
);
const countryByName = new Map(countries.map((c) => [c.properties.name, c]));
const graticule = geoGraticule10();

/** Width the zoom level is measured against, so both formats frame alike. */
const REFERENCE_WIDTH = 1080;
/** Frames spent moving the camera / recolouring at the start of a scene. */
const TRANSITION = 36;

const ease = Easing.bezier(0.45, 0, 0.2, 1);

const mergedOutline = (() => {
  const cache = new Map<string, ReturnType<typeof merge>>();
  return (names: string[]) => {
    const key = [...names].sort().join('|');
    if (!cache.has(key)) {
      const geoms = names
        .map((n) => geometriesByName.get(n))
        .filter((g): g is NonNullable<typeof g> => Boolean(g));
      const merged = merge(topo, geoms as never);
      // Drop overseas pieces (e.g. French Guiana) so the glow hugs the mainland.
      const overseas = countries.filter((c) => c.properties.name.endsWith('(overseas)'));
      merged.coordinates = merged.coordinates.filter((poly) => {
        const centre = geoCentroid({type: 'Polygon', coordinates: poly});
        return !overseas.some((o) => geoContains(o, centre));
      });
      cache.set(key, merged);
    }
    return cache.get(key)!;
  };
})();

/** Centroid of the biggest polygon of a country (ignores far-off territories). */
const mainCentroid = (name: string): LonLat | null => {
  const c = countryByName.get(name);
  if (!c) return null;
  if (c.geometry.type === 'Polygon') return geoCentroid(c) as LonLat;
  let best: Polygon | null = null;
  let bestArea = -1;
  for (const coords of c.geometry.coordinates) {
    const poly: Polygon = {type: 'Polygon', coordinates: coords};
    const a = geoArea(poly);
    if (a > bestArea) {
      bestArea = a;
      best = poly;
    }
  }
  return best ? (geoCentroid(best) as LonLat) : null;
};

const colorMap = (regions: ResolvedRegion[]) => {
  const m = new Map<string, string>();
  for (const r of regions) for (const n of r.countries) m.set(n, r.color);
  return m;
};

const mixCamera = (a: Camera, b: Camera, t: number): Camera => ({
  center: [
    a.center[0] + (b.center[0] - a.center[0]) * t,
    a.center[1] + (b.center[1] - a.center[1]) * t,
  ],
  // Interpolating zoom in log space makes zoom-ins feel even-paced.
  zoom: Math.exp(Math.log(a.zoom) + (Math.log(b.zoom) - Math.log(a.zoom)) * t),
});

export const WorldMap: React.FC<{
  frame: number;
  scenes: TimedScene[];
  width: number;
  height: number;
}> = ({frame, scenes, width, height}) => {
  let i = scenes.findIndex((s) => frame >= s.from && frame < s.from + s.frames);
  if (i === -1) i = scenes.length - 1;
  const scene = scenes[i];
  const prev = scenes[i - 1] ?? scene;
  const local = frame - scene.from;
  const transition = Math.min(TRANSITION, Math.floor(scene.frames / 2));
  const t = ease(Math.min(1, Math.max(0, local / Math.max(1, transition))));

  const cam = mixCamera(prev.camera, scene.camera, t);
  const scale = (REFERENCE_WIDTH / (2 * Math.PI)) * cam.zoom;
  const projection = geoMercator()
    .center(cam.center)
    .scale(scale)
    .translate([width / 2, height / 2]);
  const path = geoPath(projection);

  const prevColors = useMemo(() => colorMap(prev.regions), [prev]);
  const curColors = useMemo(() => colorMap(scene.regions), [scene]);

  const fade = (delay: number, dur = 15) =>
    interpolate(local, [transition * 0.6 + delay, transition * 0.6 + delay + dur], [0, 1], {
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
    });

  // Label size grows gently with zoom so text stays readable when zoomed out.
  const labelScale = Math.min(1.6, Math.max(0.85, Math.sqrt(cam.zoom / 4)));

  const project = (c: LonLat) => projection(c) ?? [-999, -999];

  return (
    <svg width={width} height={height} style={{position: 'absolute', inset: 0}}>
      <defs>
        <filter id="glow" x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation={6} result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
        <marker
          id="arrowhead"
          viewBox="0 0 10 10"
          refX={6}
          refY={5}
          markerWidth={4}
          markerHeight={4}
          orient="auto-start-reverse"
        >
          <path d="M0,0 L10,5 L0,10 z" fill="context-stroke" />
        </marker>
      </defs>

      <rect width={width} height={height} fill={theme.ocean} />
      <path d={path(graticule) ?? ''} fill="none" stroke={theme.graticule} strokeWidth={1} />

      {countries.map((c) => {
        const name = c.properties.name;
        const from = prevColors.get(name) ?? theme.land;
        const to = curColors.get(name) ?? theme.land;
        const fill = from === to ? to : interpolateColors(t, [0, 1], [from, to]);
        return (
          <path
            key={name}
            d={path(c) ?? ''}
            fill={fill}
            stroke={theme.border}
            strokeWidth={0.8}
          />
        );
      })}

      {scene.regions.map((r, k) => (
        <path
          key={`outline-${k}`}
          d={path(mergedOutline(r.countries)) ?? ''}
          fill="none"
          stroke={r.color}
          strokeWidth={3}
          strokeLinejoin="round"
          filter="url(#glow)"
          opacity={fade(0)}
        />
      ))}

      {(scene.arrows ?? []).map((a, k) => {
        const d =
          path({type: 'LineString', coordinates: [a.from, a.to]}) ?? '';
        const progress = fade(8 + k * 10, 30);
        return (
          <path
            key={`arrow-${k}`}
            d={d}
            fill="none"
            stroke={a.color ?? theme.arrow}
            strokeWidth={7}
            strokeLinecap="round"
            pathLength={1}
            strokeDasharray={1}
            strokeDashoffset={1 - progress}
            markerEnd={progress > 0.97 ? 'url(#arrowhead)' : undefined}
            opacity={progress > 0 ? 1 : 0}
          />
        );
      })}

      {scene.regions
        .filter((r) => r.label)
        .map((r, k) => {
          const at = r.labelAt ?? mainCentroid(r.countries[0]);
          if (!at) return null;
          const [x, y] = project(at);
          return (
            <text
              key={`rl-${k}`}
              x={x}
              y={y}
              textAnchor="middle"
              dominantBaseline="middle"
              fontFamily={theme.serif}
              fontWeight={700}
              fontSize={44 * labelScale}
              letterSpacing={6 * labelScale}
              fill={theme.text}
              stroke={theme.ocean}
              strokeWidth={8}
              paintOrder="stroke"
              opacity={fade(6 + k * 6)}
            >
              {r.label!.toUpperCase()}
            </text>
          );
        })}

      {(scene.labels ?? []).map((l, k) => {
        const [x, y] = project(l.coord);
        const area = l.kind === 'area';
        const o = fade(10 + k * 6);
        return (
          <g key={`l-${k}`} opacity={o}>
            {!area && <circle cx={x} cy={y} r={9} fill={theme.text} stroke={theme.ocean} strokeWidth={3} />}
            <text
              x={area ? x : x + 18}
              y={y}
              dominantBaseline="middle"
              textAnchor={area ? 'middle' : 'start'}
              fontFamily={theme.serif}
              fontWeight={area ? 400 : 700}
              fontStyle={area ? 'italic' : 'normal'}
              fontSize={(area ? 38 : 36) * labelScale}
              letterSpacing={area ? 4 : 1}
              fill={theme.text}
              stroke={theme.ocean}
              strokeWidth={7}
              paintOrder="stroke"
            >
              {l.text}
            </text>
          </g>
        );
      })}
    </svg>
  );
};
