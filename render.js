/* =========================================================
 * render.js — SVG描画エンジン
 * コードダイアグラム / ギターTAB / ベースTAB / 五線譜(ドレミ) / コード進行グリッド
 * ======================================================= */
'use strict';

const Renderer = (() => {

  const SVGNS = 'http://www.w3.org/2000/svg';

  function el(tag, attrs, parent) {
    const e = document.createElementNS(SVGNS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }
  function txt(parent, x, y, str, cls, anchor) {
    const t = el('text', { x, y, class: cls || '', 'text-anchor': anchor || 'middle' }, parent);
    t.textContent = str;
    return t;
  }

  /* =========================================
   * 1. ギターコードダイアグラム
   * shape: { frets:[6弦..1弦], baseFret, barre }
   * ======================================= */
  function chordDiagram(label, shape, opts) {
    opts = opts || {};
    const W = opts.width || 96, H = opts.height || 118;
    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chord-diagram', role: 'img', 'aria-label': label });
    const gridX = 18, gridY = 34, gridW = W - 30, gridH = H - 52;
    const nFrets = 4;
    const strW = gridW / 5, fretH = gridH / nFrets;

    txt(svg, W / 2, 16, label, 'cd-label');

    if (!shape) {
      txt(svg, W / 2, H / 2 + 10, '—', 'cd-fret-num');
      return svg;
    }
    const { frets, baseFret, barre } = shape;

    // ナット or ベースフレット
    if (baseFret === 1) {
      el('rect', { x: gridX - 1.5, y: gridY - 3.5, width: gridW + 3, height: 4, rx: 1.5, class: 'cd-nut' }, svg);
    } else {
      txt(svg, gridX - 9, gridY + fretH * 0.65, String(baseFret), 'cd-fret-num', 'middle');
    }
    // グリッド
    for (let s = 0; s < 6; s++) {
      el('line', { x1: gridX + s * strW, y1: gridY, x2: gridX + s * strW, y2: gridY + gridH, class: 'cd-line' }, svg);
    }
    for (let f = 0; f <= nFrets; f++) {
      el('line', { x1: gridX, y1: gridY + f * fretH, x2: gridX + gridW, y2: gridY + f * fretH, class: 'cd-line' }, svg);
    }
    // バレー
    if (barre) {
      const relF = barre.fret - baseFret;
      if (relF >= 0 && relF < nFrets) {
        const y = gridY + (relF + 0.5) * fretH;
        const x1 = gridX + barre.from * strW;
        el('rect', { x: x1 - 6, y: y - 5.5, width: (5 - barre.from) * strW + 12, height: 11, rx: 5.5, class: 'cd-barre' }, svg);
        if (shape.fingers) txt(svg, x1 + ((5 - barre.from) * strW) / 2, y + 3, '1', 'cd-finger');
      }
    }
    // ドット / 開放 / ミュート (+推奨指番号)
    const fingers = shape.fingers || null;
    for (let i = 0; i < 6; i++) { // i=0 が6弦(左端)
      const x = gridX + i * strW;
      const f = frets[i];
      if (f === -1) {
        txt(svg, x, gridY - 8, '×', 'cd-mute');
      } else if (f === 0) {
        el('circle', { cx: x, cy: gridY - 11, r: 3.6, class: 'cd-open' }, svg);
      } else {
        const relF = f - baseFret;
        if (relF >= 0 && relF < nFrets) {
          const y = gridY + (relF + 0.5) * fretH;
          if (!(barre && f === barre.fret && i >= barre.from)) {
            el('circle', { cx: x, cy: y, r: 6.2, class: 'cd-dot' }, svg);
            if (fingers && fingers[i] > 0) txt(svg, x, y + 3, String(fingers[i]), 'cd-finger');
          }
        }
      }
    }
    return svg;
  }

  /* 歌詞の文字配置: 歌い出し拍から通常の字間(約13px)で並べる。
   * 次の行の歌い出しに被る場合だけ字間を詰める。 */
  function buildLyricPlacements(lyrics, pxPerBeat, totalBeats) {
    if (!lyrics) return null;
    const placements = [];
    const charW = 13;
    const sung = lyrics.filter(l => !l.blank && l.text);
    for (let i = 0; i < sung.length; i++) {
      const chars = [...sung[i].text];
      const nextStart = i + 1 < sung.length ? sung[i + 1].startBeat : totalBeats;
      const avail = Math.max(1, nextStart - sung[i].startBeat - 0.2);
      const spacing = Math.min(charW / pxPerBeat, avail / chars.length);
      chars.forEach((ch, ci) => placements.push({ beat: sung[i].startBeat + ci * spacing, ch }));
    }
    return placements;
  }

  /* =========================================
   * 1b. ギターコードダイアグラム(横向き / TAB譜と同じ向き)
   * 1弦を上、6弦を下に描く。ギターコードTABモード専用。
   * shape: { frets:[6弦..1弦], baseFret, barre, fingers }
   * ======================================= */
  function chordDiagramTab(label, shape) {
    const W = 210, H = 140;
    const svg = el('svg', {
      viewBox: `0 0 ${W} ${H}`, class: 'chord-diagram-tab', role: 'img',
      'aria-label': `${label}のコードフォーム。1弦が上、6弦が下`,
    });
    txt(svg, W / 2, 16, label, 'cd-label');
    if (!shape) { txt(svg, W / 2, H / 2, '—', 'cd-fret-num'); return svg; }

    const stringNames = ['e', 'B', 'G', 'D', 'A', 'E']; // 1弦(上)→6弦(下)
    const LEFT = 40, TOP = 34, nFrets = 4, rowGap = 16;
    const gridW = W - 60, fretW = gridW / nFrets;
    const { frets, baseFret, barre, fingers } = shape;
    const rows = [...frets].reverse(); // frets:[6..1] → [1..6](上から)

    if (baseFret === 1) {
      el('line', { x1: LEFT, y1: TOP - 3, x2: LEFT, y2: TOP + 5 * rowGap + 3, class: 'cd-nut-tab' }, svg);
    } else {
      txt(svg, LEFT - 18, TOP + 2 * rowGap + 4, baseFret + 'f', 'cd-fret-num', 'middle');
    }
    for (let row = 0; row < 6; row++) {
      const y = TOP + row * rowGap;
      el('line', { x1: LEFT, y1: y, x2: LEFT + gridW, y2: y, class: 'cd-line' }, svg);
      txt(svg, LEFT - 26, y + 3, stringNames[row], 'cd-string-label', 'middle');
    }
    for (let f = 0; f <= nFrets; f++) {
      const x = LEFT + f * fretW;
      el('line', { x1: x, y1: TOP, x2: x, y2: TOP + 5 * rowGap, class: 'cd-line' }, svg);
    }
    if (barre) {
      const relF = barre.fret - baseFret;
      if (relF >= 0 && relF < nFrets) {
        const x = LEFT + (relF + 0.5) * fretW;
        const rowBottom = 5 - barre.from;
        el('line', { x1: x, y1: TOP, x2: x, y2: TOP + rowBottom * rowGap, class: 'cd-barre-tab' }, svg);
      }
    }
    rows.forEach((f, row) => {
      const y = TOP + row * rowGap;
      const arrayIdx = 5 - row;
      if (f === -1) { txt(svg, LEFT - 8, y + 3, '×', 'cd-mute'); return; }
      if (f === 0) { el('circle', { cx: LEFT - 8, cy: y, r: 3, class: 'cd-open' }, svg); return; }
      const relF = f - baseFret;
      if (relF >= 0 && relF < nFrets) {
        const x = LEFT + (relF + 0.5) * fretW;
        const onBarre = barre && f === barre.fret && arrayIdx >= barre.from;
        if (!onBarre) {
          el('circle', { cx: x, cy: y, r: 5.6, class: 'cd-dot' }, svg);
          if (fingers && fingers[arrayIdx] > 0) txt(svg, x, y + 3, String(fingers[arrayIdx]), 'cd-finger-tab');
        }
      }
    });
    return svg;
  }

  /* =========================================
   * 2. TAB譜 (ギター6弦 / ベース4弦)
   * events: [{time(beat), dur, notes:[{string, fret}]}]  string:0=最低弦
   * chords: コード進行(ギターのみ表示)
   * ======================================= */
  function tabSVG(events, opts) {
    const nStrings = opts.strings;             // 6 or 4
    const stringNames = opts.stringNames;       // 表示上段から順
    const flip = !!opts.flip;                   // true = 低音弦を上に
    const tuning = opts.tuning || null;         // グリス先フレット計算用
    const beatsPerBar = opts.beatsPerBar || 4;
    const totalBars = opts.totalBars;
    const chords = opts.chords || null;
    const barsPerRow = opts.barsPerRow || 4;
    const showStrum = !!opts.showStrum;         // ギターのみ: ストロークパターンの目安を表示
    const strumFill = !!opts.strumFill;         // 全8分スロットにストローク記号(コード弾き用)
    const rhythm = !!opts.rhythm;               // 譜面下にリズム符幹(4分/8分)を表示
    const lyrics = opts.lyrics || null;         // 歌詞行 [{text, startBeat, endBeat}]
    const CELL = 13;                             // 16分音符1つの幅
    const divPerBeat = 4;
    const divPerBar = beatsPerBar * divPerBeat;
    const barW = divPerBar * CELL + 14;
    const LEFT = 34, TOP = 30;
    const lineGap = 15;
    const staffH = (nStrings - 1) * lineGap;
    const topPad = showStrum ? 34 : 20;          // 段の先頭〜1弦線までの余白
    const rowGap = staffH + 74 + (showStrum ? 14 : 0) + (rhythm ? 8 : 0) + (lyrics ? 20 : 0);
    const nRows = Math.ceil(totalBars / barsPerRow);
    const W = LEFT + barsPerRow * barW + 16;
    const H = TOP + nRows * rowGap + 10;

    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, class: 'tab-svg score-svg', role: 'img' });
    el('rect', { x: 0, y: 0, width: W, height: H, class: 'score-bg' }, svg);

    // 量子化: beat → 16分グリッド
    const grid = new Map(); // "div" → notes[]
    for (const ev of events) {
      const div = Math.round(ev.time * divPerBeat);
      if (!grid.has(div)) grid.set(div, []);
      for (const n of ev.notes) grid.get(div).push(n);
    }

    // 歌詞の文字配置を先に計算(通常の字間で、次の行に被るときだけ詰める)
    const lyricPlacements = buildLyricPlacements(lyrics, barW / beatsPerBar, totalBars * beatsPerBar);

    for (let row = 0; row < nRows; row++) {
      const y0 = TOP + row * rowGap + topPad;
      const rowBars = Math.min(barsPerRow, totalBars - row * barsPerRow);
      const rowW = rowBars * barW;
      // 弦
      for (let s = 0; s < nStrings; s++) {
        el('line', { x1: LEFT, y1: y0 + s * lineGap, x2: LEFT + rowW, y2: y0 + s * lineGap, class: 'tab-string' }, svg);
        txt(svg, LEFT - 14, y0 + s * lineGap + 4, stringNames[s], 'tab-string-name', 'middle');
      }
      // 小節線 & 小節番号
      for (let b = 0; b <= rowBars; b++) {
        const x = LEFT + b * barW;
        el('line', { x1: x, y1: y0, x2: x, y2: y0 + staffH, class: 'tab-barline' }, svg);
        if (b < rowBars) txt(svg, x + 4, y0 - topPad + 6, String(row * barsPerRow + b + 1), 'bar-number', 'start');
      }
      // コードネーム: 各小節の頭 + 小節途中の変化点。
      // 直前と同じコード名が1小節以内に続く場合は省略し、
      // 近接するラベルは上段にずらして重なりを防ぐ
      if (chords) {
        const cands = new Map();
        for (let b = row * barsPerRow; b < row * barsPerRow + rowBars; b++) {
          const beat = b * beatsPerBar;
          const c = chords.find(c => c.startBeat <= beat + 0.01 && c.endBeat > beat + 0.01);
          if (c) cands.set(Math.round(beat * 4), { beat, label: c.label });
        }
        for (const c of chords) {
          const bar = Math.floor(c.startBeat / beatsPerBar + 1e-6);
          if (bar < row * barsPerRow || bar >= row * barsPerRow + rowBars) continue;
          cands.set(Math.round(c.startBeat * 4), { beat: c.startBeat, label: c.label });
        }
        const sorted = [...cands.values()].sort((a, b) => a.beat - b.beat);
        let lastLabel = null, lastBeat = -99, lastUp = false;
        for (const cd of sorted) {
          if (cd.label === lastLabel && cd.beat - lastBeat < beatsPerBar) continue;
          const close = cd.beat - lastBeat < 1.6;
          const up = close && !lastUp;
          const beatInRow = cd.beat - row * barsPerRow * beatsPerBar;
          const x = LEFT + (beatInRow / beatsPerBar) * barW + 4;
          txt(svg, x, y0 - (up ? 22 : 10), cd.label, 'tab-chord-name', 'start');
          lastLabel = cd.label; lastBeat = cd.beat; lastUp = up;
        }
      }
      // ストロークパターン(音源からの検出ではなく、8分音符ベースの一般的な目安)
      if (showStrum) {
        const divPerEighth = divPerBeat / 2;
        for (let bi = 0; bi < rowBars; bi++) {
          for (let e = 0; e < beatsPerBar * 2; e++) {
            const divStart = (row * barsPerRow + bi) * divPerBar + e * divPerEighth;
            if (!strumFill) {
              let hasNote = false;
              for (let d = divStart; d < divStart + divPerEighth; d++) if (grid.has(d)) { hasNote = true; break; }
              if (!hasNote) continue;
            }
            const x = LEFT + bi * barW + e * divPerEighth * CELL + 10;
            const y = y0 - 22;
            const down = e % 2 === 0;
            if (down) {
              el('path', { d: `M ${x - 4} ${y + 5} L ${x - 4} ${y - 3} L ${x + 4} ${y - 3} L ${x + 4} ${y + 5}`, class: 'strum-mark' }, svg);
            } else {
              el('path', { d: `M ${x - 4} ${y - 3} L ${x} ${y + 5} L ${x + 4} ${y - 3}`, class: 'strum-mark' }, svg);
            }
          }
        }
      }
      // リズム符幹: 4分=棒のみ / 8分=旗1 / 16分=旗2 (2分以上は棒なし)
      if (rhythm) {
        for (const ev of events) {
          const bar = Math.floor(ev.time / beatsPerBar + 1e-6);
          if (bar < row * barsPerRow || bar >= row * barsPerRow + rowBars) continue;
          const beatInRow = ev.time - row * barsPerRow * beatsPerBar;
          const x = LEFT + (beatInRow / beatsPerBar) * barW + 10;
          const dur = ev.dur || 1;
          if (dur >= 3.5) continue; // 全音符相当は棒なし
          const yTop = y0 + staffH + 5;
          const yBot = yTop + 13;
          el('line', { x1: x, y1: yTop, x2: x, y2: yBot, class: 'rhythm-stem' }, svg);
          const flags = dur < 0.4 ? 2 : (dur < 0.8 ? 1 : 0);
          for (let f = 0; f < flags; f++) {
            el('path', { d: `M ${x} ${yBot - f * 5} q 7 -2 8 -8`, class: 'rhythm-flag' }, svg);
          }
        }
      }
      // 歌詞: 歌い出し位置から通常の字間で表示(次の行と被る場合だけ詰める)
      if (lyricPlacements) {
        const lyricY = y0 + staffH + (rhythm ? 34 : 22);
        for (const pl of lyricPlacements) {
          const bar = Math.floor(pl.beat / beatsPerBar);
          if (bar < row * barsPerRow || bar >= row * barsPerRow + rowBars) continue;
          const beatInRow = pl.beat - row * barsPerRow * beatsPerBar;
          txt(svg, LEFT + (beatInRow / beatsPerBar) * barW + 10, lyricY, pl.ch, 'score-lyric');
        }
      }
      // 音符(フレット数字。グリス/チョーキングは 3/5 のように行き先も表記)
      for (const [div, notes] of grid) {
        const bar = Math.floor(div / divPerBar);
        if (bar < row * barsPerRow || bar >= row * barsPerRow + rowBars) continue;
        const divInRow = div - row * barsPerRow * divPerBar;
        const barIdx = Math.floor(divInRow / divPerBar);
        const x = LEFT + barIdx * barW + (divInRow % divPerBar) * CELL + 10;
        for (const n of notes) {
          const lineIdx = flip ? n.string : nStrings - 1 - n.string;
          const y = y0 + lineIdx * lineGap;
          let s = String(n.fret);
          if (n.artic && tuning) {
            const toFret = (n.toPitch !== null && n.toPitch !== undefined)
              ? n.toPitch - tuning[n.string] : null;
            if (toFret !== null && toFret >= 0 && toFret <= 22) {
              s += (n.artic === 'up' ? '/' : '\\') + toFret;
            }
          }
          el('rect', {
            x: x - s.length * 4 - 2, y: y - 6.5,
            width: s.length * 8 + 4, height: 13, class: 'tab-num-bg'
          }, svg);
          txt(svg, x, y + 4, s, 'tab-num');
        }
      }
    }

    // 再生カーソル(appのハイライトループが位置を更新する)。チョード名の上から譜表下まで貫く
    const cursor = el('line', { x1: -10, y1: 0, x2: -10, y2: 10, class: 'play-cursor' }, svg);
    svg.__cursor = cursor;
    svg.__beatPos = beat => {
      const bar = beat / beatsPerBar;
      const row = Math.max(0, Math.min(nRows - 1, Math.floor(bar / barsPerRow)));
      const barInRow = bar - row * barsPerRow;
      const y0 = TOP + row * rowGap + topPad;
      return {
        x: LEFT + barInRow * barW + 10,
        y1: y0 - topPad,
        y2: y0 + staffH + 4,
      };
    };
    return svg;
  }

  /* =========================================
   * 3. 五線譜 (お玉杓子 + ドレミ)
   * notes: [{beat, durBeat, pitch}]
   * ======================================= */
  function staffSVG(notes, opts) {
    const beatsPerBar = opts.beatsPerBar || 4;
    const totalBars = opts.totalBars;
    const chords = opts.chords || null;
    const useFlat = opts.useFlat || false;
    const barsPerRow = opts.barsPerRow || 4;
    const grand = opts.grand !== false; // 大譜表(ト音+ヘ音)
    const lyrics = opts.lyrics || null; // 歌詞行 [{text, startBeat, endBeat}]
    const CELL = 15;
    const divPerBeat = 4;
    const divPerBar = beatsPerBar * divPerBeat;
    const barW = divPerBar * CELL + 18;
    const LEFT = 44, TOP = 26;
    const SP = 9;                     // 五線の間隔
    const trebleH = 4 * SP;
    const gapStaves = 46;
    const bassTop = trebleH + gapStaves;
    const systemH = grand ? bassTop + 4 * SP : trebleH;
    const rowGap = systemH + 92 + (lyrics ? 20 : 0);
    const nRows = Math.ceil(totalBars / barsPerRow);
    const W = LEFT + barsPerRow * barW + 16;
    const H = TOP + nRows * rowGap + 20;

    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, class: 'staff-svg score-svg', role: 'img' });
    el('rect', { x: 0, y: 0, width: W, height: H, class: 'score-bg' }, svg);

    // pitch → 譜表ステップ(全音階)。シャープ/フラット判定込み
    function pitchToStep(pitch) {
      const pc = pitch % 12;
      const oct = Math.floor(pitch / 12) - 1;
      // 音名 → letter index (C=0..B=6) と臨時記号
      const SHARP_MAP = [[0, 0], [0, 1], [1, 0], [1, 1], [2, 0], [3, 0], [3, 1], [4, 0], [4, 1], [5, 0], [5, 1], [6, 0]];
      const FLAT_MAP  = [[0, 0], [1, -1], [1, 0], [2, -1], [2, 0], [3, 0], [4, -1], [4, 0], [5, -1], [5, 0], [6, -1], [6, 0]];
      const [letter, acc] = (useFlat ? FLAT_MAP : SHARP_MAP)[pc];
      return { step: oct * 7 + letter, acc };
    }

    // 量子化 & 行ごとに描画
    const qNotes = notes.map(n => ({
      div: Math.round(n.beat * divPerBeat),
      durDiv: Math.max(1, Math.round(n.durBeat * divPerBeat)),
      pitch: n.pitch,
    }));

    const lyricPlacements = buildLyricPlacements(lyrics, barW / beatsPerBar, totalBars * beatsPerBar);

    for (let row = 0; row < nRows; row++) {
      const y0 = TOP + row * rowGap + 34;
      const rowBars = Math.min(barsPerRow, totalBars - row * barsPerRow);
      const rowW = rowBars * barW;

      // 五線 (ト音)
      for (let l = 0; l < 5; l++) {
        el('line', { x1: LEFT, y1: y0 + l * SP, x2: LEFT + rowW, y2: y0 + l * SP, class: 'staff-line' }, svg);
      }
      txt(svg, LEFT - 24, y0 + trebleH * 0.72, '𝄞', 'clef');
      // 五線 (ヘ音)
      if (grand) {
        for (let l = 0; l < 5; l++) {
          el('line', { x1: LEFT, y1: y0 + bassTop + l * SP, x2: LEFT + rowW, y2: y0 + bassTop + l * SP, class: 'staff-line' }, svg);
        }
        txt(svg, LEFT - 24, y0 + bassTop + SP * 1.6, '𝄢', 'clef clef-bass');
      }
      // 小節線
      for (let b = 0; b <= rowBars; b++) {
        const x = LEFT + b * barW;
        el('line', { x1: x, y1: y0, x2: x, y2: y0 + (grand ? bassTop + 4 * SP : trebleH), class: 'staff-barline' }, svg);
        if (b < rowBars) txt(svg, x + 4, y0 - 26, String(row * barsPerRow + b + 1), 'bar-number', 'start');
      }
      // コードネーム: 小節頭+変化点。重複は省略、近接時は上段へずらす
      if (chords) {
        const cands = new Map();
        for (let b = row * barsPerRow; b < row * barsPerRow + rowBars; b++) {
          const beat = b * beatsPerBar;
          const c = chords.find(c => c.startBeat <= beat + 0.01 && c.endBeat > beat + 0.01);
          if (c) cands.set(Math.round(beat * 4), { beat, label: c.label });
        }
        for (const c of chords) {
          const bar = Math.floor(c.startBeat / beatsPerBar + 1e-6);
          if (bar < row * barsPerRow || bar >= row * barsPerRow + rowBars) continue;
          cands.set(Math.round(c.startBeat * 4), { beat: c.startBeat, label: c.label });
        }
        const sorted = [...cands.values()].sort((a, b) => a.beat - b.beat);
        let lastLabel = null, lastBeat = -99, lastUp = false;
        for (const cd of sorted) {
          if (cd.label === lastLabel && cd.beat - lastBeat < beatsPerBar) continue;
          const close = cd.beat - lastBeat < 1.6;
          const up = close && !lastUp;
          const beatInRow = cd.beat - row * barsPerRow * beatsPerBar;
          const x = LEFT + (beatInRow / beatsPerBar) * barW + 4;
          txt(svg, x, y0 - (up ? 24 : 12), cd.label, 'staff-chord-name', 'start');
          lastLabel = cd.label; lastBeat = cd.beat; lastUp = up;
        }
      }
      // 音符 (ラベルは列ごとにまとめて重なりを回避)
      const labelCols = new Map(); // "div" → {x, labels:[{pitch,label}]}
      for (const n of qNotes) {
        const bar = Math.floor(n.div / divPerBar);
        if (bar < row * barsPerRow || bar >= row * barsPerRow + rowBars) continue;
        const divInRow = n.div - row * barsPerRow * divPerBar;
        const barIdx = Math.floor(divInRow / divPerBar);
        const x = LEFT + barIdx * barW + (divInRow % divPerBar) * CELL + 12;

        const useBass = grand && n.pitch < 60;
        const { step, acc } = pitchToStep(n.pitch);
        // ト音: E4(step30)が下線 / ヘ音: G2(step18)が下線
        const bottomStep = useBass ? 18 : 30;
        const bottomY = useBass ? y0 + bassTop + 4 * SP : y0 + trebleH;
        const y = bottomY - (step - bottomStep) * (SP / 2);

        // 加線
        const stepsAbove = step - (bottomStep + 8);
        const stepsBelow = bottomStep - step;
        for (let s = 2; s <= stepsAbove; s += 2) {
          const ly = bottomY - (bottomStep + 8 + s - bottomStep) * (SP / 2);
          el('line', { x1: x - 9, y1: ly, x2: x + 9, y2: ly, class: 'staff-line' }, svg);
        }
        for (let s = 2; s <= stepsBelow; s += 2) {
          const ly = bottomY + s * (SP / 2);
          el('line', { x1: x - 9, y1: ly, x2: x + 9, y2: ly, class: 'staff-line' }, svg);
        }

        // 音価 → 見た目 (4=4分, 8=2分, 13以上=全音符相当)
        const d = n.durDiv;
        const hollow = d >= 7;
        const hasStem = d < 13;
        const flags = d < 4 ? (d < 2 ? 2 : 1) : 0;

        el('ellipse', {
          cx: x, cy: y, rx: 5.6, ry: 4.2,
          transform: `rotate(-18 ${x} ${y})`,
          class: hollow ? 'note-head hollow' : 'note-head'
        }, svg);
        if (acc !== 0) {
          txt(svg, x - 12, y + 4, acc > 0 ? '♯' : '♭', 'accidental');
        }
        if (hasStem) {
          const up = useBass ? (step < 22) : (step < 34);
          const sx = up ? x + 5.2 : x - 5.2;
          const sy2 = up ? y - 30 : y + 30;
          el('line', { x1: sx, y1: y, x2: sx, y2: sy2, class: 'note-stem' }, svg);
          for (let fl = 0; fl < flags; fl++) {
            const fy = up ? sy2 + fl * 7 : sy2 - fl * 7;
            el('path', {
              d: up
                ? `M ${sx} ${fy} q 9 3 7 14`
                : `M ${sx} ${fy} q 9 -3 7 -14`,
              class: 'note-flag'
            }, svg);
          }
        }
        // ドレミラベルは列ごとに収集
        const key = n.div;
        if (!labelCols.has(key)) labelCols.set(key, { x, labels: [] });
        labelCols.get(key).labels.push({ pitch: n.pitch, label: Theory.doremi(n.pitch % 12, useFlat) });
      }
      // 歌詞: 歌い出し位置から通常の字間で表示
      const staffBottom = grand ? y0 + bassTop + 4 * SP : y0 + trebleH;
      if (lyricPlacements) {
        const lyricY = staffBottom + 16;
        for (const pl of lyricPlacements) {
          const bar = Math.floor(pl.beat / beatsPerBar);
          if (bar < row * barsPerRow || bar >= row * barsPerRow + rowBars) continue;
          const beatInRow = pl.beat - row * barsPerRow * beatsPerBar;
          txt(svg, LEFT + (beatInRow / beatsPerBar) * barW + 12, lyricY, pl.ch, 'score-lyric');
        }
      }
      // ドレミラベル: 単音〜2音のときだけ表示(和音は上のコード名で読めるため省略)
      const labelBaseY = staffBottom + (lyricPlacements ? 34 : 18);
      for (const col of labelCols.values()) {
        if (col.labels.length > 2) continue;
        col.labels.sort((a, b) => a.pitch - b.pitch);
        col.labels.forEach((L, i) => {
          txt(svg, col.x, labelBaseY + i * 11, L.label, 'doremi-label');
        });
      }
    }

    // 再生カーソル
    const cursor = el('line', { x1: -10, y1: 0, x2: -10, y2: 10, class: 'play-cursor' }, svg);
    svg.__cursor = cursor;
    svg.__beatPos = beat => {
      const bar = beat / beatsPerBar;
      const row = Math.max(0, Math.min(nRows - 1, Math.floor(bar / barsPerRow)));
      const barInRow = bar - row * barsPerRow;
      const y0 = TOP + row * rowGap + 34;
      return {
        x: LEFT + barInRow * barW + 12,
        y1: y0 - 4,
        y2: y0 + (grand ? bassTop + 4 * SP : trebleH) + 4,
      };
    };
    return svg;
  }

  /* =========================================
   * 4. コード進行グリッド (U-FRET風)
   * ======================================= */
  function chordGrid(chords, opts) {
    const beatsPerBar = opts.beatsPerBar || 4;
    const totalBars = opts.totalBars;
    const showDegree = opts.showDegree !== false;
    const container = document.createElement('div');
    container.className = 'chord-grid';

    const bars = [];
    for (let b = 0; b < totalBars; b++) bars.push([]);
    // コード内のビート位置 → 秒 (線形補間)。チップごとに「その小節ぶん」の
    // 時間範囲を持たせ、再生ハイライトが常に1つだけ点くようにする
    const secAt = (c, beat) => {
      const span = c.endBeat - c.startBeat || 1;
      return c.startSec + (beat - c.startBeat) / span * ((c.endSec - c.startSec) || 0);
    };
    for (const c of chords) {
      const bar = Math.floor(c.startBeat / beatsPerBar);
      const segEnd = Math.min(c.endBeat, (bar + 1) * beatsPerBar);
      if (bar >= 0 && bar < totalBars) {
        bars[bar].push({ ...c, _segStartSec: c.startSec, _segEndSec: secAt(c, segEnd) });
      }
      // 複数小節にまたがるコード: 各小節ごとに独立したチップ(時間も小節ぶんだけ)
      for (let b2 = bar + 1; b2 < Math.floor((c.endBeat - 0.01) / beatsPerBar) + 1 && b2 < totalBars; b2++) {
        const bStart = b2 * beatsPerBar;
        const bEnd = Math.min(c.endBeat, (b2 + 1) * beatsPerBar);
        bars[b2].push({
          ...c, _cont: true, startBeat: bStart,
          _segStartSec: secAt(c, bStart), _segEndSec: secAt(c, bEnd),
        });
      }
    }

    for (let b = 0; b < totalBars; b++) {
      const cell = document.createElement('div');
      cell.className = 'chord-bar';
      cell.dataset.bar = b;
      const num = document.createElement('span');
      num.className = 'chord-bar-num';
      num.textContent = b + 1;
      cell.appendChild(num);
      const inner = document.createElement('div');
      inner.className = 'chord-bar-inner';
      const seen = new Set();
      for (const c of bars[b]) {
        const kk = c.label + ':' + c.startBeat;
        if (seen.has(kk)) continue;
        seen.add(kk);
        const chip = document.createElement('div');
        chip.className = 'chord-chip' + (c._cont ? ' cont' : '');
        chip.dataset.startSec = c._segStartSec !== undefined && !isNaN(c._segStartSec) ? c._segStartSec : '';
        chip.dataset.endSec = c._segEndSec !== undefined && !isNaN(c._segEndSec) ? c._segEndSec : '';
        const name = document.createElement('span');
        name.className = 'chord-chip-name';
        name.textContent = c.label; // 継続小節も薄い色でコード名を表示(小節頭で常に確認できるように)
        chip.appendChild(name);
        if (showDegree && !c._cont && c.degree) {
          const deg = document.createElement('span');
          deg.className = 'chord-chip-degree';
          deg.textContent = c.degree;
          chip.appendChild(deg);
        }
        inner.appendChild(chip);
      }
      if (bars[b].length === 0) {
        const rest = document.createElement('span');
        rest.className = 'chord-rest';
        rest.textContent = '・';
        inner.appendChild(rest);
      }
      cell.appendChild(inner);
      container.appendChild(cell);
    }
    return container;
  }

  /* =========================================
   * 5. 使用コード一覧(ダイアグラム帯)
   * ======================================= */
  function usedChordStrip(chords, key, transpose) {
    const strip = document.createElement('div');
    strip.className = 'used-chords';
    const seen = new Set();
    const useFlat = Theory.keyUsesFlat(key);
    for (const c of chords) {
      const root = ((c.root + (transpose || 0)) % 12 + 12) % 12;
      const label = Theory.pcName(root, useFlat) + c.suffix;
      if (seen.has(label)) continue;
      seen.add(label);
      const shape = Theory.guitarShape(root, c.suffix, useFlat);
      const holder = document.createElement('div');
      holder.className = 'used-chord';
      holder.appendChild(chordDiagram(label, shape));
      strip.appendChild(holder);
    }
    return strip;
  }

  /* SVG → PNG ダウンロード */
  function svgToPng(svgEl, fileName, scale) {
    scale = scale || 2;
    const vb = svgEl.viewBox.baseVal;
    const w = vb.width * scale, h = vb.height * scale;
    const clone = svgEl.cloneNode(true);
    // computed styleを埋め込む(外部CSS非依存のPNGにする)
    inlineStyles(svgEl, clone);
    const xml = new XMLSerializer().serializeToString(clone);
    const blob = new Blob([xml], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      canvas.toBlob(b => {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(b);
        a.download = fileName;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      }, 'image/png');
    };
    img.src = url;
  }

  const STYLE_PROPS = ['fill', 'stroke', 'stroke-width', 'font-size', 'font-family', 'font-weight', 'opacity', 'text-anchor'];
  function inlineStyles(src, dst) {
    const cs = getComputedStyle(src);
    let style = '';
    for (const p of STYLE_PROPS) style += `${p}:${cs.getPropertyValue(p)};`;
    dst.setAttribute('style', style);
    for (let i = 0; i < src.children.length; i++) {
      if (dst.children[i]) inlineStyles(src.children[i], dst.children[i]);
    }
  }

  return { chordDiagram, chordDiagramTab, tabSVG, staffSVG, chordGrid, usedChordStrip, svgToPng };
})();
