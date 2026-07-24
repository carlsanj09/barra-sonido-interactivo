(() => {
  // ---------- Tunable constants ----------
  const TOLERANCE_CENTS = 50;     // full scale of the ruler, ±50 cents (half a semitone)
  const IN_TUNE_CENTS = 10;       // within this many cents counts as "hit" -> bar changes color
  const RMS_GATE_BASE = 0.02;     // base minimum input level to attempt pitch detection
  const CLARITY_GATE = 0.5;       // minimum autocorrelation clarity to trust a pitch reading
  const MIN_FREQ = 70;            // lowest voice frequency we try to track (Hz)
  const MAX_FREQ = 1200;          // highest voice frequency we try to track (Hz)
  const RESULT_FLASH_MS = 2500;   // how long the success/fail full-screen flash stays up
  const PARTIAL_SUCCESS_RATIO = 0.6; // breaking the streak past this fraction of the held
                                      // duration (but before 100%) resets silently instead
                                      // of flashing red — only a short-lived attempt fails.

  // The 12 notes of the chromatic scale in octave 4, expressed as semitone
  // offsets from A4 (440Hz) so the frequency follows the standard equal
  // temperament formula: freq = 440 * 2^(n/12).
  const NOTE_DEFS = [
    { label: 'Do', n: -9 },
    { label: 'Do#', n: -8 },
    { label: 'Re', n: -7 },
    { label: 'Re#', n: -6 },
    { label: 'Mi', n: -5 },
    { label: 'Fa', n: -4 },
    { label: 'Fa#', n: -3 },
    { label: 'Sol', n: -2 },
    { label: 'Sol#', n: -1 },
    { label: 'La', n: 0 },
    { label: 'La#', n: 1 },
    { label: 'Si', n: 2 },
  ];
  const noteFreq = (n) => 440 * Math.pow(2, n / 12);

  const stage = document.getElementById('stage');
  const chromaBg = document.getElementById('chromaBg');
  const canvas = document.getElementById('tunerCanvas');
  const ctx = canvas.getContext('2d');
  const micBtn = document.getElementById('micBtn');
  const statusEl = document.getElementById('status');
  const bgColorInput = document.getElementById('bgColor');
  const barColorInput = document.getElementById('barColor');
  const bgResetBtn = document.getElementById('bgReset');
  const barResetBtn = document.getElementById('barReset');
  const sensitivityInput = document.getElementById('sensitivity');
  const noteSelect = document.getElementById('noteSelect');
  const noteFreqLabel = document.getElementById('noteFreqLabel');
  const holdDurationInput = document.getElementById('holdDuration');
  const holdDurationValueLabel = document.getElementById('holdDurationValue');
  const resetTestBtn = document.getElementById('resetTest');
  const toggleControlsBtn = document.getElementById('toggleControls');
  const controlsPanel = document.getElementById('controlsPanel');

  const DEFAULT_BG = '#00ff47';
  const DEFAULT_BAR = '#ff2fd0';

  // ---------- Note selector ----------
  NOTE_DEFS.forEach((note, i) => {
    const opt = document.createElement('option');
    opt.value = note.n;
    opt.textContent = note.label;
    if (note.n === 0) opt.selected = true; // default to La (A4, 440Hz)
    noteSelect.appendChild(opt);
  });
  let targetFreq = noteFreq(0);
  function updateNoteFreqLabel() {
    noteFreqLabel.textContent = targetFreq.toFixed(2) + ' Hz';
  }
  updateNoteFreqLabel();
  noteSelect.addEventListener('change', () => {
    targetFreq = noteFreq(parseInt(noteSelect.value, 10));
    updateNoteFreqLabel();
    resetTest();
  });

  // ---------- Hold duration ----------
  let holdDurationMs = parseFloat(holdDurationInput.value) * 1000;
  holdDurationInput.addEventListener('input', () => {
    holdDurationValueLabel.textContent = holdDurationInput.value;
    holdDurationMs = parseFloat(holdDurationInput.value) * 1000;
    resetTest();
  });

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

  // ---------- Test state ----------
  // 'idle' -> tracking live pitch; 'success'/'fail' -> showing the result
  // flash, frozen until it auto-clears (or the user hits reset).
  let testState = 'idle';
  let testEndAt = null;
  let holdStreakStart = null;
  let smoothedCents = 0;
  let hasReading = false;

  function resetTest() {
    testState = 'idle';
    testEndAt = null;
    holdStreakStart = null;
  }
  resetTestBtn.addEventListener('click', resetTest);

  // ---------- Controls visibility toggle ----------
  toggleControlsBtn.addEventListener('click', () => {
    const hidden = controlsPanel.classList.toggle('hidden');
    toggleControlsBtn.classList.toggle('active', !hidden);
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

  // ---------- Pitch detection (autocorrelation over the plausible voice range) ----------
  // Plain "pick the global max correlation" autocorrelation is octave-
  // ambiguous: for a periodic signal, correlation at 2x/3x the true period is
  // nearly as strong as at the true period, and tiny numerical noise decides
  // which one wins. The fix is to only consider actual local peaks in the
  // correlation curve, then take the smallest-lag peak that's close to the
  // global best — that's the fundamental, not a sub-harmonic of it.
  const PEAK_RATIO = 0.9;

  function detectPitch(buf, sampleRate, rmsGate) {
    const SIZE = buf.length;
    let rms = 0;
    for (let i = 0; i < SIZE; i++) rms += buf[i] * buf[i];
    rms = Math.sqrt(rms / SIZE);
    if (rms < rmsGate) return null;

    const minLag = Math.floor(sampleRate / MAX_FREQ);
    const maxLag = Math.min(SIZE - 2, Math.ceil(sampleRate / MIN_FREQ));

    const corrs = new Float64Array(maxLag + 2);
    for (let lag = minLag; lag <= maxLag; lag++) {
      let c = 0;
      const n = SIZE - lag;
      for (let i = 0; i < n; i++) c += buf[i] * buf[i + lag];
      corrs[lag] = c / n;
    }

    let globalMax = 0;
    for (let lag = minLag; lag <= maxLag; lag++) {
      if (corrs[lag] > globalMax) globalMax = corrs[lag];
    }
    if (globalMax <= 0) return null;

    let bestLag = -1;
    for (let lag = minLag + 1; lag < maxLag; lag++) {
      const isPeak = corrs[lag] >= corrs[lag - 1] && corrs[lag] >= corrs[lag + 1];
      if (isPeak && corrs[lag] >= globalMax * PEAK_RATIO) {
        bestLag = lag;
        break;
      }
    }
    if (bestLag <= 0) return null;

    let energy = 0;
    for (let i = 0; i < SIZE; i++) energy += buf[i] * buf[i];
    energy /= SIZE;
    const clarity = corrs[bestLag] / (energy || 1e-9);
    if (clarity < CLARITY_GATE) return null;

    // Parabolic interpolation around the best lag for sub-sample precision.
    const c0 = corrs[bestLag - 1];
    const c1 = corrs[bestLag];
    const c2 = corrs[bestLag + 1];
    const denom = c0 - 2 * c1 + c2;
    const shift = denom ? 0.5 * (c0 - c2) / denom : 0;
    const refinedLag = bestLag + Math.max(-1, Math.min(1, shift));

    return sampleRate / refinedLag;
  }

  // ---------- Drawing ----------
  function draw(now) {
    const rect = stage.getBoundingClientRect();
    const W = rect.width;
    const H = rect.height;
    ctx.clearRect(0, 0, W, H);

    const centerY = H * 0.5;
    const rangeTop = H * 0.15;
    const rangeSpan = centerY - rangeTop; // px per TOLERANCE_CENTS
    const barX = W * 0.4;
    const barWidth = Math.max(28, W * 0.14);
    const rulerX = W * 0.62;

    const inTune = hasReading && Math.abs(smoothedCents) <= IN_TUNE_CENTS;
    const barColor = getComputedStyle(document.documentElement).getPropertyValue('--bar-color').trim() || DEFAULT_BAR;
    const successColor = '#ffd93d';

    // Ruler: ticks every 10 cents, numbered, 0 in the middle.
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.font = '600 12px "Segoe UI", sans-serif';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 2;
    for (let v = -TOLERANCE_CENTS; v <= TOLERANCE_CENTS; v += 10) {
      const y = centerY - (v / TOLERANCE_CENTS) * rangeSpan;
      const tickLen = v === 0 ? 22 : 12;
      ctx.beginPath();
      ctx.moveTo(rulerX, y);
      ctx.lineTo(rulerX + tickLen, y);
      ctx.stroke();
      const label = v > 0 ? `+${v}` : `${v}`;
      ctx.fillText(label, rulerX + tickLen + 6, y);
    }
    // Vertical spine of the ruler.
    ctx.beginPath();
    ctx.moveTo(rulerX, rangeTop);
    ctx.lineTo(rulerX, centerY + rangeSpan);
    ctx.stroke();

    // Center dashed guide line spanning bar + ruler.
    ctx.save();
    ctx.setLineDash([4, 6]);
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.beginPath();
    ctx.moveTo(barX - barWidth * 0.6, centerY);
    ctx.lineTo(rulerX, centerY);
    ctx.stroke();
    ctx.restore();

    // The bar itself: grows up from center when sharp, down when flat. A
    // minimum thickness is enforced so a dead-on match (deviation ~0) still
    // renders as a visible marker instead of shrinking to nothing.
    const displayCents = Math.max(-TOLERANCE_CENTS, Math.min(TOLERANCE_CENTS, hasReading ? smoothedCents : 0));
    let signedHeight = (displayCents / TOLERANCE_CENTS) * rangeSpan;
    const MIN_BAR_HEIGHT = 10;
    if (Math.abs(signedHeight) < MIN_BAR_HEIGHT) {
      signedHeight = signedHeight >= 0 ? MIN_BAR_HEIGHT : -MIN_BAR_HEIGHT;
    }
    const top = signedHeight >= 0 ? centerY - signedHeight : centerY;
    const height = Math.abs(signedHeight);
    const fillColor = inTune ? successColor : barColor;
    const grad = ctx.createLinearGradient(0, top, 0, top + height);
    grad.addColorStop(0, fillColor);
    grad.addColorStop(1, `color-mix(in srgb, ${fillColor} 55%, #000)`);
    ctx.fillStyle = grad;
    const radius = Math.min(10, barWidth / 2);
    ctx.beginPath();
    ctx.roundRect(barX - barWidth / 2, top, barWidth, height, radius);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    if (inTune) {
      ctx.save();
      ctx.shadowColor = successColor;
      ctx.shadowBlur = 22;
      ctx.beginPath();
      ctx.roundRect(barX - barWidth / 2, top, barWidth, height, radius);
      ctx.fill();
      ctx.restore();
    }

    // Readout text: detected frequency / cents, or "sin señal".
    ctx.textAlign = 'center';
    ctx.font = '600 13px "Segoe UI", sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    const readoutY = rangeTop - 24;
    if (hasReading) {
      const sign = smoothedCents >= 0 ? '+' : '';
      ctx.fillText(`${sign}${smoothedCents.toFixed(0)} cents`, (barX + rulerX) / 2, readoutY);
    } else {
      ctx.fillText('Sin señal — canta o silba la nota', (barX + rulerX) / 2, readoutY);
    }
    ctx.textAlign = 'start';

    // Ripple effect: only while a hold streak is active, intensifying from
    // faint/slow at 1s up to fast/dense right before the required duration.
    if (holdStreakStart !== null) {
      const heldMs = now - holdStreakStart;
      const rampStart = 1000;
      if (heldMs >= rampStart) {
        const progress = Math.max(0, Math.min(1, (heldMs - rampStart) / Math.max(1, holdDurationMs - rampStart)));
        const ringCount = 1 + Math.floor(progress * 5);
        const period = 1400 - progress * 900;
        const maxRadius = Math.min(W, H) * 0.42;
        const cx = W / 2;
        const cy = H / 2;
        ctx.save();
        for (let i = 0; i < ringCount; i++) {
          const phase = ((now / period) + i / ringCount) % 1;
          const jitter = Math.sin(now * 0.02 + i * 2) * progress * 6;
          const r = phase * maxRadius + jitter;
          const alpha = (1 - phase) * (0.15 + progress * 0.35);
          ctx.strokeStyle = `rgba(255,255,255,${alpha})`;
          ctx.lineWidth = 2 + progress * 2;
          ctx.beginPath();
          ctx.arc(cx, cy, Math.max(0, r), 0, Math.PI * 2);
          ctx.stroke();
        }
        ctx.restore();
      }
    }

    // Result flash: full-screen pulse, white for success, red for fail.
    if (testState === 'success' || testState === 'fail') {
      const elapsed = RESULT_FLASH_MS - Math.max(0, testEndAt - now);
      const t = Math.max(0, Math.min(1, elapsed / RESULT_FLASH_MS));
      const alpha = Math.sin(t * Math.PI) * 0.7;
      ctx.fillStyle = testState === 'success' ? `rgba(255,255,255,${alpha})` : `rgba(255,40,40,${alpha})`;
      ctx.fillRect(0, 0, W, H);
      ctx.textAlign = 'center';
      ctx.font = '700 22px "Segoe UI", sans-serif';
      ctx.fillStyle = testState === 'success' ? 'rgba(20,20,20,0.85)' : 'rgba(255,255,255,0.9)';
      ctx.fillText(testState === 'success' ? '¡Nota afinada!' : 'Intento fallido', W / 2, H / 2);
      ctx.textAlign = 'start';
    }
  }

  // ---------- Audio ----------
  let audioCtx, analyser, timeBuf, source;
  let running = false;

  async function startMic() {
    if (!window.isSecureContext) {
      statusEl.textContent = 'El micrófono requiere HTTPS (o localhost). Abre el sitio publicado, no el archivo local.';
      return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      statusEl.textContent = 'Este navegador/contexto no expone getUserMedia (¿estás dentro de un iframe con permisos restringidos?).';
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 2048;
      timeBuf = new Float32Array(analyser.fftSize);
      source = audioCtx.createMediaStreamSource(stream);
      source.connect(analyser);

      running = true;
      micBtn.textContent = '⏸ Detener micrófono';
      micBtn.classList.add('on');
      statusEl.textContent = 'Escuchando…';
      resetTest();
      requestAnimationFrame(loop);
    } catch (err) {
      const reasons = {
        NotAllowedError: 'Permiso denegado. Revisa el ícono de candado/micrófono en la barra de direcciones y permite el acceso para este sitio.',
        NotFoundError: 'No se detectó ningún micrófono conectado.',
        NotReadableError: 'El micrófono está siendo usado por otra aplicación y no se pudo abrir.',
        SecurityError: 'El navegador bloqueó el acceso por política de seguridad (permisos restringidos en este contexto).',
        AbortError: 'La solicitud de micrófono fue interrumpida. Intenta de nuevo.',
      };
      statusEl.textContent = reasons[err.name] || `Error al acceder al micrófono (${err.name}): ${err.message}`;
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
    hasReading = false;
    resetTest();
  }

  micBtn.addEventListener('click', () => {
    if (!running) startMic();
    else stopMic();
  });

  function loop() {
    if (!running) return;
    analyser.getFloatTimeDomainData(timeBuf);

    const sensitivity = parseFloat(sensitivityInput.value);
    const rmsGate = RMS_GATE_BASE / sensitivity;
    const now = performance.now();

    const pitch = detectPitch(timeBuf, audioCtx.sampleRate, rmsGate);
    if (pitch) {
      const cents = 1200 * Math.log2(pitch / targetFreq);
      smoothedCents = hasReading ? smoothedCents + (cents - smoothedCents) * 0.35 : cents;
      hasReading = true;
    } else {
      hasReading = false;
    }

    const inTune = hasReading && Math.abs(smoothedCents) <= IN_TUNE_CENTS;

    if (testState === 'idle') {
      if (inTune) {
        if (holdStreakStart === null) holdStreakStart = now;
        const heldMs = now - holdStreakStart;
        if (heldMs >= holdDurationMs) {
          testState = 'success';
          testEndAt = now + RESULT_FLASH_MS;
          holdStreakStart = null;
        }
      } else if (holdStreakStart !== null) {
        const heldMs = now - holdStreakStart;
        const failThresholdMs = holdDurationMs * PARTIAL_SUCCESS_RATIO;
        if (heldMs < failThresholdMs) {
          testState = 'fail';
          testEndAt = now + RESULT_FLASH_MS;
        }
        holdStreakStart = null;
      }
    } else if (now >= testEndAt) {
      testState = 'idle';
      testEndAt = null;
    }

    draw(now);
    requestAnimationFrame(loop);
  }

  // Keep the ruler/bar visible (idle readout) even before the mic starts.
  function idleDraw() {
    if (!running) {
      draw(performance.now());
    }
    requestAnimationFrame(idleDraw);
  }
  requestAnimationFrame(idleDraw);
})();
