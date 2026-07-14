/* =========================================================
 * guitartab.js — ギターコードTAB (かんたん解析モード)
 * ギターステム1本 → コード進行 + コードフォーム図の「編集できる下書き」
 * 解析はすべてブラウザ内 (自前クロマ抽出 + テンプレート照合 + 平滑化)。
 * 外部API・外部送信なし。
 * ======================================================= */
'use strict';

(() => {

  const $ = sel => document.querySelector(sel);
  const $$ = sel => [...document.querySelectorAll(sel)];

  // 編集候補にするコードタイプ(仕様の初期対応セット)
  const QUALITIES = [
    ['', 'メジャー'], ['m', 'マイナー'], ['7', '7'], ['M7', 'maj7'],
    ['m7', 'm7'], ['sus4', 'sus4'], ['add9', 'add9'],
  ];

  const st = {
    file: null,
    audioUrl: null,
    // 解析結果 (編集可能な下書き)
    bpm: 120,
    beatsPerBar: 4,
    key: null,
    beatTimes: null,       // 自動検出ビート(手動BPM時はnull)
    t0: 0,                 // 手動BPM時のグリッド原点(秒)
    segs: [],              // [{startBeat, endBeat, root, suffix}] 拍単位
    selected: -1,          // 編集中セグメント
    hlTimer: null,
  };

  document.addEventListener('DOMContentLoaded', () => {
    // モード切替 (フル解析スタジオ ↔ ギターコードTAB)
    // bodyクラスとCSSで切り替え、既存セクションのhidden状態には触れない
    $$('.mode-btn').forEach(btn => btn.addEventListener('click', () => {
      $$('.mode-btn').forEach(b => b.classList.toggle('active', b === btn));
      document.body.classList.toggle('mode-gtab', btn.dataset.mode === 'gtab');
    }));

    // ドラッグ&ドロップ対応
    const card = $('#gtabCard');
    ['dragover', 'dragenter'].forEach(ev =>
      card.addEventListener(ev, e => { e.preventDefault(); card.classList.add('dragover'); }));
    ['dragleave', 'drop'].forEach(ev =>
      card.addEventListener(ev, e => { e.preventDefault(); card.classList.remove('dragover'); }));
    card.addEventListener('drop', e => {
      const f = [...e.dataTransfer.files].find(f =>
        /\.(mp3|m4a|wav|aac|ogg|flac)$/i.test(f.name) || f.type.startsWith('audio/'));
      if (f) {
        st.file = f;
        $('#gtabFileName').textContent = '✔ ' + f.name;
        $('#gtabAnalyze').disabled = false;
      }
    });

    const input = $('#gtabAudio');
    input.addEventListener('change', () => {
      if (!input.files[0]) return;
      st.file = input.files[0];
      $('#gtabFileName').textContent = '✔ ' + st.file.name;
      $('#gtabAnalyze').disabled = false;
    });
    $('#gtabBpmMode').addEventListener('change', () => {
      $('#gtabBpmValue').disabled = $('#gtabBpmMode').value !== 'manual';
    });
    $('#gtabAnalyze').addEventListener('click', analyze);
    $('#gtabPrint').addEventListener('click', () => {
      document.body.classList.add('print-gtab');
      window.print();
      setTimeout(() => document.body.classList.remove('print-gtab'), 500);
    });
    $('#gtabSaveJson').addEventListener('click', saveJson);
    $('#gtabImport').addEventListener('change', importJson);
    $('#gtabDifficulty').addEventListener('change', renderResult);
  });

  /* ==================== 解析 ==================== */
  async function analyze() {
    if (!st.file) return;
    stopHighlight();
    const prog = $('#gtabProgress');
    const bar = $('#gtabProgressBar');
    prog.hidden = false;
    $('#gtabResult').hidden = true;
    try {
      const buf = await st.file.arrayBuffer();
      const res = await AudioAnalyzer.analyze(buf, p => { bar.style.width = Math.round(p * 100) + '%'; });

      st.beatsPerBar = $('#gtabTimeSig').value === '3/4' ? 3 : 4;
      const manual = $('#gtabBpmMode').value === 'manual';
      if (manual) {
        // 手動BPM: 検出した最初のビートを原点に、一定間隔のグリッドを敷き直す
        st.bpm = Math.max(40, Math.min(240, +$('#gtabBpmValue').value || 120));
        st.t0 = res.beatTimes[0] || 0;
        st.beatTimes = null;
        const spb = 60 / st.bpm;
        st.segs = requantize(res.chords, sec => (sec - st.t0) / spb);
      } else {
        st.bpm = res.bpm;
        st.t0 = 0;
        st.beatTimes = res.beatTimes;
        st.segs = res.chords
          .filter(c => c.endBeat > c.startBeat)
          .map(c => ({ startBeat: Math.round(c.startBeat), endBeat: Math.round(c.endBeat), root: c.root, suffix: c.suffix }))
          .filter(s => s.endBeat > s.startBeat);
        mergeSame();
      }
      st.key = res.key;

      if (st.audioUrl) URL.revokeObjectURL(st.audioUrl);
      st.audioUrl = URL.createObjectURL(st.file);
      prog.hidden = true;
      st.selected = -1;
      renderResult();
      $('#gtabResult').hidden = false;
      $('#gtabResult').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (err) {
      prog.hidden = true;
      alert('解析に失敗しました: ' + err.message);
      console.error(err);
    }
  }

  // 秒→拍の変換関数を使ってコード列を拍グリッドに貼り直す
  function requantize(chords, secToBeat) {
    const segs = [];
    for (const c of chords) {
      const s = Math.max(0, Math.round(secToBeat(c.startSec)));
      const e = Math.round(secToBeat(c.endSec));
      if (e <= s) continue;
      segs.push({ startBeat: s, endBeat: e, root: c.root, suffix: c.suffix });
    }
    st.segs = segs;
    mergeSame();
    return st.segs;
  }

  function mergeSame() {
    const out = [];
    for (const s of st.segs.sort((a, b) => a.startBeat - b.startBeat)) {
      const last = out[out.length - 1];
      if (last && last.root === s.root && last.suffix === s.suffix && s.startBeat <= last.endBeat) {
        last.endBeat = Math.max(last.endBeat, s.endBeat);
      } else {
        out.push({ ...s });
      }
    }
    st.segs = out;
  }

  /* ==================== 拍⇔秒 ==================== */
  function beatToSec(beat) {
    if (st.beatTimes && st.beatTimes.length > 1) {
      const bt = st.beatTimes;
      const i = Math.floor(beat);
      if (i < 0) return bt[0];
      if (i >= bt.length - 1) {
        const p = bt[bt.length - 1] - bt[bt.length - 2];
        return bt[bt.length - 1] + (beat - (bt.length - 1)) * p;
      }
      return bt[i] + (bt[i + 1] - bt[i]) * (beat - i);
    }
    return st.t0 + beat * 60 / st.bpm;
  }

  /* ==================== 難易度 ==================== */
  function displaySuffix(suffix) {
    if ($('#gtabDifficulty').value === 'easy') {
      return /m(?!aj)/.test(suffix) && suffix !== 'M7' ? 'm' : '';
    }
    return suffix;
  }

  function segLabel(seg) {
    const useFlat = Theory.keyUsesFlat(st.key);
    return Theory.pcName(seg.root, useFlat) + displaySuffix(seg.suffix);
  }

  /* ==================== 結果描画 ==================== */
  function renderResult() {
    if (!st.segs.length && $('#gtabResult').hidden) return;
    const useFlat = Theory.keyUsesFlat(st.key);

    $('#gtabMeta').textContent =
      `キー: ${st.key ? Theory.keyLabel(st.key) : '不明'} / BPM: ${st.bpm} / 拍子: ${st.beatsPerBar}/4` +
      ($('#gtabGuitarType').value === 'acoustic' ? ' / アコギ' : ' / エレキ') +
      ' / チューニング: 標準 (E A D G B E)';

    // プレイヤー
    const ph = $('#gtabPlayer');
    ph.innerHTML = '';
    if (st.audioUrl) {
      const audio = document.createElement('audio');
      audio.controls = true;
      audio.src = st.audioUrl;
      audio.id = 'gtabAudio_el';
      ph.appendChild(audio);
      audio.addEventListener('play', () => startHighlight(audio));
      audio.addEventListener('pause', stopHighlight);
      audio.addEventListener('ended', stopHighlight);
    }

    // 使用コードのフォーム図 (指番号つき)
    const dia = $('#gtabDiagrams');
    dia.innerHTML = '';
    const seen = new Set();
    for (const seg of st.segs) {
      const label = segLabel(seg);
      if (seen.has(label)) continue;
      seen.add(label);
      const shape = Theory.guitarShape(seg.root, displaySuffix(seg.suffix), useFlat);
      const holder = document.createElement('div');
      holder.className = 'used-chord';
      holder.appendChild(Renderer.chordDiagram(label, shape));
      dia.appendChild(holder);
    }

    renderGrid();
    renderEditor();
  }

  function totalBars() {
    let maxBeat = 0;
    for (const s of st.segs) maxBeat = Math.max(maxBeat, s.endBeat);
    return Math.max(1, Math.ceil(maxBeat / st.beatsPerBar));
  }

  function renderGrid() {
    const holder = $('#gtabGrid');
    holder.innerHTML = '';
    const bpb = st.beatsPerBar;
    const nBars = totalBars();
    const grid = document.createElement('div');
    grid.className = 'chord-grid';
    for (let b = 0; b < nBars; b++) {
      const cell = document.createElement('div');
      cell.className = 'chord-bar';
      const num = document.createElement('span');
      num.className = 'chord-bar-num';
      num.textContent = b + 1;
      cell.appendChild(num);
      const inner = document.createElement('div');
      inner.className = 'chord-bar-inner';
      const barStart = b * bpb, barEnd = (b + 1) * bpb;
      let any = false;
      st.segs.forEach((seg, idx) => {
        if (seg.startBeat >= barEnd || seg.endBeat <= barStart) return;
        any = true;
        const isHead = seg.startBeat >= barStart; // この小節が開始位置
        const chip = document.createElement('div');
        chip.className = 'chord-chip gtab-chip' + (isHead ? '' : ' cont') + (idx === st.selected ? ' editing' : '');
        const a = Math.max(seg.startBeat, barStart);
        const e = Math.min(seg.endBeat, barEnd);
        chip.dataset.startSec = beatToSec(a);
        chip.dataset.endSec = beatToSec(e);
        chip.dataset.idx = idx;
        const name = document.createElement('span');
        name.className = 'chord-chip-name';
        name.textContent = segLabel(seg);
        chip.appendChild(name);
        chip.addEventListener('click', () => {
          st.selected = st.selected === idx ? -1 : idx;
          renderGrid();
          renderEditor();
        });
        inner.appendChild(chip);
      });
      if (!any) {
        const rest = document.createElement('span');
        rest.className = 'chord-rest';
        rest.textContent = '・';
        inner.appendChild(rest);
      }
      cell.appendChild(inner);
      grid.appendChild(cell);
    }
    holder.appendChild(grid);
  }

  /* ==================== 編集 (下書きの修正) ==================== */
  function renderEditor() {
    const ed = $('#gtabEditor');
    if (st.selected < 0 || !st.segs[st.selected]) { ed.hidden = true; return; }
    const seg = st.segs[st.selected];
    ed.hidden = false;
    ed.innerHTML = '';

    const bpb = st.beatsPerBar;
    const title = document.createElement('span');
    title.className = 'ctrl-label';
    title.textContent = `小節${Math.floor(seg.startBeat / bpb) + 1}の「${segLabel(seg)}」を編集:`;
    ed.appendChild(title);

    const useFlat = Theory.keyUsesFlat(st.key);
    const rootSel = document.createElement('select');
    for (let pc = 0; pc < 12; pc++) {
      const o = document.createElement('option');
      o.value = pc;
      o.textContent = Theory.pcName(pc, useFlat);
      if (pc === seg.root) o.selected = true;
      rootSel.appendChild(o);
    }
    const qualSel = document.createElement('select');
    for (const [suf, label] of QUALITIES) {
      const o = document.createElement('option');
      o.value = suf;
      o.textContent = label;
      if (suf === seg.suffix || (suf === '' && !QUALITIES.some(q => q[0] === seg.suffix))) o.selected = true;
      qualSel.appendChild(o);
    }
    const apply = () => {
      seg.root = +rootSel.value;
      seg.suffix = qualSel.value;
      renderResult();
    };
    rootSel.addEventListener('change', apply);
    qualSel.addEventListener('change', apply);
    ed.appendChild(rootSel);
    ed.appendChild(qualSel);

    const mkBtn = (label, fn) => {
      const b = document.createElement('button');
      b.className = 'btn btn-small';
      b.textContent = label;
      b.addEventListener('click', fn);
      ed.appendChild(b);
    };
    if (seg.endBeat - seg.startBeat >= 2) {
      mkBtn('✂️ 分割', () => {
        const mid = Math.round((seg.startBeat + seg.endBeat) / 2);
        st.segs.splice(st.selected + 1, 0, { ...seg, startBeat: mid });
        seg.endBeat = mid;
        renderResult();
      });
    }
    if (st.selected + 1 < st.segs.length) {
      mkBtn('🔗 次と結合', () => {
        seg.endBeat = st.segs[st.selected + 1].endBeat;
        st.segs.splice(st.selected + 1, 1);
        renderResult();
      });
    }
    mkBtn('🗑 削除', () => {
      const prev = st.segs[st.selected - 1];
      if (prev) prev.endBeat = seg.endBeat; // 前のコードを伸ばして埋める
      st.segs.splice(st.selected, 1);
      st.selected = -1;
      renderResult();
    });
    mkBtn('閉じる', () => { st.selected = -1; renderGrid(); renderEditor(); });
  }

  /* ==================== 再生ハイライト ==================== */
  function startHighlight(audio) {
    stopHighlight();
    const chips = $$('#gtabGrid .gtab-chip');
    st.hlTimer = setInterval(() => {
      const t = audio.currentTime;
      for (const chip of chips) {
        const s = parseFloat(chip.dataset.startSec);
        const e = parseFloat(chip.dataset.endSec);
        chip.classList.toggle('now', !isNaN(s) && !isNaN(e) && t >= s && t < e);
      }
    }, 100);
  }
  function stopHighlight() {
    if (st.hlTimer) clearInterval(st.hlTimer);
    st.hlTimer = null;
    $$('#gtabGrid .now').forEach(c => c.classList.remove('now'));
  }

  /* ==================== JSON保存 / 読み込み ==================== */
  function saveJson() {
    const data = {
      app: 'chord-studio-guitartab',
      version: 1,
      savedAt: new Date().toISOString(),
      fileName: st.file ? st.file.name : '',
      settings: {
        guitarType: $('#gtabGuitarType').value,
        tuning: 'EADGBE',
        difficulty: $('#gtabDifficulty').value,
      },
      bpm: st.bpm,
      beatsPerBar: st.beatsPerBar,
      t0: st.t0,
      key: st.key,
      beatTimes: st.beatTimes ? [...st.beatTimes] : null,
      segs: st.segs,
    };
    const blob = new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (st.file ? st.file.name.replace(/\.[^.]+$/, '') : 'コード解析') + '_コード譜.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  async function importJson() {
    const f = $('#gtabImport').files[0];
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      if (data.app !== 'chord-studio-guitartab' || !Array.isArray(data.segs)) {
        throw new Error('このツールで保存したJSONではありません');
      }
      st.bpm = data.bpm || 120;
      st.beatsPerBar = data.beatsPerBar || 4;
      st.t0 = data.t0 || 0;
      st.key = data.key || null;
      st.beatTimes = data.beatTimes || null;
      st.segs = data.segs;
      st.selected = -1;
      if (data.settings) {
        $('#gtabGuitarType').value = data.settings.guitarType || 'electric';
        $('#gtabDifficulty').value = data.settings.difficulty || 'original';
      }
      $('#gtabTimeSig').value = st.beatsPerBar === 3 ? '3/4' : '4/4';
      renderResult();
      $('#gtabResult').hidden = false;
      $('#gtabResult').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (err) {
      alert('JSONの読み込みに失敗しました: ' + err.message);
    }
    $('#gtabImport').value = '';
  }

})();
