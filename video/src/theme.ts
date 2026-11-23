import {continueRender, delayRender, staticFile} from 'remotion';

export const theme = {
  ocean: '#0d1b2a',
  graticule: 'rgba(160, 190, 220, 0.07)',
  land: '#2b3a4e',
  border: '#425570',
  text: '#f3ead7',
  accent: '#e8b04b',
  arrow: '#f3ead7',
  serif: 'Cardo, Georgia, serif',
  sans: 'Montserrat, Arial, sans-serif',
};

// Load the bundled fonts before the first frame renders so every machine
// (yours, a server, CI) produces identical text.
const fonts: [string, string, string][] = [
  ['Cardo', 'fonts/Cardo-Regular.ttf', '400'],
  ['Cardo', 'fonts/Cardo-Bold.ttf', '700'],
  ['Montserrat', 'fonts/Montserrat.ttf', '100 900'],
];

const handle = delayRender('Loading fonts');
Promise.all(
  fonts.map(([family, file, weight]) => {
    const face = new FontFace(family, `url(${staticFile(file)})`, {weight});
    return face.load().then((f) => document.fonts.add(f));
  }),
)
  .then(() => continueRender(handle))
  .catch((err) => {
    console.error('Font loading failed', err);
    continueRender(handle);
  });
