/* =========================================================
 * audio.js — 音源ファイルのコード解析エンジン
 * FFT → クロマグラム → ビート推定 → Viterbi平滑化コード判定
 * すべて端末内で実行。外部送信なし。
 * ======================================================= */
'use strict';

const AudioAnalyzer = (() => {

  /* ---------- FFT (radix-2, in-place) ---------- */
  function fft(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        [re[i], re[j]] = [re[j], re[i]];
        [im[i], im[j]] = [im[j], im[i]];
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = -2 * Math.PI / len;
      const wRe = Math.cos(ang), wIm = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let curRe = 1, curIm = 0;
        for (let k = 0; k < len / 2; k++) {
          const uRe = re[i + k], uIm = im[i + k];
          const vRe = re[i + k + len / 2] * curRe - im[i + k + len / 2] * curIm;
          const vIm = re[i + k + len / 2] * curIm + im[i + k + len / 2] * curRe;
          re[i + k] = uRe + vRe; im[i + k] = uIm + vIm;
          re[i + k + len / 2] = uRe - vRe; im[i + k + len / 2] = uIm - vIm;
          const nRe = curRe * wRe - curIm * wIm;
          curIm = curRe * wIm + curIm * wRe;
          curRe = nRe;
        }
      }
    }
  }

  /* ---------- メイン解析 ---------- */
  async function analyze(arrayBuffer, progressCb) {
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = new AC();
    const buf = await ctx.decodeAudioData(arrayBuffer.slice(0));
    ctx.close();
    return analyzeMono(downmix(buf), buf.sampleRate, progressCb);
  }

  /* モノラルFloat32Arrayを直接解析(ステム採譜からも利用) */
  async function analyzeMono(mono, sr, progressCb) {
    const duration = mono.length / sr;

    // フレーム長はサンプルレートに応じて約90msホップに揃える
    const winSize = sr >= 32000 ? 8192 : 4096;
    const hop = winSize / 2;
    const nFrames = Math.max(1, Math.floor((mono.length - winSize) / hop));
    const hann = new Float32Array(winSize);
    for (let i = 0; i < winSize; i++) hann[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / winSize);

    // ビン → ピッチクラス対応表 (55Hz〜5kHz)
    const binPc = new Int8Array(winSize / 2).fill(-1);
    const binW = new Float32Array(winSize / 2);
    for (let k = 1; k < winSize / 2; k++) {
      const f = k * sr / winSize;
      if (f < 55 || f > 5000) continue;
      const midi = 69 + 12 * Math.log2(f / 440);
      const nearest = Math.round(midi);
      if (Math.abs(midi - nearest) > 0.35) continue; // ピッチ中心から遠いビンは捨てる
      binPc[k] = ((nearest % 12) + 12) % 12;
      binW[k] = 1 / Math.sqrt(Math.max(1, f / 220)); // 高域の倍音を減衰
    }

    const chroma = [];
    const flux = new Float32Array(nFrames);
    let prevMag = null;
    const re = new Float32Array(winSize);
    const im = new Float32Array(winSize);

    for (let fr = 0; fr < nFrames; fr++) {
      const off = fr * hop;
      for (let i = 0; i < winSize; i++) {
        re[i] = mono[off + i] * hann[i];
        im[i] = 0;
      }
      fft(re, im);
      const vec = new Float32Array(12);
      const mag = new Float32Array(winSize / 2);
      for (let k = 1; k < winSize / 2; k++) {
        mag[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
      }
      // ピークピッキング: 局所最大のビンだけ採用(窓関数の漏れが隣接半音に乗るのを防ぐ)
      for (let k = 2; k < winSize / 2 - 1; k++) {
        const pc = binPc[k];
        if (pc < 0) continue;
        if (mag[k] >= mag[k - 1] && mag[k] >= mag[k + 1]) {
          vec[pc] += (mag[k] + 0.5 * (mag[k - 1] + mag[k + 1])) * binW[k];
        }
      }
      chroma.push(vec);
      if (prevMag) {
        let s = 0;
        for (let k = 1; k < winSize / 2; k++) {
          const d = mag[k] - prevMag[k];
          if (d > 0) s += d;
        }
        flux[fr] = s;
      }
      prevMag = mag;
      if (progressCb && fr % 32 === 0) {
        progressCb(0.05 + 0.75 * fr / nFrames);
        // setTimeoutはバックグラウンドで絞られるためMessageChannelで譲る
        await new Promise(r => {
          const ch = new MessageChannel();
          ch.port1.onmessage = () => r();
          ch.port2.postMessage(0);
        });
      }
    }

    const frameDur = hop / sr;

    /* ---------- BPM & ビート推定 ---------- */
    let { bpm, beatTimes } = estimateBeats(flux, frameDur, duration);

    /* ---------- ビート単位のクロマ → Viterbi コード列 ---------- */
    const beatChroma = [];
    for (let b = 0; b < beatTimes.length - 1; b++) {
      const f0 = Math.floor(beatTimes[b] / frameDur);
      const f1 = Math.max(f0 + 1, Math.floor(beatTimes[b + 1] / frameDur));
      const vec = new Array(12).fill(0);
      for (let f = f0; f < Math.min(f1, chroma.length); f++) {
        for (let pc = 0; pc < 12; pc++) vec[pc] += chroma[f][pc];
      }
      beatChroma.push(vec);
    }
    if (progressCb) progressCb(0.88);

    const chordSeq = viterbiChords(beatChroma); // ビートごとの state index or null
    if (progressCb) progressCb(0.96);

    /* ---------- セグメント化 ---------- */
    const chords = [];
    for (let b = 0; b < chordSeq.length; b++) {
      const st = chordSeq[b];
      if (st === null) continue;
      const last = chords[chords.length - 1];
      if (last && last.stateIdx === st && last.endBeat === b) {
        last.endBeat = b + 1;
        last.endSec = beatTimes[b + 1];
      } else {
        chords.push({
          stateIdx: st,
          root: VITERBI_STATES[st].root,
          suffix: VITERBI_STATES[st].suffix,
          intervals: VITERBI_STATES[st].intervals,
          startBeat: b, endBeat: b + 1,
          startSec: beatTimes[b], endSec: beatTimes[b + 1],
          bassPc: null,
        });
      }
    }
    // 1拍だけの孤立コードを前のコードに吸収(ノイズ除去)
    const cleaned = [];
    for (const c of chords) {
      const len = c.endBeat - c.startBeat;
      const prev = cleaned[cleaned.length - 1];
      if (len <= 1 && prev && prev.endBeat === c.startBeat) {
        const next = null;
        prev.endBeat = c.endBeat;
        prev.endSec = c.endSec;
      } else {
        cleaned.push(c);
      }
    }
    // 再ラベル: セグメント合計クロマでコード種を精緻化(トライアド簡略化込み)
    for (const c of cleaned) {
      const vec = new Array(12).fill(0);
      for (let b = c.startBeat; b < Math.min(c.endBeat, beatChroma.length); b++) {
        for (let pc = 0; pc < 12; pc++) vec[pc] += beatChroma[b][pc];
      }
      const m = Theory.matchChord(vec, null);
      if (m && m.root === c.root) {
        c.suffix = m.suffix;
        c.intervals = m.intervals;
      }
    }

    /* ---------- キー判定: 検出コードのコードトーンから ---------- */
    let key;
    if (cleaned.length > 0) {
      const hist = new Array(12).fill(0);
      for (const c of cleaned) {
        const durW = c.endBeat - c.startBeat;
        c.intervals.forEach((iv, i) => {
          hist[(c.root + iv) % 12] += durW * (i === 0 ? 1.5 : 1);
        });
      }
      key = Theory.detectKey(hist);
    } else {
      const hist = new Array(12).fill(0);
      for (const v of chroma) for (let pc = 0; pc < 12; pc++) hist[pc] += v[pc];
      key = Theory.detectKey(hist);
    }

    for (const c of cleaned) {
      c.label = Theory.chordLabel(c.root, c.suffix, key, null);
      c.degree = Theory.degreeName(c.root, c.suffix, key);
    }

    /* ---------- 小節頭(1拍目)の推定 ----------
     * ビート格子のどの拍が小節の頭かは自動では決まらないため、
     * 「コードチェンジが最も多く乗る拍」を1拍目とみなして格子をずらす。
     * これでコードが小節の頭に揃い、小節番号も演奏と一致しやすくなる。 */
    const changeCnt = [0, 0, 0, 0];
    for (const c of cleaned) changeCnt[((c.startBeat % 4) + 4) % 4]++;
    let kShift = 0;
    for (let i = 1; i < 4; i++) if (changeCnt[i] > changeCnt[kShift]) kShift = i;
    // 明確な多数決のときだけシフト(誤検出で先頭小節を失わないための保険)
    const totalChanges = changeCnt.reduce((a, b) => a + b, 0);
    if (kShift > 0 &&
        !(changeCnt[kShift] >= changeCnt[0] * 1.5 && changeCnt[kShift] >= totalChanges * 0.4)) {
      kShift = 0;
    }
    if (kShift > 0 && beatTimes.length > kShift + 4) {
      beatTimes = beatTimes.slice(kShift);
      const adjusted = [];
      for (const c of cleaned) {
        const e = c.endBeat - kShift;
        if (e <= 0) continue;
        c.startBeat = Math.max(0, c.startBeat - kShift);
        c.endBeat = e;
        if (c.startBeat === 0) c.startSec = beatTimes[0];
        adjusted.push(c);
      }
      cleaned.length = 0;
      cleaned.push(...adjusted);
    }

    if (progressCb) progressCb(1);
    return {
      source: 'audio',
      duration, bpm, key,
      beatsPerBar: 4, timeSig: { num: 4, den: 4 },
      totalBars: Math.max(1, Math.ceil((beatTimes.length - 1) / 4)),
      beatTimes,
      chords: cleaned,
    };
  }

  function downmix(buf) {
    const n = buf.length;
    const out = new Float32Array(n);
    for (let ch = 0; ch < buf.numberOfChannels; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < n; i++) out[i] += d[i] / buf.numberOfChannels;
    }
    return out;
  }

  /* ---------- BPM推定: onset flux 自己相関 + コムフィルタ ---------- */
  function estimateBeats(flux, frameDur, duration) {
    const n = flux.length;
    // 正規化 & ローカル平均差分
    const dif = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let m = 0, c = 0;
      for (let j = Math.max(0, i - 8); j < Math.min(n, i + 8); j++) { m += flux[j]; c++; }
      dif[i] = Math.max(0, flux[i] - m / c);
    }
    // 鋭いオンセット(生ドラム等)でも±1フレームのずれを許容できるよう平滑化
    const KERNEL = [0.3, 0.7, 1, 0.7, 0.3];
    const env = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let k = -2; k <= 2; k++) {
        const j = i + k;
        if (j >= 0 && j < n) s += dif[j] * KERNEL[k + 2];
      }
      env[i] = s;
    }
    function combScore(bpmCand) {
      const lag = 60 / bpmCand / frameDur;
      let s = 0, c = 0;
      for (let i = 0; i + Math.round(lag * 4) < n; i++) {
        s += env[i] * (env[i + Math.round(lag)] + 0.5 * env[i + Math.round(lag * 2)] + 0.25 * env[i + Math.round(lag * 4)]);
        c++;
      }
      if (c === 0) return 0;
      // 中庸なテンポを優先
      const pref = Math.exp(-Math.pow((bpmCand - 118) / 55, 2) * 0.5);
      return (s / c) * (0.75 + 0.25 * pref);
    }
    let best = { bpm: 120, score: -1 };
    for (let bpmCand = 60; bpmCand <= 190; bpmCand += 0.5) {
      const s = combScore(bpmCand);
      if (s > best.score) best = { bpm: bpmCand, score: s };
    }
    // 半分テンポに落ちていないか判定。
    // オンセット間隔の中央値が推定ビートの約半分なら、実際は2倍テンポとみなす
    let peakThresh = 0;
    for (let i = 0; i < n; i++) peakThresh = Math.max(peakThresh, env[i]);
    peakThresh *= 0.18;
    const onsetFrames = [];
    for (let i = 2; i < n - 2; i++) {
      if (env[i] > peakThresh && env[i] >= env[i - 1] && env[i] >= env[i + 1] &&
          (onsetFrames.length === 0 || i - onsetFrames[onsetFrames.length - 1] > 2)) {
        onsetFrames.push(i);
      }
    }
    const iois = [];
    for (let i = 1; i < onsetFrames.length; i++) iois.push((onsetFrames[i] - onsetFrames[i - 1]) * frameDur);
    iois.sort((a, b) => a - b);
    const medianIOI = iois.length ? iois[Math.floor(iois.length / 2)] : 0;
    if (best.bpm * 2 <= 160) {
      const dbl = combScore(best.bpm * 2);
      const beatDurBest = 60 / best.bpm;
      const halfTempoSuspect = medianIOI > 0 && Math.abs(medianIOI - beatDurBest / 2) < beatDurBest * 0.12;
      if (dbl >= best.score * 0.9 || (halfTempoSuspect && dbl >= best.score * 0.6)) {
        best = { bpm: best.bpm * 2, score: dbl };
      }
    }
    const bpm = Math.round(best.bpm * 10) / 10;
    const beatDur = 60 / bpm;

    /* ---------- 動的計画法ビートトラッキング ----------
     * 一定テンポの格子を全曲に当てはめるのではなく、実際に鳴っている
     * オンセットを1拍ずつ追跡する(Ellis方式)。テンポの揺れや前奏の
     * タメにも追従するので、表示と演奏のタイミングが合う。 */
    let maxE = 1e-9;
    for (let i = 0; i < n; i++) maxE = Math.max(maxE, env[i]);
    const nrm = new Float64Array(n);
    for (let i = 0; i < n; i++) nrm[i] = env[i] / maxE;

    const P = beatDur / frameDur; // 期待周期(フレーム)
    const score = new Float64Array(n);
    const from = new Int32Array(n).fill(-1);
    const TIGHT = 1.6; // 周期からの逸脱ペナルティの強さ
    for (let i = 0; i < n; i++) {
      score[i] = nrm[i];
      const j0 = Math.max(0, Math.floor(i - 2.2 * P));
      const j1 = Math.floor(i - P * 0.45);
      for (let j = j0; j <= j1; j++) {
        if (j < 0) continue;
        const dev = Math.log((i - j) / P);
        const s = score[j] - TIGHT * dev * dev + nrm[i];
        if (s > score[i]) { score[i] = s; from[i] = j; }
      }
    }
    let end = n - 1, bestS = -Infinity;
    for (let i = Math.max(0, n - Math.ceil(2.5 * P)); i < n; i++) {
      if (score[i] > bestS) { bestS = score[i]; end = i; }
    }
    const beatFrames = [];
    for (let i = end; i >= 0; i = from[i]) {
      beatFrames.push(i);
      if (from[i] < 0) break;
    }
    beatFrames.reverse();
    let beatTimes = beatFrames.map(fi => fi * frameDur);
    if (beatTimes.length < 4) {
      // フォールバック: 一定格子
      beatTimes = [];
      for (let t = 0; t <= duration; t += beatDur) beatTimes.push(t);
    }
    // 前奏・アウトロは局所周期で外挿して全曲をカバー
    const headP = Math.min(Math.max(beatTimes[1] - beatTimes[0], beatDur * 0.5) || beatDur, beatDur * 1.5);
    while (beatTimes[0] > headP * 0.55) beatTimes.unshift(Math.max(0, beatTimes[0] - headP));
    const last2 = () => beatTimes.length - 2;
    const tailP = Math.min(Math.max(beatTimes[last2() + 1] - beatTimes[last2()], beatDur * 0.5) || beatDur, beatDur * 1.5);
    while (beatTimes[beatTimes.length - 1] < duration - tailP * 0.5) {
      beatTimes.push(beatTimes[beatTimes.length - 1] + tailP);
    }
    return { bpm, beatTimes };
  }

  /* ---------- Viterbi コード平滑化 ---------- */
  // 状態: 12ルート × {maj, min, 7, M7, m7} = 60
  const VITERBI_QUALITIES = [
    { suffix: '',   intervals: [0, 4, 7],     bonus: 0.020 },
    { suffix: 'm',  intervals: [0, 3, 7],     bonus: 0.020 },
    { suffix: '7',  intervals: [0, 4, 7, 10], bonus: 0.000 },
    { suffix: 'M7', intervals: [0, 4, 7, 11], bonus: 0.000 },
    { suffix: 'm7', intervals: [0, 3, 7, 10], bonus: 0.000 },
  ];
  const VITERBI_STATES = [];
  for (let root = 0; root < 12; root++) {
    for (const q of VITERBI_QUALITIES) {
      VITERBI_STATES.push({ root, suffix: q.suffix, intervals: q.intervals, bonus: q.bonus });
    }
  }

  function emissionScores(vec) {
    const total = vec.reduce((a, b) => a + b, 0);
    if (total <= 0) return null;
    const w = vec.map(v => v / total);
    const scores = new Float32Array(VITERBI_STATES.length);
    for (let s = 0; s < VITERBI_STATES.length; s++) {
      const st = VITERBI_STATES[s];
      let sc = 0;
      const inChord = new Array(12).fill(false);
      for (let i = 0; i < st.intervals.length; i++) {
        const pc = (st.root + st.intervals[i]) % 12;
        inChord[pc] = true;
        sc += w[pc] * (i === 0 ? 1.0 : i === 1 ? 0.85 : i === 2 ? 0.6 : 0.5);
      }
      for (let pc = 0; pc < 12; pc++) if (!inChord[pc]) sc -= w[pc] * 0.38;
      scores[s] = sc + st.bonus;
    }
    return scores;
  }

  function viterbiChords(beatChroma) {
    const T = beatChroma.length;
    const S = VITERBI_STATES.length;
    if (T === 0) return [];
    const SWITCH_PENALTY = 0.10; // コードチェンジのコスト(平滑化の強さ)
    let prev = new Float32Array(S);
    const back = [];
    const emis0 = emissionScores(beatChroma[0]);
    for (let s = 0; s < S; s++) prev[s] = emis0 ? emis0[s] : 0;

    for (let t = 1; t < T; t++) {
      const emis = emissionScores(beatChroma[t]);
      const cur = new Float32Array(S);
      const bk = new Int16Array(S);
      let maxPrev = -Infinity, maxIdx = 0;
      for (let s = 0; s < S; s++) {
        if (prev[s] > maxPrev) { maxPrev = prev[s]; maxIdx = s; }
      }
      for (let s = 0; s < S; s++) {
        const stay = prev[s];
        const sw = maxPrev - SWITCH_PENALTY;
        if (stay >= sw) { cur[s] = stay; bk[s] = s; }
        else { cur[s] = sw; bk[s] = maxIdx; }
        cur[s] += emis ? emis[s] : 0;
      }
      back.push(bk);
      prev = cur;
    }
    // バックトラック
    let bestS = 0, bestV = -Infinity;
    for (let s = 0; s < S; s++) if (prev[s] > bestV) { bestV = prev[s]; bestS = s; }
    const path = new Array(T);
    path[T - 1] = bestS;
    for (let t = T - 2; t >= 0; t--) path[t] = back[t][path[t + 1]];
    // 無音ビートは null
    return path.map((s, t) => {
      const total = beatChroma[t].reduce((a, b) => a + b, 0);
      return total < 1e-4 ? null : s;
    });
  }

  return { analyze, analyzeMono, fft };
})();
