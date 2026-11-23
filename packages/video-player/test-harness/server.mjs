/**
 * Static fixture server for the source-switch harness.
 *
 * Serves the built bundle, the harness page/driver and deterministic media. Request
 * timing is fully controlled inside the page (see fixture-driver.mjs), so the server
 * itself is deliberately dumb and fast.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLAYER_HTML } from './fixture-page.mjs';
import { DRIVER_JS } from './fixture-driver.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.wav': 'audio/wav',
  '.vtt': 'text/vtt; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

/**
 * Deterministic PCM WAV (mono, 8 kHz, 12 s). Generated in memory so the harness has
 * no binary fixtures to keep in sync; the three clips differ only by tone frequency,
 * which is enough for the player to load a real, seekable media resource.
 */
function makeWav(freqHz, seconds = 12, rate = 8000) {
  const samples = rate * seconds;
  const dataSize = samples * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);       // fmt chunk size
  buf.writeUInt16LE(1, 20);        // PCM
  buf.writeUInt16LE(1, 22);        // mono
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32);        // block align
  buf.writeUInt16LE(16, 34);       // bits per sample
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < samples; i++) {
    buf.writeInt16LE(Math.round(3000 * Math.sin((2 * Math.PI * freqHz * i) / rate)), 44 + i * 2);
  }
  return buf;
}

const WAVS = {
  'clipA.wav': makeWav(440),
  'clipB.wav': makeWav(523),
  'clipC.wav': makeWav(660),
};

export async function startFixtureServer({ pkgRoot }) {
  const readBundle = (relPath) => {
    const file = path.join(pkgRoot, relPath);
    return fs.existsSync(file) ? fs.readFileSync(file) : null;
  };

  const svg = (text, color) => `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="90">
  <rect width="160" height="90" fill="${color}"/>
  <text x="80" y="52" font-family="sans-serif" font-size="16" fill="#fff" text-anchor="middle">${text}</text>
</svg>`;

  const vtt = (cues) =>
    'WEBVTT\n\n' + cues.map((c, i) =>
      `${i + 1}\n${c.start} --> ${c.end}\n${c.text}\n`).join('\n');

  // The chapter parser reads the label from the line right after the timing line
  // (no cue identifier), so chapter fixtures are written that way.
  const chapterVtt = (cues) =>
    'WEBVTT\n\n' + cues.map((c) =>
      `${c.start} --> ${c.end}\n${c.text}\n`).join('\n');

  const CLIPS = {
    clipA: { color: '#7a2f2f' },
    clipB: { color: '#2f5f7a' },
    clipC: { color: '#3f7a2f' },
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const send = (status, type, body) => {
      res.writeHead(status, {
        'Content-Type': type,
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(body);
    };

    if (url.pathname === '/' || url.pathname === '/harness.html') {
      return send(200, MIME['.html'], PLAYER_HTML);
    }
    if (url.pathname === '/fixture-driver.js') {
      return send(200, MIME['.js'], DRIVER_JS);
    }
    if (url.pathname === '/dist/index.global.js') {
      const body = readBundle(path.join('dist', 'index.global.js'));
      return body ? send(200, MIME['.js'], body) : send(404, 'text/plain', 'run the package build first');
    }
    if (url.pathname === '/styles.css') {
      const body = readBundle(path.join('dist', 'styles.css'));
      return body ? send(200, MIME['.css'], body) : send(404, 'text/plain', 'run the package build first');
    }

    // Poster images: <clip>.wav/ik-thumbnail.jpg
    const posterMatch = /^\/media\/(clip[ABC])\.wav\/ik-thumbnail\.jpg$/.exec(url.pathname);
    if (posterMatch) {
      return send(200, 'image/svg+xml', svg(`poster ${posterMatch[1]}`, CLIPS[posterMatch[1]].color));
    }

    // Seek-thumbnail track: <clip>.wav/ik-seek-thumbnail-track.vtt
    const seekMatch = /^\/media\/(clip[ABC])\.wav\/ik-seek-thumbnail-track\.vtt$/.exec(url.pathname);
    if (seekMatch) {
      const clip = seekMatch[1];
      const origin = `http://${req.headers.host}`;
      const body = vtt([
        { start: '00:00:00.000', end: '00:00:06.000', text: `${origin}/img/sprite-${clip}.svg#xywh=0,0,160,90` },
        { start: '00:00:06.000', end: '00:00:12.000', text: `${origin}/img/sprite-${clip}.svg#xywh=160,0,160,90` },
      ]);
      return send(200, MIME['.vtt'], body);
    }

    // Subtitles: /subs/<clip>.vtt
    const subMatch = /^\/subs\/(clip[ABC])\.vtt$/.exec(url.pathname);
    if (subMatch) {
      const body = vtt([
        { start: '00:00:00.000', end: '00:00:12.000', text: `subtitle ${subMatch[1]}` },
      ]);
      return send(200, MIME['.vtt'], body);
    }

    // Auto-generated subtitles: <clip>.wav/ik-gensubtitle.transcript
    const transcriptMatch = /^\/media\/(clip[ABC])\.wav\/ik-gensubtitle\.transcript$/.exec(url.pathname);
    if (transcriptMatch) {
      const clip = transcriptMatch[1];
      const body = JSON.stringify({
        languageCode: 'en',
        transcript: [{
          transcript: `auto subtitle ${clip}`,
          words: [
            { word: 'auto', start: 0.5, end: 1.0 },
            { word: 'subtitle', start: 1.0, end: 1.6 },
            { word: clip, start: 1.6, end: 2.4 },
          ],
        }],
      });
      return send(200, MIME['.json'], body);
    }

    // Chapters: /chapters/<clip>.vtt
    const chapMatch = /^\/chapters\/(clip[ABC])\.vtt$/.exec(url.pathname);
    if (chapMatch) {
      const clip = chapMatch[1];
      const body = chapterVtt([
        { start: '00:00:00.000', end: '00:00:06.000', text: `chapter ${clip} one` },
        { start: '00:00:06.000', end: '00:00:12.000', text: `chapter ${clip} two` },
      ]);
      return send(200, MIME['.vtt'], body);
    }

    const spriteMatch = /^\/img\/sprite-(clip[ABC])\.svg$/.exec(url.pathname);
    if (spriteMatch) {
      return send(200, 'image/svg+xml', svg(`sprite ${spriteMatch[1]}`, CLIPS[spriteMatch[1]].color));
    }

    if (url.pathname.startsWith('/media/')) {
      const wav = WAVS[path.basename(url.pathname)];
      if (!wav) return send(404, 'text/plain', 'missing media');
      // Range support keeps the media element happy.
      const range = req.headers.range;
      const type = MIME['.wav'];
      if (range) {
        const m = /bytes=(\d*)-(\d*)/.exec(range);
        const start = m[1] ? parseInt(m[1], 10) : 0;
        const end = m[2] ? parseInt(m[2], 10) : wav.length - 1;
        res.writeHead(206, {
          'Content-Type': type,
          'Content-Range': `bytes ${start}-${end}/${wav.length}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': end - start + 1,
          'Cache-Control': 'no-store',
          'Access-Control-Allow-Origin': '*',
        });
        return res.end(wav.subarray(start, end + 1));
      }
      res.writeHead(200, {
        'Content-Type': type,
        'Content-Length': wav.length,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
      });
      return res.end(wav);
    }
    return send(404, 'text/plain', 'not found: ' + url.pathname);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
