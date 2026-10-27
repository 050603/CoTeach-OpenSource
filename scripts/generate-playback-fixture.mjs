import { writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

// Original regression media: geometry drawn by this script and a synthesized
// tone. No source image, recording, font, textbook or external media is used.
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  const bytes = await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 320; canvas.height = 180;
    const context = canvas.getContext('2d');
    const audio = new AudioContext();
    await audio.resume();
    const destination = audio.createMediaStreamDestination();
    const oscillator = audio.createOscillator();
    const gain = audio.createGain();
    oscillator.frequency.value = 330;
    gain.gain.value = 0.02;
    oscillator.connect(gain).connect(destination);
    const stream = canvas.captureStream(12);
    destination.stream.getAudioTracks().forEach(track => stream.addTrack(track));
    const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8,opus' });
    const chunks = [];
    recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
    const stopped = new Promise(resolve => { recorder.onstop = resolve; });
    recorder.start(); oscillator.start();
    for (let frame = 0; frame < 36; frame += 1) {
      context.fillStyle = '#14263d'; context.fillRect(0, 0, 320, 180);
      context.fillStyle = '#7dd3fc'; context.fillRect(20 + frame * 6, 65, 52, 52);
      context.fillStyle = '#fbbf24'; context.beginPath(); context.arc(260, 35, 16, 0, Math.PI * 2); context.fill();
      await new Promise(resolve => setTimeout(resolve, 1000 / 12));
    }
    recorder.stop(); await stopped;
    oscillator.stop(); stream.getTracks().forEach(track => track.stop()); await audio.close();
    const blob = new Blob(chunks, { type: 'video/webm' });
    const video = document.createElement('video');
    video.muted = true;
    document.body.append(video);
    const url = URL.createObjectURL(blob);
    try {
      const metadata = new Promise((resolve, reject) => {
        video.onloadedmetadata = resolve;
        video.onerror = () => reject(new Error('Generated fixture cannot be decoded.'));
      });
      video.src = url;
      await Promise.race([metadata, new Promise((_, reject) => setTimeout(() => reject(new Error('Fixture metadata timed out.')), 10_000))]);
      if (video.videoWidth !== 320 || video.videoHeight !== 180) throw new Error('Unexpected fixture dimensions.');
      const ended = new Promise(resolve => { video.onended = resolve; });
      await video.play();
      await new Promise(resolve => setTimeout(resolve, 400));
      if (video.currentTime <= 0.05) throw new Error('Generated fixture did not advance playback.');
      await Promise.race([ended, new Promise((_, reject) => setTimeout(() => reject(new Error('Fixture playback did not end.')), 10_000))]);
      if (video.getVideoPlaybackQuality().totalVideoFrames < 20) throw new Error('Insufficient decoded frames.');
    } finally {
      video.remove();
      URL.revokeObjectURL(url);
    }
    return [...new Uint8Array(await blob.arrayBuffer())];
  });
  const result = Buffer.from(bytes);
  await writeFile(new URL('../e2e/fixtures/prelaunch-video.webm', import.meta.url), result);
  console.log(`Generated and browser-verified synthetic playback fixture (${result.length} bytes).`);
} finally {
  await browser.close();
}
