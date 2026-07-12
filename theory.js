/* =========================================================
 * theory.js — 音楽理論コア
 * 音名・コードテンプレート・キー判定・ディグリー・ギターコードフォーム
 * すべて端末内で完結。外部依存なし。
 * ======================================================= */
'use strict';

const Theory = (() => {

  const NOTE_SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const NOTE_FLAT  = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
  // 環境による文字化けを避けるため記号はASCII(# / b)で表記
  const DOREMI_SHARP = ['ド', 'ド#', 'レ', 'レ#', 'ミ', 'ファ', 'ファ#', 'ソ', 'ソ#', 'ラ', 'ラ#', 'シ'];
  const DOREMI_FLAT  = ['ド', 'レb', 'レ', 'ミb', 'ミ', 'ファ', 'ソb', 'ソ', 'ラb', 'ラ', 'シb', 'シ'];

  // フラット表記を使うキー(メジャートニックのpc)
  const FLAT_KEYS = new Set([5, 10, 3, 8, 1, 6]); // F, Bb, Eb, Ab, Db, Gb

  /* ---------- コードテンプレート ---------- */
  // intervals: ルートからの半音、weight: 判定時の優先度ボーナス
  const CHORD_TYPES = [
    { suffix: '',      intervals: [0, 4, 7],        bonus: 0.030 },
    { suffix: 'm',     intervals: [0, 3, 7],        bonus: 0.030 },
    { suffix: '7',     intervals: [0, 4, 7, 10],    bonus: 0.012 },
    { suffix: 'M7',    intervals: [0, 4, 7, 11],    bonus: 0.012 },
    { suffix: 'm7',    intervals: [0, 3, 7, 10],    bonus: 0.012 },
    { suffix: 'mM7',   intervals: [0, 3, 7, 11],    bonus: 0.000 },
    { suffix: '6',     intervals: [0, 4, 7, 9],     bonus: 0.000 },
    { suffix: 'm6',    intervals: [0, 3, 7, 9],     bonus: 0.000 },
    { suffix: 'sus4',  intervals: [0, 5, 7],        bonus: 0.004 },
    { suffix: 'sus2',  intervals: [0, 2, 7],        bonus: 0.002 },
    { suffix: '7sus4', intervals: [0, 5, 7, 10],    bonus: 0.000 },
    { suffix: 'add9',  intervals: [0, 4, 7, 2],     bonus: 0.000 },
    { suffix: 'dim',   intervals: [0, 3, 6],        bonus: 0.000 },
    { suffix: 'm7-5',  intervals: [0, 3, 6, 10],    bonus: 0.000 },
    { suffix: 'dim7',  intervals: [0, 3, 6, 9],     bonus: 0.000 },
    { suffix: 'aug',   intervals: [0, 4, 8],        bonus: 0.000 },
  ];

  // 各コードトーンの重み(ルート・3度を重視)
  function toneWeight(idx, len) {
    if (idx === 0) return 1.0;   // root
    if (idx === 1) return 0.85;  // 3rd (or sus tone)
    if (idx === 2) return 0.65;  // 5th
    return 0.55;                 // 7th / tension
  }

  /* ---------- 名前ユーティリティ ---------- */
  function pcName(pc, useFlat) {
    pc = ((pc % 12) + 12) % 12;
    return (useFlat ? NOTE_FLAT : NOTE_SHARP)[pc];
  }
  function doremi(pc, useFlat) {
    pc = ((pc % 12) + 12) % 12;
    return (useFlat ? DOREMI_FLAT : DOREMI_SHARP)[pc];
  }
  function midiToName(midi, useFlat) {
    const oct = Math.floor(midi / 12) - 1;
    return pcName(midi % 12, useFlat) + oct;
  }

  /* ---------- キー判定 (Krumhansl-Schmuckler) ---------- */
  const KS_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
  const KS_MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

  function detectKey(pcHist) {
    const total = pcHist.reduce((a, b) => a + b, 0) || 1;
    const h = pcHist.map(v => v / total);
    let best = { tonic: 0, mode: 'major', score: -Infinity };
    for (let t = 0; t < 12; t++) {
      let sMaj = 0, sMin = 0;
      for (let i = 0; i < 12; i++) {
        sMaj += h[(t + i) % 12] * KS_MAJOR[i];
        sMin += h[(t + i) % 12] * KS_MINOR[i];
      }
      if (sMaj > best.score) best = { tonic: t, mode: 'major', score: sMaj };
      if (sMin > best.score) best = { tonic: t, mode: 'minor', score: sMin };
    }
    return best;
  }

  function keyLabel(key) {
    const useFlat = key.mode === 'major' ? FLAT_KEYS.has(key.tonic)
                                         : FLAT_KEYS.has((key.tonic + 3) % 12);
    const name = pcName(key.tonic, useFlat);
    return key.mode === 'major' ? `${name} メジャー` : `${name} マイナー`;
  }

  function keyUsesFlat(key) {
    if (!key) return false;
    return key.mode === 'major' ? FLAT_KEYS.has(key.tonic)
                                : FLAT_KEYS.has((key.tonic + 3) % 12);
  }

  /* ---------- ディグリーネーム (文字化け対策でASCII表記) ---------- */
  const ROMAN = ['I', 'bII', 'II', 'bIII', 'III', 'IV', 'bV', 'V', 'bVI', 'VI', 'bVII', 'VII'];
  const ROMAN_MINOR = ['I', 'bII', 'II', 'III', '#III', 'IV', 'bV', 'V', 'VI', '#VI', 'VII', '#VII'];

  function degreeName(rootPc, suffix, key) {
    if (!key) return '';
    const iv = ((rootPc - key.tonic) % 12 + 12) % 12;
    const table = key.mode === 'minor' ? ROMAN_MINOR : ROMAN;
    return table[iv] + suffix;
  }

  /* ---------- コード判定(ピッチクラス重みベクトル → コード) ---------- */
  // weights: 12要素(正規化不要)。bassPc: 最低音のpc(null可)
  function matchChord(weights, bassPc) {
    const total = weights.reduce((a, b) => a + b, 0);
    if (total <= 0) return null;
    const w = weights.map(v => v / total);
    let best = null;
    for (let root = 0; root < 12; root++) {
      for (const ct of CHORD_TYPES) {
        let score = 0;
        const inChord = new Array(12).fill(false);
        for (let i = 0; i < ct.intervals.length; i++) {
          const pc = (root + ct.intervals[i]) % 12;
          inChord[pc] = true;
          score += w[pc] * toneWeight(i, ct.intervals.length);
        }
        for (let pc = 0; pc < 12; pc++) {
          if (!inChord[pc]) score -= w[pc] * 0.42;
        }
        score += ct.bonus;
        if (bassPc !== null && bassPc !== undefined) {
          if (bassPc === root) score += 0.025;
          else if (inChord[bassPc]) score += 0.005;
        }
        if (!best || score > best.score) {
          best = { root, suffix: ct.suffix, score, intervals: ct.intervals };
        }
      }
    }
    // 僅差ならシンプルなトライアド表記を優先(コード表として読みやすく)
    if (best && best.suffix !== '' && best.suffix !== 'm') {
      const isMinorish = best.intervals.includes(3);
      const triad = CHORD_TYPES.find(ct => ct.suffix === (isMinorish ? 'm' : ''));
      let tScore = 0;
      const inChord = new Array(12).fill(false);
      for (let i = 0; i < triad.intervals.length; i++) {
        const pc = (best.root + triad.intervals[i]) % 12;
        inChord[pc] = true;
        tScore += w[pc] * toneWeight(i, triad.intervals.length);
      }
      for (let pc = 0; pc < 12; pc++) if (!inChord[pc]) tScore -= w[pc] * 0.42;
      tScore += triad.bonus;
      if (best.score - tScore < 0.04) {
        best = { root: best.root, suffix: triad.suffix, score: best.score, intervals: triad.intervals };
      }
    }
    return best;
  }

  function chordLabel(root, suffix, key, bassPc) {
    const useFlat = keyUsesFlat(key);
    let label = pcName(root, useFlat) + suffix;
    if (bassPc !== null && bassPc !== undefined && bassPc !== root) {
      const iv = ((bassPc - root) % 12 + 12) % 12;
      // コードトーンのオンコードのみ表記
      label += '/' + pcName(bassPc, useFlat);
    }
    return label;
  }

  /* ---------- ギターコードフォーム ---------- */
  // frets: 6弦(低E)→1弦(高e) の順。-1 = ミュート
  const OPEN_SHAPES = {
    'C':      [-1, 3, 2, 0, 1, 0],
    'A':      [-1, 0, 2, 2, 2, 0],
    'G':      [3, 2, 0, 0, 0, 3],
    'E':      [0, 2, 2, 1, 0, 0],
    'D':      [-1, -1, 0, 2, 3, 2],
    'F':      [1, 3, 3, 2, 1, 1],
    'B':      [-1, 2, 4, 4, 4, 2],
    'Am':     [-1, 0, 2, 2, 1, 0],
    'Em':     [0, 2, 2, 0, 0, 0],
    'Dm':     [-1, -1, 0, 2, 3, 1],
    'Bm':     [-1, 2, 4, 4, 3, 2],
    'F#m':    [2, 4, 4, 2, 2, 2],
    'C7':     [-1, 3, 2, 3, 1, 0],
    'A7':     [-1, 0, 2, 0, 2, 0],
    'G7':     [3, 2, 0, 0, 0, 1],
    'E7':     [0, 2, 0, 1, 0, 0],
    'D7':     [-1, -1, 0, 2, 1, 2],
    'B7':     [-1, 2, 1, 2, 0, 2],
    'Am7':    [-1, 0, 2, 0, 1, 0],
    'Em7':    [0, 2, 0, 0, 0, 0],
    'Dm7':    [-1, -1, 0, 2, 1, 1],
    'Bm7':    [-1, 2, 0, 2, 0, 2],
    'CM7':    [-1, 3, 2, 0, 0, 0],
    'AM7':    [-1, 0, 2, 1, 2, 0],
    'GM7':    [3, 2, 0, 0, 0, 2],
    'EM7':    [0, 2, 1, 1, 0, 0],
    'DM7':    [-1, -1, 0, 2, 2, 2],
    'FM7':    [-1, -1, 3, 2, 1, 0],
    'Asus4':  [-1, 0, 2, 2, 3, 0],
    'Dsus4':  [-1, -1, 0, 2, 3, 3],
    'Esus4':  [0, 2, 2, 2, 0, 0],
    'Gsus4':  [3, 3, 0, 0, 1, 3],
    'Asus2':  [-1, 0, 2, 2, 0, 0],
    'Dsus2':  [-1, -1, 0, 2, 3, 0],
    'Cadd9':  [-1, 3, 2, 0, 3, 0],
    'Gadd9':  [3, 0, 0, 2, 0, 3],
    'C6':     [-1, 3, 2, 2, 1, 0],
    'A6':     [-1, 0, 2, 2, 2, 2],
    'Am6':    [-1, 0, 2, 2, 1, 2],
    'Em6':    [0, 2, 2, 0, 2, 0],
    'A7sus4': [-1, 0, 2, 0, 3, 0],
    'E7sus4': [0, 2, 0, 2, 0, 0],
  };

  // ムーバブルフォーム: rootString 6 or 5(そのフレットがルート)
  // rel: バレーフレットからの相対。-1 = ミュート
  const MOVABLE_SHAPES = {
    '':      [{ rs: 6, rel: [0, 2, 2, 1, 0, 0] },  { rs: 5, rel: [-1, 0, 2, 2, 2, 0] }],
    'm':     [{ rs: 6, rel: [0, 2, 2, 0, 0, 0] },  { rs: 5, rel: [-1, 0, 2, 2, 1, 0] }],
    '7':     [{ rs: 6, rel: [0, 2, 0, 1, 0, 0] },  { rs: 5, rel: [-1, 0, 2, 0, 2, 0] }],
    'M7':    [{ rs: 5, rel: [-1, 0, 2, 1, 2, 0] }, { rs: 6, rel: [0, 2, 1, 1, 0, -1] }],
    'm7':    [{ rs: 6, rel: [0, 2, 0, 0, 0, 0] },  { rs: 5, rel: [-1, 0, 2, 0, 1, 0] }],
    'mM7':   [{ rs: 5, rel: [-1, 0, 2, 1, 1, 0] }],
    '6':     [{ rs: 5, rel: [-1, 0, 2, 2, 2, 2] }],
    'm6':    [{ rs: 5, rel: [-1, 0, 2, 2, 1, 2] }],
    'sus4':  [{ rs: 6, rel: [0, 2, 2, 2, 0, 0] },  { rs: 5, rel: [-1, 0, 2, 2, 3, 0] }],
    'sus2':  [{ rs: 5, rel: [-1, 0, 2, 2, 0, 0] }],
    '7sus4': [{ rs: 6, rel: [0, 2, 0, 2, 0, 0] },  { rs: 5, rel: [-1, 0, 2, 0, 3, 0] }],
    'add9':  [{ rs: 5, rel: [-1, 0, 2, 4, 2, 0] }],
    'dim':   [{ rs: 5, rel: [-1, 0, 1, 2, 1, -1] }],
    'm7-5':  [{ rs: 5, rel: [-1, 0, 1, 0, 1, -1] }],
    'dim7':  [{ rs: 5, rel: [-1, 0, 1, -1, 1, -1] }],
    'aug':   [{ rs: 6, rel: [0, 3, 2, 1, 1, 0] }],
  };

  const GUITAR_TUNING = [40, 45, 50, 55, 59, 64]; // E2 A2 D3 G3 B3 E4 (弦6→1)
  const BASS_TUNING = [28, 33, 38, 43];           // E1 A1 D2 G2 (弦4→1)

  // オープンコード辞書にあるか(カポ提案用)
  function hasOpenShape(rootPc, suffix) {
    rootPc = ((rootPc % 12) + 12) % 12;
    return !!(OPEN_SHAPES[NOTE_SHARP[rootPc] + suffix] || OPEN_SHAPES[NOTE_FLAT[rootPc] + suffix]);
  }

  // コード名 → 押さえ方 { frets:[6..1], baseFret, barre }
  function guitarShape(rootPc, suffix, useFlat) {
    const nameS = NOTE_SHARP[rootPc] + suffix;
    const nameF = NOTE_FLAT[rootPc] + suffix;
    const open = OPEN_SHAPES[nameS] || OPEN_SHAPES[nameF];
    if (open) return normalizeShape(open);
    const forms = MOVABLE_SHAPES[suffix] || MOVABLE_SHAPES[''];
    let best = null;
    for (const f of forms) {
      const openPc = f.rs === 6 ? 4 : 9; // E or A
      let barreFret = ((rootPc - openPc) % 12 + 12) % 12;
      if (barreFret === 0) barreFret = 12;
      const frets = f.rel.map(r => (r < 0 ? -1 : r + barreFret));
      const cand = normalizeShape(frets);
      if (!best || cand.baseFret < best.baseFret) best = cand;
    }
    return best;
  }

  function normalizeShape(frets) {
    const active = frets.filter(f => f > 0);
    const minF = active.length ? Math.min(...active) : 0;
    const maxF = active.length ? Math.max(...active) : 0;
    const baseFret = maxF <= 4 ? 1 : minF;
    // バレー判定: 同フレットで3本以上 & それが最低フレット
    let barre = null;
    if (active.length >= 3) {
      const counts = {};
      for (const f of active) counts[f] = (counts[f] || 0) + 1;
      if (counts[minF] >= 3 && frets[5] === minF) {
        let from = 0;
        for (let i = 0; i < 6; i++) { if (frets[i] === minF) { from = i; break; } }
        barre = { fret: minF, from, to: 5 };
      }
    }
    return { frets, baseFret, barre };
  }

  /* ---------- フレット割当 (タブ譜用 動的計画法) ---------- */
  // events: [{time, pitches:[midi...]}] → [{time, notes:[{pitch,string,fret}]}]
  function assignFrets(events, tuning, maxFret) {
    maxFret = maxFret || 19;
    const nStrings = tuning.length;
    let prevPos = 3; // ハンドポジション(フレット)
    const out = [];
    for (const ev of events) {
      const pitches = [...ev.pitches].sort((a, b) => a - b);
      const combo = bestCombo(pitches, tuning, maxFret, prevPos);
      if (combo) {
        const frets = combo.filter(c => c.fret > 0).map(c => c.fret);
        if (frets.length) prevPos = Math.round(frets.reduce((a, b) => a + b, 0) / frets.length);
        out.push({ time: ev.time, dur: ev.dur, notes: combo });
      } else {
        out.push({ time: ev.time, dur: ev.dur, notes: [] });
      }
    }
    return out;
  }

  function bestCombo(pitches, tuning, maxFret, prevPos) {
    const nStrings = tuning.length;
    // 各音の候補 (string, fret)
    const cands = pitches.map(p => {
      const list = [];
      for (let s = 0; s < nStrings; s++) {
        const fret = p - tuning[s];
        if (fret >= 0 && fret <= maxFret) list.push({ pitch: p, string: s, fret });
      }
      return list;
    });
    if (cands.some(c => c.length === 0)) {
      // 音域外の音はオクターブ調整
      for (let i = 0; i < cands.length; i++) {
        if (cands[i].length === 0) {
          let p = pitches[i];
          while (p < tuning[0]) p += 12;
          while (p > tuning[nStrings - 1] + maxFret) p -= 12;
          for (let s = 0; s < nStrings; s++) {
            const fret = p - tuning[s];
            if (fret >= 0 && fret <= maxFret) cands[i].push({ pitch: p, string: s, fret });
          }
        }
      }
    }
    // 貪欲+バックトラック(和音は最大6音)
    let best = null;
    const usedStrings = new Set();
    const chosen = [];
    function cost(sel) {
      let c = 0;
      const frets = sel.filter(x => x.fret > 0).map(x => x.fret);
      for (const x of sel) {
        if (x.fret === 0) c -= 0.4;                       // 開放弦ボーナス
        else c += Math.abs(x.fret - prevPos) * 0.55;      // ポジション移動
        c += x.fret * 0.12;                               // ハイフレット微ペナルティ
      }
      if (frets.length > 1) {
        const span = Math.max(...frets) - Math.min(...frets);
        c += span > 3 ? (span - 3) * 4 : span * 0.3;      // 指のスパン
      }
      c += (cands.length - sel.length) * 12;              // 音の脱落は大きなペナルティ
      return c;
    }
    function rec(i) {
      if (i === cands.length) {
        const c = cost(chosen);
        if (!best || c < best.cost) best = { cost: c, sel: chosen.slice() };
        return;
      }
      for (const cand of cands[i]) {
        if (usedStrings.has(cand.string)) continue;
        usedStrings.add(cand.string);
        chosen.push(cand);
        rec(i + 1);
        chosen.pop();
        usedStrings.delete(cand.string);
      }
      // 割当不能な音はスキップ(音数>弦数など)
      if (cands[i].every(c => usedStrings.has(c.string))) rec(i + 1);
    }
    rec(0);
    return best ? best.sel : null;
  }

  return {
    NOTE_SHARP, NOTE_FLAT, GUITAR_TUNING, BASS_TUNING, CHORD_TYPES,
    pcName, doremi, midiToName, detectKey, keyLabel, keyUsesFlat,
    degreeName, matchChord, chordLabel, guitarShape, hasOpenShape, assignFrets,
  };
})();
