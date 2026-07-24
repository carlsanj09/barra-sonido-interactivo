(() => {
  const BAR_COUNT = 28;
  const PEAK_COOLDOWN_MS = 90;   // min time between smoke bursts per bar
  const SMOKE_LIFE_MS = 9000;    // how long a smoke particle lingers before fully fading

  const stage = document.getElementById('stage');
  const chromaBg = document.getElementById('chromaBg');
  const barsContainer = document.getElementById('barsContainer');
  const canvas = document.getElementById('smokeCanvas');
  const ctx = canvas.getContext('2d');
  const micBtn = document.getElementById('micBtn');
  const statusEl = document.getElementById('status');
  const bgColorInput = document.getElementById('bgColor');
  const barColorInput = document.getElementById('barColor');
  const bgResetBtn = document.getElementById('bgReset');
  const barResetBtn = document.getElementById('barReset');
  const sensitivityInput = document.getElementById('sensitivity');
  const clearSmokeBtn = document.getElementById('clearSmoke');
  const thresholdInput = document.getElementById('threshold');
  const thresholdValueLabel = document.getElementById('thresholdValue');
  const toggleControlsBtn = document.getElementById('toggleControls');
  const controlsPanel = document.getElementById('controlsPanel');

  const DEFAULT_BG = '#00ff47';
  const DEFAULT_BAR = '#ff2fd0';

  // ---------- Bars ----------
  const bars = [];
  for (let i = 0; i < BAR_COUNT; i++) {
    const el = document.createElement('div');
    el.className = 'bar';
    barsContainer.appendChild(el);
    bars.push({
      el,
      lastPeakAt: 0,
      aboveThreshold: false,
    });
  }

  // ---------- Canvas sizing ----------
  function resizeCanvas() {
    const rect = stage.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    canvas.style.width = rect.width + 'px';
    canvas.style.height = rect.height + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  window.addEventListener('resize', resizeCanvas);
  resizeCanvas();

  // ---------- Particles (smoke) ----------
  let particles = [];

  function spawnSmoke(x, y, intensity) {
    // intensity ~ 0..1, more noise -> more particles per burst
    const count = 1 + Math.round(intensity * 4);
    for (let i = 0; i < count; i++) {
      particles.push({
        x: x + (Math.random() - 0.5) * 10,
        y,
        vx: (Math.random() - 0.5) * 0.25,
        vy: -(0.35 + Math.random() * 0.5) * (0.6 + intensity),
        radius: 6 + Math.random() * 8 * (0.5 + intensity),
        maxRadius: 22 + Math.random() * 30 * (0.5 + intensity),
        born: performance.now(),
        life: SMOKE_LIFE_MS * (0.7 + Math.random() * 0.6),
        drift: (Math.random() - 0.5) * 0.02,
        angle: Math.random() * Math.PI * 2,
      });
    }
    // safety cap so very long sessions don't blow memory
    if (particles.length > 1400) {
      particles.splice(0, particles.length - 1400);
    }
  }

  function drawSmoke(now) {
    const rect = stage.getBoundingClientRect();
    ctx.clearRect(0, 0, rect.width, rect.height);
    ctx.globalCompositeOperation = 'source-over';

    particles = particles.filter(p => (now - p.born) < p.life);

    for (const p of particles) {
      const t = (now - p.born) / p.life; // 0..1
      const ease = 1 - Math.pow(1 - t, 2);
      p.x += p.vx + Math.sin(p.angle + now * 0.001) * p.drift;
      p.y += p.vy * (1 - t * 0.5);
      p.angle += 0.01;
      const radius = p.radius + (p.maxRadius - p.radius) * ease;
      const opacity = (1 - t) * 0.5;

      const grad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, radius);
      grad.addColorStop(0, `rgba(235,235,240,${opacity})`);
      grad.addColorStop(0.5, `rgba(200,200,210,${opacity * 0.6})`);
      grad.addColorStop(1, `rgba(200,200,210,0)`);

      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  clearSmokeBtn.addEventListener('click', () => {
    particles = [];
  });

  // ---------- Controls visibility toggle ----------
  toggleControlsBtn.addEventListener('click', () => {
    const hidden = controlsPanel.classList.toggle('hidden');
    toggleControlsBtn.classList.toggle('active', !hidden);
  });

  // ---------- Threshold display ----------
  thresholdInput.addEventListener('input', () => {
    thresholdValueLabel.textContent = thresholdInput.value;
  });

  // ---------- Colors ----------
  function applyBg(hex) {
    chromaBg.style.setProperty('--chroma', hex);
    document.documentElement.style.setProperty('--chroma', hex);
  }
  function applyBarColor(hex) {
    document.documentElement.style.setProperty('--bar-color', hex);
  }

  bgColorInput.addEventListener('input', e => applyBg(e.target.value));
  barColorInput.addEventListener('input', e => applyBarColor(e.target.value));
  bgResetBtn.addEventListener('click', () => {
    bgColorInput.value = DEFAULT_BG;
    applyBg(DEFAULT_BG);
  });
  barResetBtn.addEventListener('click', () => {
    barColorInput.value = DEFAULT_BAR;
    applyBarColor(DEFAULT_BAR);
  });
  applyBg(DEFAULT_BG);
  applyBarColor(DEFAULT_BAR);

  // ---------- Audio ----------
  let audioCtx, analyser, dataArray, source;
  let running = false;

  async function startMic() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.75;
      analyser.minDecibels = -90;
      analyser.maxDecibels = -10;
      dataArray = new Uint8Array(analyser.frequencyBinCount);
      source = audioCtx.createMediaStreamSource(stream);
      source.connect(analyser);

      running = true;
      micBtn.textContent = '⏸ Detener micrófono';
      micBtn.classList.add('on');
      statusEl.textContent = 'Escuchando…';
      requestAnimationFrame(loop);
    } catch (err) {
      statusEl.textContent = 'Permiso de micrófono denegado o no disponible.';
      console.error(err);
    }
  }

  function stopMic() {
    running = false;
    if (source) source.mediaStream.getTracks().forEach(t => t.stop());
    if (audioCtx) audioCtx.close();
    micBtn.textContent = '🎤 Activar micrófono';
    micBtn.classList.remove('on');
    statusEl.textContent = 'Micrófono detenido.';
    bars.forEach(b => (b.el.style.height = '6px'));
  }

  micBtn.addEventListener('click', () => {
    if (!running) startMic();
    else stopMic();
  });

  function loop() {
    if (!running) return;
    analyser.getByteFrequencyData(dataArray);

    const sensitivity = parseFloat(sensitivityInput.value);
    const thresholdDb = parseFloat(thresholdInput.value);
    const minDb = analyser.minDecibels;
    const maxDb = analyser.maxDecibels;
    const dbRange = maxDb - minDb;
    const binCount = dataArray.length;
    const binsPerBar = Math.floor(binCount / BAR_COUNT) || 1;
    const now = performance.now();
    const stageRect = stage.getBoundingClientRect();

    for (let i = 0; i < BAR_COUNT; i++) {
      const start = i * binsPerBar;
      let sum = 0;
      for (let j = 0; j < binsPerBar; j++) sum += dataArray[start + j] || 0;
      const avg = sum / binsPerBar; // 0..255

      const bar = bars[i];
      const boosted = Math.min(255, avg * sensitivity);
      const heightPct = Math.max(2, (boosted / 255) * 100);
      bar.el.style.height = heightPct + '%';

      // Convert the raw amplitude to an approximate dB value using the
      // analyser's own scale, so the threshold the user picks means
      // something real (matches AnalyserNode.min/maxDecibels).
      const dbValue = minDb + (avg / 255) * dbRange;
      const isAbove = dbValue >= thresholdDb;

      // Smoke fires on the rising edge only (silence -> above threshold),
      // so bursts land on each transient/beat instead of a sustained cloud
      // while the sound stays loud — this is what keeps it "rhythmic".
      if (isAbove && !bar.aboveThreshold && now - bar.lastPeakAt > PEAK_COOLDOWN_MS) {
        bar.lastPeakAt = now;
        const barRect = bar.el.getBoundingClientRect();
        const x = barRect.left - stageRect.left + barRect.width / 2;
        const y = barRect.top - stageRect.top;
        const intensity = Math.min(1, Math.max(0, (dbValue - thresholdDb) / (maxDb - thresholdDb || 1)));
        spawnSmoke(x, y, intensity);
      }
      bar.aboveThreshold = isAbove;
      bar.el.classList.toggle('peak', isAbove);
    }

    drawSmoke(now);
    requestAnimationFrame(loop);
  }

  // Keep drawing smoke fade-out even when mic is stopped, so particles finish gracefully.
  function idleDraw() {
    if (!running) {
      drawSmoke(performance.now());
    }
    requestAnimationFrame(idleDraw);
  }
  requestAnimationFrame(idleDraw);
})();
