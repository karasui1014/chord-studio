/* =========================================================
 * guitartab.js — ギターコードTAB
 * ギター音源(+任意で元の楽曲)→ コード進行 + 横向きコードフォーム譜の
 * 「編集できる下書き」を作る。解析はすべてブラウザ内・外部送信なし。
 *
 * 判定はコサイン類似度によるテンプレート照合(自前実装、Meyda等の外部
 * ライブラリは使わずFFT+クロマ抽出も自前)。元の楽曲を追加した場合は
 * 相互相関で開始位置のズレを補正し、コード候補を照合してブレンドする。
 * ======================================================= */
'use strict';

(() => {

  const $ = sel => document.querySelector(sel);
  const $$ = sel => [...document.querySelectorAll(sel)];

  /* ---------- コード語彙 (7種、指定仕様どおり) ---------- */
  const QUALITIES = [
    { id: 'major', suffix: '',     label: 'メジャー', intervals: [0, 4, 7],     penalty: 0 },
    { id: 'minor', suffix: 'm',    label: 'マイナー', intervals: [0, 3, 7],     penalty: 0 },
    { id: 'seven', suffix: '7',    label: '7',        intervals: [0, 4, 7, 10], penalty: 0.035 },
    { id: 'maj7',  suffix: 'M7',   label: 'maj7',     intervals: [0, 4, 7, 11], penalty: 0.04 },
    { id: 'm7',    suffix: 'm7',   label: 'm7',       intervals: [0, 3, 7, 10], penalty: 0.035 },
    { id: 'sus4',  suffix: 'sus4', label: 'sus4',     intervals: [0, 5, 7],     penalty: 0.035 },
    { id: 'add9',  suffix: 'add9', label: 'add9',     intervals: [0, 4, 7, 2],  penalty: 0.055 },
  ];
  const NOTE_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
  const NOTE_USES_FLAT = [false, false, false, true, false, false, false, false, true, false, true, false];

  function chordName(rootPc, qualityId) {
    const q = QUALITIES.find(x => x.id === qualityId) || QUALITIES[0];
    return NOTE_NAMES[rootPc] + q.suffix;
  }
  function parseChordName(name) {
    if (!name || name === 'N.C.') return null;
    const root = [...NOTE_NAMES].sort((a, b) => b.length - a.length).find(n => name.startsWith(n));
    if (!root) return null;
    const suf = name.slice(root.length);
    const q = QUALITIES.find(x => x.suffix === suf) || QUALITIES[0];
    return { rootPc: NOTE_NAMES.indexOf(root), qualityId: q.id };
  }

  /* ---------- 状態 ---------- */
  const st = {
    file: null, audioBuffer: null, audioUrl: null,
    refFile: null, refBuffer: null, refUrl: null, refOffset: 0,
    bpm: 120, beatsPerBar: 4, slotBeats: 1,
    segs: [],           // {start,end,bar,beat,name,candidates,confidence,edited,isSilent}
    selected: -1,
    capoSuggested: 0, capoMode: false, capo: 0,
    playRAF: null,
  };

  document.addEventListener('DOMContentLoaded', () => {
    $$('.mode-btn').forEach(btn => btn.addEventListener('click', () => {
      $$('.mode-btn').forEach(b => b.classList.toggle('active', b === btn));
      document.body.classList.toggle('mode-gtab', btn.dataset.mode === 'gtab');
    }));

    setupDrop($('#gtabCard'), files => {
      const f = files.find(f => isAudioFile(f));
      if (f) loadGuitarFile(f); else showErr('MP3・M4A・WAV形式の音声ファイルを選んでください。');
    });
    $('#gtabAudio').addEventListener('change', e => { if (e.target.files[0]) loadGuitarFile(e.target.files[0]); });

    setupDrop($('#gtabRefCard'), files => {
      const f = files.find(f => isAudioFile(f));
      if (f) loadRefFile(f); else showErr('元の楽曲もMP3・M4A・WAV形式を選んでください。');
    });
    $('#gtabRefAudio').addEventListener('change', e => { if (e.target.files[0]) loadRefFile(e.target.files[0]); });
    $('#gtabRefRemove').addEventListener('click', removeRefFile);

    $('#gtabBpmMode').addEventListener('change', () => {
      $('#gtabBpmValue').disabled = $('#gtabBpmMode').value !== 'manual';
    });
    $('#gtabAnalyze').addEventListener('click', analyze);
    $('#gtabPrint').addEventListener('click', () => window.print());
    $('#gtabSaveJson').addEventListener('click', saveJson);
    $('#gtabImport').addEventListener('change', importJson);
    $('#gtabCapoToggle').addEventListener('click', toggleCapo);
    $('#gtabPlayToggle').addEventListener('click', togglePlay);
    $('#gtabTimeline').addEventListener('click', e => {
      const audio = $('#gtabAudioEl');
      if (!audio || !audio.duration) return;
      const r = $('#gtabTimeline').getBoundingClientRect();
      audio.currentTime = (e.clientX - r.left) / r.width * audio.duration;
    });
    document.addEventListener('keydown', e => {
      if (e.code !== 'Space' || e.repeat) return;
      if (!document.body.classList.contains('mode-gtab') || !st.file) return;
      const tag = document.activeElement.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      e.preventDefault();
      togglePlay();
    });
  });

  function isAudioFile(f) {
    const ext = (f.name.split('.').pop() || '').toLowerCase();
    return f.type.startsWith('audio/') || ['mp3', 'm4a', 'wav', 'aac', 'ogg', 'flac'].includes(ext);
  }
  function setupDrop(card, cb) {
    ['dragover', 'dragenter'].forEach(ev => card.addEventListener(ev, e => { e.preventDefault(); card.classList.add('dragover'); }));
    ['dragleave', 'drop'].forEach(ev => card.addEventListener(ev, e => { e.preventDefault(); card.classList.remove('dragover'); }));
    card.addEventListener('drop', e => { const files = [...e.dataTransfer.files]; if (files.length) cb(files); });
  }
  function showErr(msg) {
    const el = $('#gtabError');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(st.errTimer);
    st.errTimer = setTimeout(() => { el.hidden = true; }, 7000);
  }
  function clearErr() { $('#gtabError').hidden = true; }

  /* ==================== ファイル読込 ==================== */
  async function decodeFile(file) {
    const buf = await file.arrayBuffer();
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    try { return await ctx.decodeAudioData(buf.slice(0)); } finally { ctx.close(); }
  }

  async function loadGuitarFile(file) {
    clearErr();
    try {
      const buf = await decodeFile(file);
      if (st.audioUrl) URL.revokeObjectURL(st.audioUrl);
      st.file = file; st.audioBuffer = buf; st.audioUrl = URL.createObjectURL(file);
      st.segs = []; st.selected = -1; st.capoMode = false; st.capo = 0;
      $('#gtabFileName').textContent = `✔ ${file.name} ・ ${fmtTime(buf.duration)}`;
      $('#gtabAnalyze').disabled = false;
      $('#gtabResult').hidden = true;
      drawWaveform();
      updateRefStatus();
    } catch (err) {
      console.error(err);
      showErr('この音声を読み込めませんでした。MP3またはWAVでお試しください。');
    }
  }

  async function loadRefFile(file) {
    clearErr();
    try {
      const buf = await decodeFile(file);
      if (st.refUrl) URL.revokeObjectURL(st.refUrl);
      st.refFile = file; st.refBuffer = buf; st.refUrl = URL.createObjectURL(file); st.refOffset = 0;
      st.segs = []; st.selected = -1;
      $('#gtabRefName').textContent = `✔ ${file.name} ・ ${fmtTime(buf.duration)}`;
      $('#gtabRefRemove').hidden = false;
      $('#gtabResult').hidden = true;
      updateRefStatus();
    } catch (err) {
      console.error(err);
      showErr('元の楽曲を読み込めませんでした。MP3またはWAVでお試しください。');
    }
  }

  function removeRefFile() {
    if (st.refUrl) URL.revokeObjectURL(st.refUrl);
    st.refFile = null; st.refBuffer = null; st.refUrl = null; st.refOffset = 0;
    $('#gtabRefAudio').value = '';
    $('#gtabRefName').textContent = '';
    $('#gtabRefRemove').hidden = true;
    updateRefStatus();
  }

  function updateRefStatus() {
    const el = $('#gtabRefStatus');
    if (!st.refBuffer) { el.textContent = 'ギター音源だけでも解析できます。'; return; }
    if (!st.audioBuffer) { el.textContent = `${fmtTime(st.refBuffer.duration)}・ギター音源を追加すると照合できます。`; return; }
    el.textContent = `${fmtTime(st.refBuffer.duration)}・照合の準備ができました。`;
  }

  /* ==================== モノラル化・波形 ==================== */
  function toMono(buf) {
    if (buf.numberOfChannels === 1) return buf.getChannelData(0);
    const out = new Float32Array(buf.length);
    for (let ch = 0; ch < buf.numberOfChannels; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < d.length; i++) out[i] += d[i] / buf.numberOfChannels;
    }
    return out;
  }

  function drawWaveform() {
    const canvas = $('#gtabWaveform');
    const w = canvas.clientWidth || 800, h = canvas.clientHeight || 90;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = w * dpr; canvas.height = h * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);
    const data = st.audioBuffer.getChannelData(0);
    const perPx = Math.max(1, Math.floor(data.length / w));
    const mid = h / 2;
    ctx.strokeStyle = '#37d3c0';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x < w; x++) {
      let lo = 1, hi = -1;
      const off = x * perPx;
      for (let j = 0; j < perPx; j++) { const v = data[off + j] || 0; if (v < lo) lo = v; if (v > hi) hi = v; }
      ctx.moveTo(x, mid + lo * mid * 0.85);
      ctx.lineTo(x, mid + hi * mid * 0.85);
    }
    ctx.stroke();
  }

  /* ==================== 解析本体 ==================== */
  async function analyze() {
    if (!st.audioBuffer) return;
    clearErr();
    st.selected = -1;
    $('#gtabAnalyze').disabled = true;
    $('#gtabProgress').hidden = false;
    $('#gtabResult').hidden = true;
    try {
      await tick();
      progress(3, '音声を準備しています…');
      const guitarSignal = toMono(st.audioBuffer);
      const guitarSr = st.audioBuffer.sampleRate;
      const refSignal = st.refBuffer ? toMono(st.refBuffer) : null;
      const refSr = st.refBuffer ? st.refBuffer.sampleRate : null;

      if (refSignal) {
        progress(6, '2つの音源の開始位置を照合しています…');
        st.refOffset = computeOffset(guitarSignal, guitarSr, refSignal, refSr);
      } else {
        st.refOffset = 0;
      }

      progress(10, refSignal ? '元の楽曲からテンポを確認しています…' : 'テンポを確認しています…');
      const bpmSignal = refSignal || guitarSignal;
      const bpmSr = refSignal ? refSr : guitarSr;
      const auto = $('#gtabBpmMode').value !== 'manual';
      st.bpm = auto ? estimateBpm(bpmSignal, bpmSr) : clamp(+$('#gtabBpmValue').value || 120, 40, 240);
      $('#gtabBpmValue').value = st.bpm;
      st.beatsPerBar = +$('#gtabTimeSig').value;
      const resMode = $('#gtabResolution').value; // bar | half | beat
      st.slotBeats = resMode === 'bar' ? st.beatsPerBar : resMode === 'beat' ? 1 : st.beatsPerBar === 3 ? 1.5 : 2;

      const slotDur = 60 / st.bpm * st.slotBeats;
      const segCount = Math.max(1, Math.ceil(st.audioBuffer.duration / slotDur));

      progress(14, 'ギターのコード成分を解析しています…');
      const guitarSlots = await extractSlots(guitarSignal, guitarSr, slotDur, segCount, 0, 14, refSignal ? 55 : 82);
      let refSlots = null;
      if (refSignal) {
        progress(56, '元の楽曲とコード変化を照合しています…');
        refSlots = await extractSlots(refSignal, refSr, slotDur, segCount, st.refOffset, 56, 82);
      }

      progress(85, 'コード変化を比較して進行を整えています…');
      const rmsVals = guitarSlots.map(s => s.rms / Math.max(1, s.frames)).filter(v => v > 0);
      const rmsMedian = median(rmsVals) || 0.001;
      const rawSegs = guitarSlots.map((g, i) => {
        const primary = normalizeVec(g.chroma);
        const r = refSlots ? refSlots[i] : null;
        const reference = r ? normalizeVec(r.chroma) : null;
        const candidates = blendedCandidates(primary, reference, 7);
        const isSilent = (g.rms / Math.max(1, g.frames)) < rmsMedian * 0.06;
        return {
          start: i * slotDur, end: Math.min(st.audioBuffer.duration, (i + 1) * slotDur),
          bar: Math.floor(i * st.slotBeats / st.beatsPerBar) + 1,
          beat: (i * st.slotBeats) % st.beatsPerBar + 1,
          candidates, isSilent, edited: false,
        };
      });
      st.segs = smoothSequence(rawSegs);

      progress(96, 'コードフォームを作っています…');
      await tick();
      updateCapoSuggestion();
      renderResult();
      $('#gtabResult').hidden = false;
      $('#gtabResult').scrollIntoView({ behavior: 'smooth', block: 'start' });
      progress(100, '完了しました');
      setTimeout(() => { $('#gtabProgress').hidden = true; }, 500);
    } catch (err) {
      console.error(err);
      $('#gtabProgress').hidden = true;
      showErr('解析中にエラーが発生しました。短いMP3またはWAVで再度お試しください。');
    } finally {
      $('#gtabAnalyze').disabled = false;
    }
  }

  function progress(pct, label) {
    $('#gtabProgressBar').style.width = clamp(pct, 0, 100) + '%';
    $('#gtabProgressLabel').textContent = label;
  }
  // requestAnimationFrameはタブが非表示だと呼ばれないため使わない
  // (バックグラウンドタブでの解析が永久に止まってしまうのを防ぐ)
  function tick() {
    return new Promise(r => {
      const ch = new MessageChannel();
      ch.port1.onmessage = () => r();
      ch.port2.postMessage(0);
    });
  }
  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
  function median(arr) {
    if (!arr.length) return 0;
    const s = [...arr].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }
  function fmtTime(sec) {
    if (!Number.isFinite(sec)) return '0:00';
    const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  /* ==================== FFT/クロマ抽出 (自前実装、AudioAnalyzer.fftを利用) ==================== */
  async function extractSlots(signal, sr, slotDur, segCount, timeOffset, progStart, progEnd) {
    const slots = Array.from({ length: segCount }, () => ({ chroma: new Float64Array(12), rms: 0, frames: 0 }));
    const winSize = sr >= 32000 ? 8192 : 4096, hop = winSize / 2;
    const hann = new Float32Array(winSize);
    for (let i = 0; i < winSize; i++) hann[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / winSize);
    const binPc = new Int8Array(winSize / 2).fill(-1);
    const binW = new Float32Array(winSize / 2);
    for (let k = 1; k < winSize / 2; k++) {
      const f = k * sr / winSize;
      if (f < 55 || f > 5000) continue;
      const midi = 69 + 12 * Math.log2(f / 440);
      const nearest = Math.round(midi);
      if (Math.abs(midi - nearest) > 0.35) continue;
      binPc[k] = ((nearest % 12) + 12) % 12;
      binW[k] = 1 / Math.sqrt(Math.max(1, f / 220));
    }
    const nFrames = Math.max(0, Math.ceil(Math.max(0, signal.length - winSize) / hop));
    const re = new Float32Array(winSize), im = new Float32Array(winSize);
    for (let fr = 0; fr <= nFrames; fr++) {
      const off = fr * hop;
      let rms = 0;
      for (let i = 0; i < winSize; i++) {
        const v = signal[off + i] || 0;
        re[i] = v * hann[i]; im[i] = 0; rms += v * v;
      }
      rms = Math.sqrt(rms / winSize);
      AudioAnalyzer.fft(re, im);
      const t = (off + winSize / 2) / sr - timeOffset;
      const slotIdx = Math.floor(t / slotDur);
      if (slotIdx >= 0 && slotIdx < segCount) {
        const slot = slots[slotIdx];
        const weight = Math.max(1e-4, rms);
        for (let k = 2; k < winSize / 2 - 1; k++) {
          const pc = binPc[k];
          if (pc < 0) continue;
          const mag = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
          const magL = Math.sqrt(re[k - 1] * re[k - 1] + im[k - 1] * im[k - 1]);
          const magR = Math.sqrt(re[k + 1] * re[k + 1] + im[k + 1] * im[k + 1]);
          if (mag >= magL && mag >= magR) slot.chroma[pc] += (mag + 0.5 * (magL + magR)) * binW[k] * weight;
        }
        slot.rms += rms; slot.frames++;
      }
      if (fr % 40 === 0) {
        progress(progStart + (fr / Math.max(1, nFrames)) * (progEnd - progStart), $('#gtabProgressLabel').textContent);
        await new Promise(r => { const ch = new MessageChannel(); ch.port1.onmessage = () => r(); ch.port2.postMessage(0); });
      }
    }
    return slots;
  }

  function normalizeVec(vec) {
    const total = [...vec].reduce((a, b) => a + Math.max(0, b), 0);
    if (total < 1e-8) return new Array(12).fill(0);
    return [...vec].map(v => Math.max(0, v) / total);
  }

  /* ==================== コサイン類似度によるコード候補判定 ==================== */
  function templateScore(normChroma, pcs) {
    const w = new Float32Array(12);
    const shape = pcs.length === 3 ? [1, 0.86, 0.95] : [1, 0.82, 0.92, 0.58];
    pcs.forEach((pc, i) => { w[pc] = shape[i] ?? 0.62; });
    let dot = 0, a = 0, b = 0, leak = 0;
    for (let pc = 0; pc < 12; pc++) {
      dot += normChroma[pc] * w[pc];
      a += normChroma[pc] ** 2;
      b += w[pc] ** 2;
      if (!pcs.includes(pc)) leak += normChroma[pc];
    }
    const cos = (a < 1e-8 || b < 1e-8) ? 0 : dot / Math.sqrt(a * b);
    return cos - leak * 0.018;
  }

  function chordCandidates(normChroma, topN) {
    if (!normChroma.some(v => v > 0)) return [{ name: 'N.C.', score: 0, confidence: 0 }];
    const all = [];
    for (let root = 0; root < 12; root++) {
      for (const q of QUALITIES) {
        const pcs = q.intervals.map(iv => (root + iv) % 12);
        const score = templateScore(normChroma, pcs) - q.penalty;
        all.push({ name: chordName(root, q.id), qualityId: q.id, rootPc: root, score });
      }
    }
    all.sort((a, b) => b.score - a.score);
    const margin = Math.max(0, all[0].score - all[1].score);
    const confidence = clamp(margin * 5 + (all[0].score - 0.5) * 0.65, 0, 1);
    return all.slice(0, topN).map(c => ({ ...c, confidence }));
  }

  function blendChroma(primary, reference, weight = 0.18) {
    if (!reference || !reference.some(v => v > 0)) return primary;
    const w = clamp(weight, 0, 0.35);
    return primary.map((v, i) => v * (1 - w) + reference[i] * w);
  }

  function blendedCandidates(primaryChroma, referenceChroma, topN = 7) {
    const primary = chordCandidates(primaryChroma, 84);
    if (!referenceChroma || !referenceChroma.some(v => v > 0)) return primary.slice(0, topN);
    const refCands = chordCandidates(referenceChroma, 84);
    const merged = chordCandidates(blendChroma(primaryChroma, referenceChroma), 84);
    const refMap = new Map(refCands.map(c => [c.name, c.score]));
    const mergedMap = new Map(merged.map(c => [c.name, c.score]));
    const topRefName = refCands[0]?.name;
    const combined = primary.map((c, i) => {
      const bonus = c.name === topRefName && i < 5 ? 0.025 : 0;
      return {
        name: c.name, qualityId: c.qualityId, rootPc: c.rootPc,
        score: c.score * 0.68 + (mergedMap.get(c.name) ?? c.score) * 0.22 + (refMap.get(c.name) ?? c.score) * 0.1 + bonus,
      };
    }).sort((a, b) => b.score - a.score);
    const margin = Math.max(0, combined[0].score - combined[1].score);
    const confidence = clamp(margin * 5 + (combined[0].score - 0.5) * 0.62, 0, 1);
    return combined.slice(0, topN).map(c => ({ ...c, confidence }));
  }

  /* ==================== 時間方向の平滑化 ==================== */
  // 音楽理論に基づく遷移コスト: 同じコードが続く方を優遇し、
  // ルートが同じままテンションだけ揺れる(例: Am⇔Am7)場合も変化コストを抑える。
  // これにより細かい解像度でも、実際は伸ばしている1つのコードが
  // ノイズで別名に揺れて点滅するのを防ぐ。
  function transitionCost(prevName, curName) {
    if (prevName === 'N.C.' || curName === 'N.C.') return 0;
    if (prevName === curName) return 0.05;
    const prevRoot = parseChordName(prevName)?.rootPc;
    const curRoot = parseChordName(curName)?.rootPc;
    if (prevRoot !== undefined && prevRoot === curRoot) return 0.02;
    return -0.02;
  }

  function smoothSequence(segs) {
    if (!segs.length) return [];
    const opts = segs.map(s => s.isSilent ? [{ name: 'N.C.', score: 1, confidence: 0 }] : s.candidates.slice(0, 7));
    const score = [], back = [];
    for (let t = 0; t < opts.length; t++) {
      score[t] = new Array(opts[t].length).fill(-Infinity);
      back[t] = new Array(opts[t].length).fill(-1);
      opts[t].forEach((cand, ci) => {
        const emis = cand.score * 1.55;
        if (t === 0) { score[t][ci] = emis; return; }
        opts[t - 1].forEach((prevCand, pi) => {
          const s = score[t - 1][pi] + emis + transitionCost(prevCand.name, cand.name);
          if (s > score[t][ci]) { score[t][ci] = s; back[t][ci] = pi; }
        });
      });
    }
    const path = new Array(segs.length).fill(0);
    const last = score[score.length - 1];
    path[path.length - 1] = last.reduce((best, v, idx, arr) => v > arr[best] ? idx : best, 0);
    for (let t = segs.length - 1; t > 0; t--) path[t - 1] = Math.max(0, back[t][path[t]]);
    return segs.map((seg, t) => {
      if (seg.isSilent) return { ...seg, name: 'N.C.', confidence: 0 };
      const chosen = opts[t][path[t]] ?? seg.candidates[0];
      const top = seg.candidates[0];
      const margin = Math.max(0, (top?.score ?? 0) - (chosen?.score ?? 0));
      return {
        ...seg, name: chosen?.name ?? 'N.C.',
        confidence: clamp((chosen?.confidence ?? 0) - margin * 1.8, 0, 1),
        sequenceAdjusted: !!(chosen && top && chosen.name !== top.name),
      };
    });
  }

  /* ==================== BPM推定 (オンセット包絡の自己相関) ==================== */
  function estimateBpm(signal, sr) {
    const d = Math.max(1, Math.floor(sr / 200));
    const n = Math.floor(signal.length / d);
    const env = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0;
      const off = i * d;
      for (let j = 0; j < d; j++) s += signal[off + j] ** 2;
      env[i] = Math.sqrt(s / d);
    }
    const diff = new Float32Array(n);
    let base = 0;
    for (let i = 3; i < n; i++) { diff[i] = Math.max(0, env[i] - env[i - 3]); base += diff[i]; }
    base /= Math.max(1, n - 3);
    for (let i = 0; i < n; i++) diff[i] = Math.max(0, diff[i] - base * 0.55);
    const rate = sr / d;
    let best = 120, bestScore = -Infinity;
    const scoreByBpm = new Map();
    for (let bpm = 60; bpm <= 190; bpm++) {
      const lag = Math.round(rate * 60 / bpm);
      let s = 0;
      for (let i = lag; i < n; i++) s += diff[i] * diff[i - lag];
      const pref = 1 - Math.min(0.12, Math.abs(bpm - 112) / 1100);
      s *= pref;
      scoreByBpm.set(bpm, s);
      if (s > bestScore) { bestScore = s; best = bpm; }
    }
    return foldTempo(best, bestScore, scoreByBpm);
  }

  // 検出テンポが実際の倍(または約1.5倍)になっていないか確認し、
  // 半分テンポの方が有力ならそちらを採用する(2拍ハイハット等の誤検出対策)
  function foldTempo(bpm, score, scoreByBpm) {
    if (bpm >= 176) return Math.round(bpm / 2);
    if (bpm < 150) return bpm;
    const half = Math.round(bpm / 2);
    const halfScore = Math.max(
      scoreByBpm.get(half - 1) ?? -Infinity,
      scoreByBpm.get(half) ?? -Infinity,
      scoreByBpm.get(half + 1) ?? -Infinity);
    return halfScore >= score * 0.62 ? half : bpm;
  }

  /* ==================== 元楽曲との時間ズレ検出 (相互相関) ==================== */
  function rmsEnvelopeNormalized(signal, sr, targetHz = 40) {
    const d = Math.max(1, Math.floor(sr / targetHz));
    const n = Math.floor(signal.length / d);
    const env = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0;
      const off = i * d;
      for (let j = 0; j < d; j++) s += signal[off + j] ** 2;
      env[i] = Math.sqrt(s / d);
    }
    let mean = 0; for (const v of env) mean += v; mean /= Math.max(1, n);
    let variance = 0; for (const v of env) variance += (v - mean) ** 2;
    const sd = Math.sqrt(variance / Math.max(1, n)) || 1;
    return { env: Float32Array.from(env, v => (v - mean) / sd), rate: targetHz };
  }
  function corrAt(a, b, lag) {
    let dot = 0, cnt = 0;
    const from = Math.max(0, -lag), to = Math.min(a.length, b.length - lag);
    for (let i = from; i < to; i++) { dot += a[i] * b[i + lag]; cnt++; }
    return cnt ? dot / cnt : -Infinity;
  }
  function computeOffset(guitarSignal, guitarSr, refSignal, refSr) {
    const targetHz = 40;
    const g = rmsEnvelopeNormalized(guitarSignal, guitarSr, targetHz);
    const r = rmsEnvelopeNormalized(refSignal, refSr, targetHz);
    if (g.env.length < targetHz || r.env.length < targetHz) return 0;
    const maxLag = Math.round(2 * targetHz); // ±2秒
    let bestLag = 0, bestScore = corrAt(g.env, r.env, 0);
    for (let lag = -maxLag; lag <= maxLag; lag++) {
      const s = corrAt(g.env, r.env, lag);
      if (s > bestScore) { bestScore = s; bestLag = lag; }
    }
    if (bestScore < 0.08 || (bestLag !== 0 && bestScore < corrAt(g.env, r.env, 0) + 0.025)) return 0;
    return bestLag / targetHz;
  }

  /* ==================== カポ提案 ==================== */
  function transposedName(name, capo) {
    if (name === 'N.C.') return name;
    const p = parseChordName(name);
    if (!p) return name;
    const pc = ((p.rootPc - capo) % 12 + 12) % 12;
    return chordName(pc, p.qualityId);
  }
  function shapeCost(name) {
    if (name === 'N.C.') return 0;
    const p = parseChordName(name);
    if (!p) return 0;
    const shape = Theory.guitarShape(p.rootPc, QUALITIES.find(q => q.id === p.qualityId).suffix, NOTE_USES_FLAT[p.rootPc]);
    if (!shape) return 6;
    return shape.baseFret + (shape.baseFret > 1 ? 2 : 0);
  }
  function isSharpOrFlat(name) {
    const p = parseChordName(name);
    return !!(p && /[#b]/.test(NOTE_NAMES[p.rootPc]));
  }
  function suggestCapo(names) {
    const uniq = [...new Set(names.filter(n => n && n !== 'N.C.'))];
    if (!uniq.some(isSharpOrFlat)) return 0;
    let best = 0, bestCost = Infinity;
    for (let capo = 0; capo <= 6; capo++) {
      const transposed = uniq.map(n => transposedName(n, capo));
      const sharpCost = transposed.filter(isSharpOrFlat).length * 100;
      const fretCost = transposed.reduce((a, n) => a + shapeCost(n), 0);
      const cost = sharpCost + fretCost + capo * 0.08;
      if (cost < bestCost) { bestCost = cost; best = capo; }
    }
    return best;
  }
  function updateCapoSuggestion() {
    const names = st.segs.filter(s => s.name !== 'N.C.').map(s => s.name);
    st.capoSuggested = suggestCapo(names);
    if (!st.capoSuggested) { st.capoMode = false; st.capo = 0; }
    else if (st.capoMode) st.capo = st.capoSuggested;
  }
  function toggleCapo() {
    if (!st.capoSuggested) return;
    st.capoMode = !st.capoMode;
    st.capo = st.capoMode ? st.capoSuggested : 0;
    renderResult();
  }
  function displayName(name) { return (!st.capoMode || name === 'N.C.') ? name : transposedName(name, st.capo); }

  /* ==================== 結果描画 ==================== */
  function renderResult() {
    renderSummary();
    renderCapoUI();
    renderFormScore();
    renderPlaybackStrip();
  }

  function renderSummary() {
    const used = st.segs.filter(s => s.name !== 'N.C.');
    const names = [...new Set(used.map(s => s.name))];
    const avgConf = used.length ? used.reduce((a, s) => a + s.confidence, 0) / used.length : 0;
    const confLabel = avgConf >= 0.58 ? '高め' : avgConf >= 0.3 ? '標準' : '要確認';
    $('#gtabMeta').innerHTML = `
      <span class="summary-item">推定テンポ <strong>${st.bpm} BPM</strong></span>
      <span class="summary-item">拍子 <strong>${st.beatsPerBar}/4</strong></span>
      <span class="summary-item">使用コード <strong>${names.length}種類</strong></span>
      <span class="summary-item">判定の目安 <strong>${confLabel}</strong> <small>${st.refBuffer ? '・元曲照合' : '・単独解析'}</small></span>`;
  }

  function renderCapoUI() {
    const btn = $('#gtabCapoToggle');
    btn.hidden = !st.capoSuggested;
    btn.textContent = st.capoMode ? `原音コードへ戻す (Capo ${st.capo})` : `カポ${st.capoSuggested}で簡単コード`;
    btn.classList.toggle('on', st.capoMode);
    const notice = $('#gtabCapoNotice');
    notice.hidden = !st.capoMode;
    notice.innerHTML = st.capoMode
      ? `<strong>Capo ${st.capo}</strong><span>${st.capo}フレットにカポを付けた押さえ方です。小さく表示する「実音」が元のコード名です。</span>`
      : '';
  }

  function renderFormScore() {
    const holder = $('#gtabFormScore');
    holder.innerHTML = '';
    if (!st.segs.length) { holder.innerHTML = '<p class="hint">コードが検出できませんでした。</p>'; return; }
    const grid = document.createElement('div');
    grid.className = 'gform-grid';
    st.segs.forEach((seg, idx) => {
      const shown = displayName(seg.name);
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'gform-card' + (seg.confidence < 0.25 && !seg.edited ? ' low-confidence' : '') + (idx === st.selected ? ' editing' : '');
      card.dataset.idx = idx;
      card.dataset.startSec = seg.start;
      card.dataset.endSec = seg.end;
      const pos = document.createElement('span');
      pos.className = 'gform-pos';
      pos.textContent = `${seg.bar}小節目・${Number.isInteger(seg.beat) ? seg.beat : seg.beat.toFixed(1)}拍目${seg.edited ? '・修正済み' : ''}`;
      card.appendChild(pos);
      if (shown !== 'N.C.') {
        const shape = Theory.guitarShape(
          ((parseChordName(shown) || {}).rootPc) ?? 0,
          QUALITIES.find(q => q.id === (parseChordName(shown) || {}).qualityId)?.suffix ?? '',
          NOTE_USES_FLAT[(parseChordName(shown) || {}).rootPc ?? 0]);
        card.appendChild(Renderer.chordDiagramTab(shown, shape));
      } else {
        const nc = document.createElement('div'); nc.className = 'gform-nc'; nc.textContent = 'N.C.';
        card.appendChild(nc);
      }
      if (st.capoMode && seg.name !== 'N.C.') {
        const actual = document.createElement('span');
        actual.className = 'gform-actual';
        actual.textContent = `実音 ${seg.name}`;
        card.appendChild(actual);
      }
      card.addEventListener('click', () => { st.selected = st.selected === idx ? -1 : idx; renderResult(); renderEditor(); });
      grid.appendChild(card);
    });
    holder.appendChild(grid);
    renderEditor();
  }

  function renderEditor() {
    const ed = $('#gtabEditor');
    if (st.selected < 0 || !st.segs[st.selected]) { ed.hidden = true; return; }
    ed.hidden = false;
    ed.innerHTML = '';
    const seg = st.segs[st.selected];
    const p = parseChordName(seg.name) || { rootPc: 0, qualityId: 'major' };

    const title = document.createElement('span');
    title.className = 'ctrl-label';
    title.textContent = `${seg.bar}小節目・${Number.isInteger(seg.beat) ? seg.beat : seg.beat.toFixed(1)}拍目「${seg.name}」を編集:`;
    ed.appendChild(title);

    const rootSel = document.createElement('select');
    NOTE_NAMES.forEach((n, pc) => {
      const o = document.createElement('option'); o.value = pc; o.textContent = n;
      if (pc === p.rootPc) o.selected = true;
      rootSel.appendChild(o);
    });
    const qualSel = document.createElement('select');
    QUALITIES.forEach(q => {
      const o = document.createElement('option'); o.value = q.id; o.textContent = q.label;
      if (q.id === p.qualityId) o.selected = true;
      qualSel.appendChild(o);
    });
    const apply = () => {
      seg.name = chordName(+rootSel.value, qualSel.value);
      seg.edited = true; seg.confidence = 1;
      updateCapoSuggestion();
      renderResult();
    };
    rootSel.addEventListener('change', apply);
    qualSel.addEventListener('change', apply);
    ed.appendChild(rootSel); ed.appendChild(qualSel);

    const ncBtn = document.createElement('button');
    ncBtn.className = 'btn btn-small';
    ncBtn.textContent = 'コードなし (N.C.)';
    ncBtn.addEventListener('click', () => { seg.name = 'N.C.'; seg.edited = true; renderResult(); });
    ed.appendChild(ncBtn);

    const closeBtn = document.createElement('button');
    closeBtn.className = 'btn btn-small';
    closeBtn.textContent = '閉じる';
    closeBtn.addEventListener('click', () => { st.selected = -1; renderResult(); });
    ed.appendChild(closeBtn);

    if (seg.candidates && seg.candidates.length > 1) {
      const wrap = document.createElement('div');
      wrap.className = 'gtab-candidates';
      const label = document.createElement('span');
      label.className = 'ctrl-label';
      label.textContent = '解析候補:';
      wrap.appendChild(label);
      seg.candidates.slice(0, 5).forEach(c => {
        const b = document.createElement('button');
        b.className = 'btn btn-small candidate-btn';
        b.textContent = c.name;
        b.addEventListener('click', () => {
          seg.name = c.name; seg.edited = true; seg.confidence = 1;
          updateCapoSuggestion();
          renderResult();
        });
        wrap.appendChild(b);
      });
      ed.appendChild(wrap);
    }
  }

  /* ==================== 再生 ==================== */
  function renderPlaybackStrip() {
    const audio = $('#gtabAudioEl');
    const src = st.refUrl || st.audioUrl;
    if (audio.src !== src) { audio.src = src || ''; }
    $('#gtabPlaySourceNote').textContent = st.refUrl ? '再生音源: 元の楽曲' : '再生音源: ギター音源';
  }

  function togglePlay() {
    const audio = $('#gtabAudioEl');
    if (!st.file) return;
    if (audio.paused) {
      if (audio.ended) audio.currentTime = 0;
      audio.play().then(startPlayLoop).catch(() => showErr('音声を再生できませんでした。'));
    } else {
      audio.pause();
    }
  }

  function startPlayLoop() {
    stopPlayLoop();
    const audio = $('#gtabAudioEl');
    $('#gtabPlayToggle').textContent = '❚❚';
    const loop = () => {
      updatePlaybackUI(audio);
      st.playRAF = requestAnimationFrame(loop);
    };
    st.playRAF = requestAnimationFrame(loop);
    audio.addEventListener('pause', stopPlayLoop, { once: true });
    audio.addEventListener('ended', stopPlayLoop, { once: true });
  }
  function stopPlayLoop() {
    if (st.playRAF) cancelAnimationFrame(st.playRAF);
    st.playRAF = null;
    $('#gtabPlayToggle').textContent = '▶';
    updatePlaybackUI($('#gtabAudioEl'));
  }
  function updatePlaybackUI(audio) {
    const t = audio.currentTime || 0, dur = audio.duration || st.audioBuffer?.duration || 0;
    $('#gtabTimelineFill').style.width = (dur ? t / dur * 100 : 0) + '%';
    $('#gtabPlaybackTime').textContent = `${fmtTime(t)} / ${fmtTime(dur)}`;
    const adj = t - (st.refUrl ? st.refOffset : 0);
    const idx = st.segs.findIndex(s => adj >= s.start && adj < s.end);
    $$('.gform-card.active, .gform-card.up-next').forEach(c => c.classList.remove('active', 'up-next'));
    if (idx >= 0) {
      const cards = $$('.gform-card');
      cards[idx]?.classList.add('active');
      cards[idx + 1]?.classList.add('up-next');
    }
    const name = st.segs[idx]?.name;
    const shown = name ? displayName(name) : null;
    $('#gtabNowChord').textContent = shown ? (st.capoMode && name !== 'N.C.' ? `${shown} (実音 ${name})` : shown) : '—';
  }

  /* ==================== JSON保存/読込 ==================== */
  function saveJson() {
    const data = {
      app: 'chord-studio-guitartab', version: 2, createdAt: new Date().toISOString(),
      sourceFile: st.file ? st.file.name : null,
      referenceFile: st.refFile ? st.refFile.name : null, referenceOffset: st.refOffset,
      bpm: st.bpm, beatsPerBar: st.beatsPerBar, slotBeats: st.slotBeats,
      tuning: ['E2', 'A2', 'D3', 'G3', 'B3', 'E4'],
      capo: { enabled: st.capoMode, fret: st.capo, suggested: st.capoSuggested },
      segments: st.segs.map(s => ({
        start: s.start, end: s.end, bar: s.bar, beat: s.beat, name: s.name,
        confidence: s.confidence, edited: s.edited,
        candidates: (s.candidates || []).slice(0, 5).map(c => ({ name: c.name, score: +c.score.toFixed(4) })),
      })),
    };
    const blob = new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (st.file ? st.file.name.replace(/\.[^.]+$/, '') : 'guitar') + '-chords.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  async function importJson() {
    const f = $('#gtabImport').files[0];
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      if (!Array.isArray(data.segments)) throw new Error('segments missing');
      st.bpm = Number(data.bpm) || 120;
      st.beatsPerBar = Number(data.beatsPerBar) || 4;
      st.slotBeats = Number(data.slotBeats) || 1;
      st.refOffset = Number(data.referenceOffset) || 0;
      st.capoMode = !!data.capo?.enabled;
      st.capo = Number(data.capo?.fret) || 0;
      st.capoSuggested = Number(data.capo?.suggested) || st.capo;
      st.segs = data.segments.map(s => ({ ...s, isSilent: s.name === 'N.C.' }));
      st.selected = -1;
      $('#gtabTimeSig').value = String(st.beatsPerBar);
      $('#gtabBpmValue').value = st.bpm;
      renderResult();
      $('#gtabResult').hidden = false;
      $('#gtabResult').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (err) {
      showErr('Guitar Chord TABで保存したJSONファイルを選んでください。');
    }
    $('#gtabImport').value = '';
  }

})();
