import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FfmpegFrameExtractor, ffmpegFrameArgs, resolveFfmpegPath } from '../attachmentProcessor';

const ffmpeg = resolveFfmpegPath('');

/** A short test-pattern video made by the bundled ffmpeg (no fixture files in the repo). */
async function sampleVideo(extension: 'mp4' | 'webm' | 'mov'): Promise<Uint8Array> {
  const dir = await mkdtemp(join(tmpdir(), 'frames-sample-'));
  try {
    const out = join(dir, `sample.${extension}`);
    const codec = extension === 'webm' ? ['-c:v', 'libvpx-vp9', '-deadline', 'realtime'] : ['-c:v', 'libx264', '-pix_fmt', 'yuv420p'];
    execFileSync(ffmpeg, ['-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x240:rate=10', ...codec, out]);
    return new Uint8Array(await readFile(out));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('the bundled ffmpeg is found when FFMPEG_PATH is not set; FFMPEG_PATH wins; a missing package turns frames off', () => {
  assert.ok(ffmpeg.length > 0, 'ffmpeg-static should be installed');
  assert.equal(resolveFfmpegPath('/opt/ffmpeg'), '/opt/ffmpeg');
  assert.equal(resolveFfmpegPath('', () => { throw new Error('not installed'); }), '');
  assert.equal(resolveFfmpegPath('', () => null), '');
});

test('ffmpeg arguments: forced input format, local files only, 6 frames; other types are refused', () => {
  const args = ffmpegFrameArgs('/tmp/x/input.mp4', '/tmp/x/frame%02d.jpg', 'mp4')!;
  const at = (flag: string) => args[args.indexOf(flag) + 1];
  assert.equal(at('-protocol_whitelist'), 'file');
  assert.equal(at('-f'), 'mov');
  assert.equal(at('-frames:v'), '6');
  assert.ok(args.indexOf('-f') < args.indexOf('-i'), 'the input format is forced before the input');
  assert.equal(ffmpegFrameArgs('/i', '/o', 'webm')![args.indexOf('-f') + 1], 'matroska');
  assert.equal(ffmpegFrameArgs('/i', '/o', 'mov')![args.indexOf('-f') + 1], 'mov');
  for (const other of ['m3u8', 'concat', 'txt', 'avi', 'mkv', '']) assert.equal(ffmpegFrameArgs('/i', '/o', other), undefined, other);
});

test('real videos give up to 6 small JPEG frames', async () => {
  for (const ext of ['mp4', 'mov', 'webm'] as const) {
    const frames = await new FfmpegFrameExtractor(ffmpeg).frames(await sampleVideo(ext), ext);
    assert.ok(frames.length >= 1 && frames.length <= 6, `${ext}: ${frames.length} frames`);
    for (const f of frames) assert.deepEqual([...f.subarray(0, 3)], [0xff, 0xd8, 0xff], `${ext}: JPEG`);
  }
  assert.deepEqual(await new FfmpegFrameExtractor(ffmpeg).frames(new Uint8Array([1, 2, 3]), 'avi'), []);
});

test('a playlist pretending to be a video cannot make ffmpeg open other files or the network', async () => {
  const playlist = new TextEncoder().encode('#EXTM3U\n#EXTINF:1,\nhttp://127.0.0.1:9/x.ts\nfile:///etc/passwd\n');
  await assert.rejects(new FfmpegFrameExtractor(ffmpeg).frames(playlist, 'mp4'));
  await assert.rejects(new FfmpegFrameExtractor(ffmpeg).frames(await sampleVideo('mp4'), 'webm'), 'the forced format must match the bytes');
});

test('ffmpeg that runs too long is stopped, and it gets no environment', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'frames-fake-'));
  try {
    const slow = join(dir, 'slow.sh');
    await writeFile(slow, '#!/bin/sh\nsleep 5\n');
    await chmod(slow, 0o755);
    const started = Date.now();
    await assert.rejects(new FfmpegFrameExtractor(slow, 200).frames(await sampleVideo('mp4'), 'mp4'));
    assert.ok(Date.now() - started < 3_000);

    const envDump = join(dir, 'env.sh');
    const seen = join(dir, 'env.txt');
    await writeFile(envDump, `#!/bin/sh\n/usr/bin/env > ${seen}\n`);
    await chmod(envDump, 0o755);
    process.env.SECRET_FOR_TEST = 'do-not-leak';
    try {
      await new FfmpegFrameExtractor(envDump).frames(new Uint8Array([0]), 'mp4');
    } finally {
      delete process.env.SECRET_FOR_TEST;
    }
    assert.doesNotMatch(await readFile(seen, 'utf8'), /do-not-leak/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
