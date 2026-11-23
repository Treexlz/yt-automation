// Programmatic renderer used by the Python pipeline and web app.
//
//   node render.mjs '<json job>'
//
// Job fields:
//   mode         "video" | "still"
//   composition  "Short" | "Long"
//   props        path to a props JSON file
//   output       output path (.mp4 for video, .png/.jpg for still)
//   frame        still only: frame number
//   scale        optional output scale (e.g. 0.5 for quick previews)
//   concurrency  optional number of parallel browser tabs
//   audioDir     folder holding generated voiceovers ("audio/…" in props)
//   musicDir     folder holding background music ("music/…" in props)
//   cacheDir     where to keep the reusable webpack bundle
//
// Prints one JSON object per line: {"type":"progress",...} | {"type":"log",...}
// | {"type":"done",...} | {"type":"error",...}

import {bundle} from '@remotion/bundler';
import {ensureBrowser, renderMedia, renderStill, selectComposition} from '@remotion/renderer';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const emit = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const log = (message) => emit({type: 'log', message});

const job = JSON.parse(process.argv[2] ?? '{}');

/** Hash the source so the bundle is rebuilt only when the code changes. */
const sourceHash = () => {
  const h = createHash('sha1');
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, {withFileTypes: true}).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else h.update(p + fs.statSync(p).mtimeMs);
    }
  };
  walk(path.join(here, 'src'));
  walk(path.join(here, 'public', 'fonts'));
  h.update(fs.readFileSync(path.join(here, 'package.json')));
  return h.digest('hex').slice(0, 12);
};

const getBundle = async () => {
  const cacheRoot = job.cacheDir ?? path.join(here, '.bundle-cache');
  const dir = path.join(cacheRoot, `bundle-${sourceHash()}`);
  if (!fs.existsSync(path.join(dir, 'index.html'))) {
    log('Bundling video code (first run after a code change)…');
    fs.rmSync(cacheRoot, {recursive: true, force: true});
    fs.mkdirSync(cacheRoot, {recursive: true});
    await bundle({entryPoint: path.join(here, 'src', 'index.ts'), outDir: dir});
  }
  // Generated audio and music live outside the bundle; link them in so
  // staticFile("audio/…") and staticFile("music/…") resolve.
  for (const [name, target] of [
    ['audio', job.audioDir],
    ['music', job.musicDir],
  ]) {
    if (!target) continue;
    const link = path.join(dir, 'public', name);
    fs.mkdirSync(path.dirname(link), {recursive: true});
    fs.rmSync(link, {recursive: true, force: true});
    fs.symlinkSync(path.resolve(target), link, 'dir');
  }
  return dir;
};

const main = async () => {
  const inputProps = JSON.parse(fs.readFileSync(job.props, 'utf8'));
  const browserExecutable = process.env.REMOTION_CHROME || null;
  if (!browserExecutable) await ensureBrowser();

  const serveUrl = await getBundle();
  const composition = await selectComposition({
    serveUrl,
    id: job.composition,
    inputProps,
    browserExecutable,
  });
  fs.mkdirSync(path.dirname(path.resolve(job.output)), {recursive: true});

  if (job.mode === 'still') {
    await renderStill({
      serveUrl,
      composition,
      inputProps,
      output: job.output,
      frame: Math.min(job.frame ?? 0, composition.durationInFrames - 1),
      scale: job.scale ?? 1,
      imageFormat: job.output.endsWith('.png') ? 'png' : 'jpeg',
      browserExecutable,
    });
    emit({type: 'done', output: job.output});
    return;
  }

  let last = -1;
  await renderMedia({
    serveUrl,
    composition,
    inputProps,
    codec: 'h264',
    outputLocation: job.output,
    scale: job.scale ?? 1,
    concurrency: job.concurrency ?? null,
    browserExecutable,
    onProgress: ({progress, renderedFrames, encodedFrames, stitchStage}) => {
      const pct = Math.floor(progress * 100);
      if (pct !== last) {
        last = pct;
        emit({
          type: 'progress',
          progress,
          renderedFrames,
          encodedFrames,
          totalFrames: composition.durationInFrames,
          stage: stitchStage,
        });
      }
    },
  });
  emit({type: 'done', output: job.output, frames: composition.durationInFrames});
};

main().catch((err) => {
  emit({type: 'error', message: String(err?.stack ?? err)});
  process.exit(1);
});
