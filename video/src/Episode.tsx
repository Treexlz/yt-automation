import React from 'react';
import {
  AbsoluteFill,
  Audio,
  Sequence,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import type {Episode as EpisodeT, Scene} from './types';
import {FPS, timeline, wordTimings} from './timing';
import {WorldMap} from './WorldMap';
import {theme} from './theme';

const Captions: React.FC<{scene: Scene; vertical: boolean}> = ({scene, vertical}) => {
  const frame = useCurrentFrame();
  const sec = frame / FPS;
  const words = wordTimings(scene);
  const per = vertical ? 3 : 7;

  const chunks: (typeof words)[] = [];
  for (let i = 0; i < words.length; i += per) chunks.push(words.slice(i, i + per));
  const chunk =
    chunks.find((c) => sec >= c[0].start && sec < c[c.length - 1].end + 0.15) ?? null;
  if (!chunk) return null;

  return (
    <div
      style={{
        position: 'absolute',
        left: '6%',
        right: '6%',
        top: vertical ? '64%' : undefined,
        bottom: vertical ? undefined : '7%',
        textAlign: 'center',
        fontFamily: theme.sans,
        fontWeight: 800,
        fontSize: vertical ? 78 : 50,
        lineHeight: 1.15,
        textTransform: vertical ? 'uppercase' : 'none',
        color: '#fff',
        textShadow: '0 4px 18px rgba(0,0,0,0.9), 0 0 4px rgba(0,0,0,0.9)',
      }}
    >
      {chunk.map((w, k) => {
        const active = sec >= w.start && sec < w.end + 0.05;
        return (
          <span key={k} style={{color: active ? theme.accent : '#fff'}}>
            {w.text}{' '}
          </span>
        );
      })}
    </div>
  );
};

const TitleCard: React.FC<{text: string; vertical: boolean}> = ({text, vertical}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const s = spring({frame, fps, config: {damping: 200}});
  return (
    <AbsoluteFill
      style={{
        justifyContent: 'center',
        alignItems: 'center',
        background: `radial-gradient(ellipse at center, rgba(13,27,42,${0.75 * s}) 0%, rgba(13,27,42,${0.35 * s}) 70%)`,
      }}
    >
      <div
        style={{
          fontFamily: theme.serif,
          fontWeight: 700,
          fontSize: vertical ? 110 : 120,
          lineHeight: 1.05,
          color: theme.text,
          textAlign: 'center',
          padding: '0 8%',
          opacity: s,
          transform: `scale(${0.92 + 0.08 * s})`,
          textShadow: '0 6px 30px rgba(0,0,0,0.8)',
          marginTop: vertical ? '-30%' : 0,
        }}
      >
        {text}
      </div>
    </AbsoluteFill>
  );
};

const YearBadge: React.FC<{year: string; vertical: boolean}> = ({year, vertical}) => {
  const frame = useCurrentFrame();
  const o = interpolate(frame, [0, 12], [0, 1], {extrapolateRight: 'clamp'});
  return (
    <div
      style={{
        position: 'absolute',
        top: vertical ? '17%' : '6%',
        right: vertical ? undefined : '4%',
        left: vertical ? 0 : undefined,
        width: vertical ? '100%' : undefined,
        textAlign: 'center',
        opacity: o,
      }}
    >
      <span
        style={{
          fontFamily: theme.serif,
          fontWeight: 700,
          fontSize: vertical ? 64 : 56,
          color: theme.accent,
          letterSpacing: 4,
          padding: '8px 28px',
          border: `3px solid ${theme.accent}`,
          borderRadius: 8,
          background: 'rgba(13,27,42,0.7)',
        }}
      >
        {year}
      </span>
    </div>
  );
};

export const Episode: React.FC<EpisodeT> = (ep) => {
  const frame = useCurrentFrame();
  const {width, height} = useVideoConfig();
  const vertical = height > width;
  const scenes = timeline(ep);
  const current = scenes.find((s) => frame >= s.from && frame < s.from + s.frames);
  const showHook = vertical && ep.hook && !current?.title;

  return (
    <AbsoluteFill style={{backgroundColor: theme.ocean}}>
      <WorldMap frame={frame} scenes={scenes} width={width} height={height} />

      {/* Vignette */}
      <AbsoluteFill
        style={{
          background:
            'radial-gradient(ellipse at center, rgba(0,0,0,0) 55%, rgba(0,0,0,0.55) 100%)',
        }}
      />

      {showHook && (
        <div
          style={{
            position: 'absolute',
            top: '6%',
            left: '5%',
            right: '5%',
            textAlign: 'center',
            fontFamily: theme.sans,
            fontWeight: 800,
            fontSize: 58,
            lineHeight: 1.15,
            color: '#fff',
            textShadow: '0 4px 16px rgba(0,0,0,0.9)',
          }}
        >
          {ep.hook}
        </div>
      )}

      {scenes.map((s) => (
        <Sequence key={s.id} from={s.from} durationInFrames={s.frames}>
          {s.audio && <Audio src={staticFile(s.audio)} />}
          {s.title && <TitleCard text={s.title} vertical={vertical} />}
          {s.year && <YearBadge year={s.year} vertical={vertical} />}
          <Captions scene={s} vertical={vertical} />
        </Sequence>
      ))}

      {ep.music && <Audio src={staticFile(ep.music)} volume={ep.musicVolume ?? 0.12} loop />}
    </AbsoluteFill>
  );
};
