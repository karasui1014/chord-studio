/* =========================================================
 * transcribe.js — ステム音源(mp3/wav)の自動採譜エンジン
 * 単音系(ベース/ボーカル): 自己相関ピッチ追跡(高精度)
 * 和音系(ギター/鍵盤): 倍音サリエンスによる複音推定(参考精度)
 * すべて端末内で実行。外部送信なし。
 * ======================================================= */
'use strict';

const Transcriber = (() => {

  const SR = 22050; // 解析用サンプルレート

  /* ---------- デコード & モノラル化 & リサンプル ---------- */
  async function decodeMono(arrayBuffer) {
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = new AC();
    const buf = await ctx.decodeAudioData(arrayBuffer);
    ctx.close();
    const n = buf.length;
    const mono = new Float32Array(n);
    for (let ch = 0; ch < buf.numberOfChannels; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < n; i++) mono[i] += d[i] / buf.numberOfChannels;
    }
    if (buf.sampleRate === SR) return mono;
    const off = new OfflineAudioContext(1, Math.ceil(buf.duration * SR), SR);
    const b2 = off.createBuffer(1, n, buf.sampleRate);
    b2.copyToChannel(mono, 0);
    const src = off.createBufferSource();
    src.buffer = b2;
    src.connect(off.destination);
    src.start();
    const rendered = await off.startRendering();
    return rendered.getChannelData(0);
  }

  /* ---------- ファイル名 → 楽器ロール ---------- */
  function roleFromName(name) {
    const s = name.toLowerCase();
    if (/drum|perc|beat|ドラム/.test(s)) return 'drums';
    if (/bass|ベース/.test(s)) return 'bass';
    if (/guitar|gtr|ギター/.test(s)) return 'guitar';
    if (/key|piano|organ|rhodes|鍵盤|ピアノ/.test(s)) return 'keys';
    if (/synth|pad|シンセ/.test(s)) return 'keys';
    if (/vocal|vox|voice|歌|ボーカル/.test(s)) return /back|コーラス/.test(s) ? 'skip' : 'melody';
    return 'auto';
  }

  function cleanName(fileName) {
    return fileName.replace(/\.[^.]+$/, '').replace(/^\s*\d+\s*[-_.]?\s*/, '').trim() || fileName;
  }

  /* ---------- ビートグリッド (ミックスの解析結果から) ---------- */
  function makeBeatGrid(beatTimes, bpm) {
    const bt = beatTimes;
    const beatDur = 60 / bpm;
    const secToBeat = t => {
      if (bt.length < 2) return Math.max(0, t / beatDur);
      if (t <= bt[0]) return Math.max(0, (t - bt[0]) / beatDur);
      for (let i = 0; i < bt.length - 1; i++) {
        if (t < bt[i + 1]) return i + (t - bt[i]) / (bt[i + 1] - bt[i]);
      }
      const last = bt.length - 1;
      return last + (t - bt[last]) / beatDur;
    };
    const beatToSec = b => {
      if (bt.length < 2) return b * beatDur;
      if (b <= 0) return bt[0] + b * beatDur;
      const i = Math.floor(b);
      if (i < bt.length - 1) return bt[i] + (b - i) * (bt[i + 1] - bt[i]);
      const last = bt.length - 1;
      return bt[last] + (b - last) * beatDur;
    };
    return { secToBeat, beatToSec };
  }

  /* ---------- 単音ピッチ追跡 (FFT自己相関) ---------- */
  async function trackMono(data, opts, tick) {
    const win = 2048, hop = 512, fftN = 4096;
    const nFrames = Math.max(0, Math.floor((data.length - win) / hop));
    const minF = opts.minF || 35, maxF = opts.maxF || 1000;
    const minLag = Math.max(2, Math.floor(SR / maxF));
    const maxLag = Math.min(win - 1, Math.ceil(SR / minF));
    const re = new Float32Array(fftN);
    const im = new Float32Array(fftN);

    // RMSゲート(全体分布から自動設定)
    const rmsArr = new Float32Array(nFrames);
    for (let fr = 0; fr < nFrames; fr++) {
      let s = 0;
      const off = fr * hop;
      for (let j = 0; j < win; j += 2) s += data[off + j] * data[off + j];
      rmsArr[fr] = Math.sqrt(s / (win / 2));
    }
    const sorted = [...rmsArr].sort((a, b) => a - b);
    const peakRms = sorted[Math.floor(sorted.length * 0.97)] || 0;
    const gate = Math.max(1e-4, peakRms * 0.08);

    const pitches = new Float32Array(nFrames).fill(-1);
    const energy = new Float32Array(nFrames);
    for (let fr = 0; fr < nFrames; fr++) {
      if (rmsArr[fr] < gate) continue;
      const off = fr * hop;
      re.fill(0); im.fill(0);
      for (let j = 0; j < win; j++) re[j] = data[off + j];
      AudioAnalyzer.fft(re, im);
      for (let k = 0; k < fftN; k++) {
        const p = re[k] * re[k] + im[k] * im[k];
        re[k] = p; im[k] = 0;
      }
      AudioAnalyzer.fft(re, im); // パワースペクトルの逆変換 ≒ 自己相関(実部・対称)
      const r0 = re[0] || 1e-9;
      let bestLag = -1, bestVal = 0;
      for (let lag = minLag; lag <= maxLag; lag++) {
        const v = re[lag] / r0;
        if (v > bestVal && re[lag] > re[lag - 1] && re[lag] >= re[lag + 1]) {
          bestVal = v; bestLag = lag;
        }
      }
      if (bestLag > 0 && bestVal > 0.45) {
        // 半分のラグ(オクターブ上)が同等に強ければそちらを採用
        const half = Math.round(bestLag / 2);
        if (half >= minLag && re[half] / r0 > bestVal * 0.9) bestLag = half;
        const f = SR / bestLag;
        pitches[fr] = 69 + 12 * Math.log2(f / 440);
        energy[fr] = rmsArr[fr];
      }
      if (fr % 400 === 0) { tick(fr / nFrames); await yieldUI(); }
    }

    // メディアン平滑化
    const smooth = new Float32Array(nFrames).fill(-1);
    for (let i = 0; i < nFrames; i++) {
      const wnd = [];
      for (let j = Math.max(0, i - 2); j <= Math.min(nFrames - 1, i + 2); j++) {
        if (pitches[j] > 0) wnd.push(pitches[j]);
      }
      if (wnd.length >= 3 && pitches[i] > 0) {
        wnd.sort((a, b) => a - b);
        smooth[i] = wnd[Math.floor(wnd.length / 2)];
      } else {
        smooth[i] = pitches[i];
      }
    }

    // セグメント化 → ノート
    // 隣接フレーム間の急なジャンプでのみ分割し、なだらかな音程変化は
    // 1音のグリッサンド/チョーキングとして扱う
    const frameDur = hop / SR;
    const notes = [];
    let start = -1, velSum = 0;
    let runPitches = [];
    const median = arr => {
      const a = [...arr].sort((x, y) => x - y);
      return a[Math.floor(a.length / 2)];
    };
    const flush = end => {
      if (start < 0 || runPitches.length === 0) { start = -1; runPitches = []; velSum = 0; return; }
      const durSec = (end - start) * frameDur;
      if (durSec >= 0.09) {
        const head = median(runPitches.slice(0, Math.min(3, runPitches.length)));
        const tail = median(runPitches.slice(-3));
        const note = {
          startSec: start * frameDur,
          durSec,
          pitch: Math.round(head),
          vel: Math.min(120, Math.round(40 + 500 * (velSum / runPitches.length) / (peakRms || 1))),
          artic: null, toPitch: null,
        };
        if (Math.abs(tail - head) >= 0.8) { // グリス/チョーキング気味の音程移動
          note.artic = tail > head ? 'up' : 'down';
          note.toPitch = Math.round(tail);
        }
        notes.push(note);
      }
      start = -1; runPitches = []; velSum = 0;
    };
    let prevP = -1;
    for (let i = 0; i < nFrames; i++) {
      const p = smooth[i];
      if (p < 0) { flush(i); prevP = -1; continue; }
      // 同音連打: 音量の急な立ち上がりで音符を分割
      const reattack = runPitches.length > 2 && i > 0 && rmsArr[i] > rmsArr[i - 1] * 1.8 && rmsArr[i] > gate * 2.5;
      const jump = prevP > 0 && Math.abs(p - prevP) > 0.6; // 急な音程ジャンプ = 別の音
      if (start < 0) { start = i; }
      else if (jump || reattack) { flush(i); start = i; }
      runPitches.push(p);
      velSum += energy[i];
      prevP = p;
    }
    flush(nFrames);
    return notes;
  }

  /* ---------- 複音推定 (倍音サリエンス) ---------- */
  async function trackPoly(data, opts, tick) {
    const win = 4096, hop = 1024;
    const nFrames = Math.max(0, Math.floor((data.length - win) / hop));
    const PMIN = opts.pmin || 36, PMAX = opts.pmax || 88;
    const MAXVOICES = opts.maxVoices || 4;
    const re = new Float32Array(win);
    const im = new Float32Array(win);
    const hann = new Float32Array(win);
    for (let i = 0; i < win; i++) hann[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / win);
    const HW = [1, 0.85, 0.65, 0.5, 0.35];

    const roll = []; // frame → Set(pitch)
    const rollVel = [];
    let globalPeak = 1e-9;

    for (let fr = 0; fr < nFrames; fr++) {
      const off = fr * hop;
      for (let j = 0; j < win; j++) { re[j] = data[off + j] * hann[j]; im[j] = 0; }
      AudioAnalyzer.fft(re, im);
      const half = win / 2;
      const mag = new Float32Array(half);
      let frameEnergy = 0;
      for (let k = 1; k < half; k++) {
        mag[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
        frameEnergy += mag[k];
      }
      globalPeak = Math.max(globalPeak, frameEnergy);
      const active = new Map();
      if (frameEnergy > 1e-4) {
        const sal = p => {
          const f0 = 440 * Math.pow(2, (p - 69) / 12);
          let s = 0;
          for (let h = 1; h <= HW.length; h++) {
            const k = Math.round(f0 * h * win / SR);
            if (k < 2 || k >= half - 1) break;
            s += HW[h - 1] * Math.max(mag[k - 1], mag[k], mag[k + 1]);
          }
          return s;
        };
        let firstSal = 0;
        for (let v = 0; v < MAXVOICES; v++) {
          let bp = -1, bs = 0;
          for (let p = PMIN; p <= PMAX; p++) {
            if (active.has(p)) continue;
            const s = sal(p);
            if (s > bs) { bs = s; bp = p; }
          }
          if (bp < 0) break;
          // サブハーモニック対策: 1オクターブ上がほぼ同等の強さならそちらが本体
          if (bp + 12 <= PMAX && !active.has(bp + 12)) {
            const s12 = sal(bp + 12);
            if (s12 > bs * 0.8) { bp = bp + 12; bs = s12; }
          }
          if (v === 0) {
            firstSal = bs;
            if (bs < frameEnergy * 0.012) break; // 無音・ノイズ
          } else if (bs < firstSal * 0.45) break;
          // オクターブ誤検出の抑制: 1オクターブ下が既に居て弱ければ除外
          if (active.has(bp - 12) && bs < active.get(bp - 12) * 0.55) {
            // subtractしてスキップ
          } else {
            active.set(bp, bs);
          }
          const f0 = 440 * Math.pow(2, (bp - 69) / 12);
          for (let h = 1; h <= 6; h++) {
            const k = Math.round(f0 * h * win / SR);
            if (k >= 2 && k < half - 1) { mag[k - 1] *= 0.25; mag[k] *= 0.2; mag[k + 1] *= 0.25; }
          }
        }
      }
      roll.push(active);
      if (fr % 150 === 0) { tick(fr / nFrames); await yieldUI(); }
    }

    // ロールの平滑化: 1フレーム欠落を補完 → 短すぎるノートを除去
    const frameDur = hop / SR;
    const minFrames = Math.max(2, Math.round(0.16 / frameDur));
    const notes = [];
    const openRuns = new Map(); // pitch → {start, peak}
    const suppressed = new Set(); // 減衰しきった音は消えるまで再開しない
    const close = (p, run, fr) => {
      if (fr - run.start >= minFrames) {
        notes.push({
          startSec: run.start * frameDur,
          durSec: (fr - run.start) * frameDur,
          pitch: p,
          vel: 85,
        });
      }
      openRuns.delete(p);
    };
    for (let fr = 0; fr <= roll.length; fr++) {
      const cur = fr < roll.length ? roll[fr] : new Map();
      const nxt = fr + 1 < roll.length ? roll[fr + 1] : new Map();
      for (const p of [...suppressed]) if (!cur.has(p)) suppressed.delete(p);
      for (const [p, s] of cur) {
        if (suppressed.has(p)) continue;
        if (!openRuns.has(p)) openRuns.set(p, { start: fr, peak: s });
        const run = openRuns.get(p);
        run.peak = Math.max(run.peak, s);
        if (s < run.peak * 0.3) { // 残響の尻尾はノート終端とみなす
          close(p, run, fr);
          suppressed.add(p);
        }
      }
      for (const [p, run] of [...openRuns]) {
        if (!cur.has(p) || suppressed.has(p)) {
          if (!suppressed.has(p) && nxt.has(p) && fr - run.start >= 1) continue; // 1フレーム欠落は継続
          if (openRuns.has(p)) close(p, run, fr);
        }
      }
    }
    return notes;
  }

  // setTimeoutはバックグラウンドで1秒に絞られるため、MessageChannelで譲る
  function yieldUI() {
    return new Promise(r => {
      const ch = new MessageChannel();
      ch.port1.onmessage = () => r();
      ch.port2.postMessage(0);
    });
  }

  /* ミックスをWAV化(再生同期用の実音源) */
  function mixToWavUrl(mix) {
    const n = mix.length;
    let peak = 1e-6;
    for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(mix[i]));
    const scale = Math.min(1, 0.9 / peak) * 32767;
    const buf = new ArrayBuffer(44 + n * 2);
    const dv = new DataView(buf);
    const w = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); w(8, 'WAVEfmt ');
    dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
    dv.setUint32(24, SR, true); dv.setUint32(28, SR * 2, true);
    dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
    w(36, 'data'); dv.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) dv.setInt16(44 + i * 2, Math.max(-32767, Math.min(32767, mix[i] * scale)), true);
    return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
  }

  /* ---------- メイン: ステムファイル群 → ソングモデル ---------- */
  // opts.fullMixBuffer: 楽曲ファイル(フルミックス)のArrayBuffer。
  // あればコード・キー・テンポ解析はこちらを使う(ステム合算より高精度)
  async function transcribeFiles(files, progressCb, opts) {
    opts = opts || {};
    const stems = [];
    const total = files.length;
    for (let i = 0; i < total; i++) {
      const f = files[i];
      progressCb(`「${cleanName(f.name)}」を読み込み中… (${i + 1}/${total})`, (i + 0.1) / (total + 1));
      const buf = await f.arrayBuffer();
      const data = await decodeMono(buf);
      stems.push({ file: f, name: cleanName(f.name), data, role: roleFromName(f.name) });
    }

    // コード進行・キー・テンポの解析対象:
    // 楽曲ファイルがあればそれを、なければ全ステムを合算したミックスを使う
    let mix;
    if (opts.fullMixBuffer) {
      progressCb('楽曲ファイル(フルミックス)を読み込み中…', 0.15 / (total + 1));
      mix = await decodeMono(opts.fullMixBuffer);
    } else {
      let maxLen = 0;
      for (const s of stems) maxLen = Math.max(maxLen, s.data.length);
      mix = new Float32Array(maxLen);
      for (const s of stems) for (let i = 0; i < s.data.length; i++) mix[i] += s.data[i] * (s.role === 'drums' ? 0.4 : 1);
    }
    const chordResult = await AudioAnalyzer.analyzeMono(mix, SR, p =>
      progressCb('コード進行とテンポを解析中…', (0.3 + 0.6 * p) / (total + 1)));
    const bpm = chordResult.bpm;
    const grid = makeBeatGrid(chordResult.beatTimes, bpm);
    const mixWavUrl = mixToWavUrl(mix); // 再生同期用にミックスをそのまま聴けるようにする

    // 各ステムを採譜
    const tracks = [];
    for (let i = 0; i < total; i++) {
      const s = stems[i];
      const base = (i + 1) / (total + 1);
      const span = 1 / (total + 1);
      if (s.role === 'drums') {
        tracks.push(makeTrack(s, [], grid));
        continue;
      }
      progressCb(`「${s.name}」を採譜中… (${i + 1}/${total})`, base);
      const tick = p => progressCb(`「${s.name}」を採譜中… (${i + 1}/${total})`, base + span * p);
      let rawNotes;
      if (s.role === 'bass') {
        rawNotes = await trackMono(s.data, { minF: 28, maxF: 400 }, tick);
      } else if (s.role === 'melody' || s.role === 'skip') {
        rawNotes = await trackMono(s.data, { minF: 70, maxF: 1100 }, tick);
      } else if (s.role === 'guitar') {
        rawNotes = await trackPoly(s.data, { pmin: 40, pmax: 86, maxVoices: 5 }, tick);
      } else if (s.role === 'keys') {
        rawNotes = await trackPoly(s.data, { pmin: 36, pmax: 96, maxVoices: 4 }, tick);
      } else { // auto: まず複音で試し、単音率が高ければ単音で取り直す
        rawNotes = await trackPoly(s.data, { pmin: 36, pmax: 96, maxVoices: 4 }, tick);
      }
      tracks.push(makeTrack(s, rawNotes, grid));
      s.data = null; // メモリ解放
    }

    // autoロールの決定 & ノートが少なすぎるトラックはskip
    for (const tr of tracks) {
      if (tr.role === 'auto') {
        const avg = tr.notes.length ? tr.notes.reduce((a, n) => a + n.pitch, 0) / tr.notes.length : 60;
        tr.role = avg < 50 ? 'bass' : 'keys';
      }
      if (tr.role !== 'drums' && tr.notes.length < 8) tr.role = 'skip';
    }

    let maxBeat = 4;
    for (const tr of tracks) {
      for (const n of tr.notes) maxBeat = Math.max(maxBeat, n.beat + n.durBeat);
    }
    const ppq = 480;
    progressCb('仕上げ中…', 0.98);
    return {
      source: 'midi',
      kind: 'stems',
      ppq, bpm,
      timeSig: { num: 4, den: 4 }, beatsPerBar: 4,
      totalBars: Math.max(chordResult.totalBars, Math.ceil(maxBeat / 4)),
      tracks,
      chordResult,
      mixWavUrl,
      tickToSec: t => grid.beatToSec(t / ppq),
    };
  }

  function makeTrack(stem, rawNotes, grid) {
    const ppq = 480;
    const notes = [];
    for (const n of rawNotes) {
      const beat = Math.max(0, grid.secToBeat(n.startSec));
      const durBeat = Math.max(0.2, grid.secToBeat(n.startSec + n.durSec) - beat);
      notes.push({
        tick: Math.round(beat * ppq),
        durTick: Math.max(1, Math.round(durBeat * ppq)),
        pitch: n.pitch, vel: n.vel || 85, ch: 0,
        beat, durBeat,
        artic: n.artic || null, toPitch: n.toPitch || null,
      });
    }
    notes.sort((a, b) => a.tick - b.tick || a.pitch - b.pitch);
    return { name: stem.name, fileName: stem.file.name, notes, role: stem.role, channels: [0] };
  }

  return { transcribeFiles, roleFromName };
})();
