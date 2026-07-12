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
      }
    }
    // ドット / 開放 / ミュート
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
          }
        }
      }
    }
    return svg;
  }

  /* =========================================
   * 2. TAB譜 (ギター6弦 / ベース4弦)
   * events: [{time(beat), dur, notes:[{string, fret}]}]  string:0=最低弦
   * chords: コード進行(ギターのみ表示)
   * ======================================= */
  function tabSVG(events, opts) {
    const nStrings = opts.strings;             // 6 or 4
    const stringNames = opts.stringNames;       // ['e','B','G','D','A','E']等 (上から)
    const beatsPerBar = opts.beatsPerBar || 4;
    const totalBars = opts.totalBars;
    const chords = opts.chords || null;
    const barsPerRow = opts.barsPerRow || 4;
    const CELL = 13;                             // 16分音符1つの幅
    const divPerBeat = 4;
    const divPerBar = beatsPerBar * divPerBeat;
    const barW = divPerBar * CELL + 14;
    const LEFT = 34, TOP = 30;
    const lineGap = 15;
    const staffH = (nStrings - 1) * lineGap;
    const rowGap = staffH + 74;
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

    for (let row = 0; row < nRows; row++) {
      const y0 = TOP + row * rowGap + 20;
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
        if (b < rowBars) txt(svg, x + 4, y0 - 26, String(row * barsPerRow + b + 1), 'bar-number', 'start');
      }
      // コードネーム
      if (chords) {
        for (const c of chords) {
          const bar = Math.floor(c.startBeat / beatsPerBar);
          if (bar < row * barsPerRow || bar >= row * barsPerRow + rowBars) continue;
          const beatInRow = c.startBeat - row * barsPerRow * beatsPerBar;
          const x = LEFT + (beatInRow / beatsPerBar) * barW + 4;
          txt(svg, x, y0 - 10, c.label, 'tab-chord-name', 'start');
        }
      }
      // 音符(フレット数字)
      for (const [div, notes] of grid) {
        const bar = Math.floor(div / divPerBar);
        if (bar < row * barsPerRow || bar >= row * barsPerRow + rowBars) continue;
        const divInRow = div - row * barsPerRow * divPerBar;
        const barIdx = Math.floor(divInRow / divPerBar);
        const x = LEFT + barIdx * barW + (divInRow % divPerBar) * CELL + 10;
        for (const n of notes) {
          const lineIdx = nStrings - 1 - n.string; // string 0 = 最低弦 = 一番下
          const y = y0 + lineIdx * lineGap;
          const s = String(n.fret);
          el('rect', {
            x: x - s.length * 4 - 2, y: y - 6.5,
            width: s.length * 8 + 4, height: 13, class: 'tab-num-bg'
          }, svg);
          txt(svg, x, y + 4, s, 'tab-num');
        }
      }
    }
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
    const rowGap = systemH + 92;
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
      // コードネーム
      if (chords) {
        for (const c of chords) {
          const bar = Math.floor(c.startBeat / beatsPerBar);
          if (bar < row * barsPerRow || bar >= row * barsPerRow + rowBars) continue;
          const beatInRow = c.startBeat - row * barsPerRow * beatsPerBar;
          const x = LEFT + (beatInRow / beatsPerBar) * barW + 4;
          txt(svg, x, y0 - 12, c.label, 'staff-chord-name', 'start');
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
      // ドレミラベル描画: 同じ拍の音は下方向へ積む(低い音が上)
      const labelBaseY = (grand ? y0 + bassTop + 4 * SP : y0 + trebleH) + 18;
      for (const col of labelCols.values()) {
        col.labels.sort((a, b) => a.pitch - b.pitch);
        col.labels.forEach((L, i) => {
          txt(svg, col.x, labelBaseY + i * 11, L.label, 'doremi-label');
        });
      }
    }
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
    for (const c of chords) {
      const bar = Math.floor(c.startBeat / beatsPerBar);
      if (bar >= 0 && bar < totalBars) bars[bar].push(c);
      // 複数小節にまたがるコード: 各小節の頭に「%」的表示はせず伸ばす
      for (let b2 = bar + 1; b2 < Math.floor((c.endBeat - 0.01) / beatsPerBar) + 1 && b2 < totalBars; b2++) {
        bars[b2].push({ ...c, _cont: true, startBeat: b2 * beatsPerBar });
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
        chip.dataset.startSec = c.startSec !== undefined ? c.startSec : '';
        chip.dataset.endSec = c.endSec !== undefined ? c.endSec : '';
        const name = document.createElement('span');
        name.className = 'chord-chip-name';
        name.textContent = c._cont ? '─' : c.label;
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

  return { chordDiagram, tabSVG, staffSVG, chordGrid, usedChordStrip, svgToPng };
})();
