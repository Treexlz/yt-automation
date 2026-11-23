import React from 'react';
import {Composition, type CalculateMetadataFunction} from 'remotion';
import {Episode} from './Episode';
import type {Episode as EpisodeT} from './types';
import {FPS, totalFrames} from './timing';
import sample from '../../episodes/rome-never-fell.json';
import './theme';

const calculateMetadata: CalculateMetadataFunction<EpisodeT> = ({props}) => ({
  durationInFrames: totalFrames(props),
});

export const Root: React.FC = () => (
  <>
    {/* Vertical: YouTube Shorts, TikTok, Reels */}
    <Composition
      id="Short"
      component={Episode}
      width={1080}
      height={1920}
      fps={FPS}
      durationInFrames={300}
      defaultProps={sample as unknown as EpisodeT}
      calculateMetadata={calculateMetadata}
    />
    {/* Horizontal: long-form YouTube */}
    <Composition
      id="Long"
      component={Episode}
      width={1920}
      height={1080}
      fps={FPS}
      durationInFrames={300}
      defaultProps={sample as unknown as EpisodeT}
      calculateMetadata={calculateMetadata}
    />
  </>
);
