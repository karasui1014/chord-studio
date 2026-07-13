/* =========================================================
 * app.js — UI制御・ファイル読込・再生・書き出し
 * ======================================================= */
'use strict';

(() => {

  const $ = sel => document.querySelector(sel);
  const $$ = sel => [...document.querySelectorAll(sel)];

  const state = {
    song: null,          // MIDIソングモデル
    audioResult: null,   // 音源解析結果
    activeSource: null,  // 'midi' | 'audio'
    chords: [],
    key: null,
    title: '無題',
    transpose: 0,
    capo: 0,
    showDegree: true,
    audioUrl: null,
    synth: null,
    rafId: null,
    currentGetTime: null,  // 再生中: 現在時刻(秒)を返す関数。停止中はnull
    lyrics: { raw: '', lines: [], editing: true, startBar: 1, barsPerLine: 'auto' },
    // 解析前のステージング(全部セットしてから「解析開始」で一括解析)
    staged: { audio: null, stems: [], stemsKind: null },
    tabFlip: false,        // TAB譜の上下反転(false = 1弦が上の標準)
    beatSecs: null,        // 拍→秒の対応表(再生カーソル用)
    timeOffset: 0,         // 手動タイミング補正(秒)。自動テンポ検出が前奏などでズレた時の微調整用
  };

  const ROLE_LABELS = {
    guitar: 'ギター(TAB譜)',
    bass: 'ベース(TAB譜)',
    keys: '鍵盤(五線譜)',
    melody: 'メロディ(五線譜)',
    drums: 'ドラム(採譜対象外)',
    skip: '使わない',
  };

  /* ==================== 初期化 ==================== */
  document.addEventListener('DOMContentLoaded', () => {
    setupUploaders();
    $('#btnDemo').addEventListener('click', loadDemo);
    $$('.tab-btn').forEach(btn => btn.addEventListener('click', () => switchTab(btn.dataset.tab)));
    $('#btnTransposeDown').addEventListener('click', () => { state.transpose--; renderShiftViews(); });
    $('#btnTransposeUp').addEventListener('click', () => { state.transpose++; renderShiftViews(); });
    $('#btnTransposeReset').addEventListener('click', () => { state.transpose = 0; renderShiftViews(); });
    $('#capoSelect').addEventListener('change', () => {
      state.capo = +$('#capoSelect').value;
      renderShiftViews();
    });
    $('#btnAutoCapo').addEventListener('click', autoCapo);
    $('#lyricsStage').addEventListener('input', updateStageUI);
    $('#btnDegree').addEventListener('click', () => {
      state.showDegree = !state.showDegree;
      $('#btnDegree').classList.toggle('on', state.showDegree);
      renderChordPanel();
    });
    $('#btnExportAll').addEventListener('click', exportAllText);
    $('#btnPrint').addEventListener('click', printAll);

    if ('serviceWorker' in navigator && location.protocol !== 'file:') {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }
  });

  /* ==================== アップローダ (ステージング方式) ====================
   * ファイルを選んだ時点では解析せず、「解析開始」ボタンで一括解析する。
   * 楽曲ファイル+ステム+歌詞を全部使って一つの結果を作るため。 */
  function setupUploaders() {
    const audioInput = $('#audioInput');
    const midiInput = $('#midiInput');
    audioInput.addEventListener('change', () => {
      const f = audioInput.files[0];
      if (!f) return;
      stageAudio(f);
    });
    midiInput.addEventListener('change', () => {
      stageStemFiles([...midiInput.files]);
    });
    setupDrop($('#audioCard'), files => {
      const f = files.find(f => /\.(mp3|wav|m4a|aac|ogg|flac|webm)$/i.test(f.name) || f.type.startsWith('audio/'));
      if (f) stageAudio(f);
      else showUploadNotice('音源ファイル(mp3 / wav / m4a など)をお使いください。');
    });
    setupDrop($('#midiCard'), files => stageStemFiles(files));
    $('#btnAnalyze').addEventListener('click', runAnalysis);
  }

  function stageAudio(f) {
    if (/\.(mid|midi)$/i.test(f.name)) {
      showUploadNotice('それはMIDIファイルのようです。右の「ステム分離ファイル」へどうぞ。');
      return;
    }
    state.staged.audio = f;
    updateStageUI();
  }

  function stageStemFiles(files) {
    if (files.length === 0) return;
    const mids = files.filter(f => /\.(midi?|MIDI?)$/i.test(f.name));
    const audios = files.filter(f =>
      !/\.(midi?|MIDI?)$/i.test(f.name) &&
      (/\.(mp3|wav|m4a|aac|ogg|flac|webm)$/i.test(f.name) || f.type.startsWith('audio/')));
    if (mids.length && audios.length) {
      showUploadNotice('MIDIと音源ファイルが混ざっています。どちらか一方だけを選んでください。');
      return;
    }
    if (mids.length) { state.staged.stems = mids; state.staged.stemsKind = 'midi'; }
    else if (audios.length) { state.staged.stems = audios; state.staged.stemsKind = 'audio'; }
    else { showUploadNotice('対応形式は .mid / mp3 / wav / m4a などです。'); return; }
    updateStageUI();
  }

  function updateStageUI() {
    const st = state.staged;
    const audioStatus = $('#audioStatus');
    const midiStatus = $('#midiStatus');
    $('#audioCard').classList.toggle('staged', !!st.audio);
    $('#midiCard').classList.toggle('staged', st.stems.length > 0);
    audioStatus.textContent = st.audio ? `✔ ${st.audio.name}` : '';
    midiStatus.textContent = st.stems.length
      ? `✔ ${st.stems.length}ファイル (${st.stemsKind === 'midi' ? 'MIDI' : '音源'})`
      : '';
    const btn = $('#btnAnalyze');
    btn.disabled = !(st.audio || st.stems.length);
    if (!btn.disabled) {
      const parts = [];
      if (st.stems.length) parts.push(st.stemsKind === 'midi' ? 'MIDI採譜' : 'ステム自動採譜');
      else if (st.audio) parts.push('コード解析');
      if (st.audio && st.stems.length) parts.push('実音源同期');
      if ($('#lyricsStage').value.trim()) parts.push('歌詞シート');
      btn.textContent = `🔍 解析開始 (${parts.join(' + ')})`;
    } else {
      btn.textContent = '🔍 解析開始';
    }
  }

  /* ==================== 一括解析 ==================== */
  async function runAnalysis() {
    const st = state.staged;
    if (!st.audio && !st.stems.length) return;
    stopAllPlayback();
    resetLyrics();
    state.timeOffset = 0;

    // 歌詞を先に取り込む(解析後すぐシート生成される)
    const lyricsText = $('#lyricsStage').value;
    if (lyricsText.trim()) {
      state.lyrics.raw = lyricsText;
      state.lyrics.lines = parseLyricsText(lyricsText);
      state.lyrics.editing = false;
    }

    // 再生用の実音源をセット
    if (st.audio) {
      if (state.audioUrl) URL.revokeObjectURL(state.audioUrl);
      state.audioUrl = URL.createObjectURL(st.audio);
    }

    try {
      if (st.stems.length && st.stemsKind === 'midi') {
        await analyzeMidiFiles(st.stems);
      } else if (st.stems.length) {
        await analyzeStemAudioFiles(st.stems, st.audio);
      } else {
        await analyzeAudioOnly(st.audio);
      }
    } catch (err) {
      hideProgress();
      alert('解析に失敗しました: ' + err.message);
      console.error(err);
    }
  }

  function parseLyricsText(text) {
    const lines = [];
    let prevBlank = true;
    for (const s of text.split('\n').map(s => s.trim())) {
      if (s.length === 0) {
        if (!prevBlank) lines.push({ blank: true });
        prevBlank = true;
      } else {
        lines.push({ text: s });
        prevBlank = false;
      }
    }
    while (lines.length && lines[lines.length - 1].blank) lines.pop();
    return lines;
  }

  /* ==================== ステム音源の自動採譜 ==================== */
  async function analyzeStemAudioFiles(files, fullMixFile) {
    if (state.song && state.song.mixWavUrl) URL.revokeObjectURL(state.song.mixWavUrl);
    state.title = fullMixFile
      ? fullMixFile.name.replace(/\.[^.]+$/, '')
      : (files.length === 1
          ? files[0].name.replace(/\.[^.]+$/, '')
          : `ステム採譜 (${files.length}ファイル)`);
    showProgress('ステム音源を読み込み中… (端末内で処理・アップロードはしていません)');
    const opts = {};
    if (fullMixFile) opts.fullMixBuffer = await fullMixFile.arrayBuffer();
    const song = await Transcriber.transcribeFiles(files, (msg, p) => {
      $('#progressMsg').textContent = msg + ' — 端末内で処理中';
      setProgress(Math.min(0.99, p));
    }, opts);
    state.song = song;
    reanalyzeMidi();
    hideProgress();
    renderResults();
  }

  function showUploadNotice(msg) {
    const el = $('#uploadNotice');
    if (!el) return;
    el.textContent = '⚠️ ' + msg;
    el.hidden = false;
    clearTimeout(state.noticeTimer);
    state.noticeTimer = setTimeout(() => { el.hidden = true; }, 8000);
  }

  function setupDrop(elCard, cb) {
    ['dragover', 'dragenter'].forEach(evName =>
      elCard.addEventListener(evName, e => { e.preventDefault(); elCard.classList.add('dragover'); }));
    ['dragleave', 'drop'].forEach(evName =>
      elCard.addEventListener(evName, e => { e.preventDefault(); elCard.classList.remove('dragover'); }));
    elCard.addEventListener('drop', e => {
      const files = [...e.dataTransfer.files];
      if (files.length) cb(files);
    });
  }

  /* ==================== 音源のみのコード解析 ==================== */
  async function analyzeAudioOnly(file) {
    state.title = file.name.replace(/\.[^.]+$/, '');
    showProgress('音源を解析中… (端末内で処理・アップロードはしていません)');
    const buf = await file.arrayBuffer();
    const result = await AudioAnalyzer.analyze(buf, p => setProgress(p));
    state.audioResult = result;
    state.activeSource = 'audio';
    state.chords = result.chords;
    state.key = result.key;
    state.transpose = 0;
    state.capo = 0;
    hideProgress();
    renderResults();
  }

  /* ==================== MIDI解析 ==================== */
  async function analyzeMidiFiles(files) {
    if (state.song && state.song.mixWavUrl) URL.revokeObjectURL(state.song.mixWavUrl);
    showProgress('MIDIを解析中…');
    const parsed = [];
    for (const f of files) {
      const buf = await f.arrayBuffer();
      parsed.push(MidiParser.parse(buf, f.name));
    }
    state.title = state.staged.audio
      ? state.staged.audio.name.replace(/\.[^.]+$/, '')
      : (files.length === 1
          ? files[0].name.replace(/\.[^.]+$/, '')
          : files[0].name.replace(/\.[^.]+$/, '') + ' 他' + (files.length - 1) + 'ファイル');
    const song = MidiParser.buildSong(parsed);
    state.song = song;
    reanalyzeMidi();
    hideProgress();
    renderResults();
  }

  function reanalyzeMidi() {
    const song = state.song;
    let key, chords;
    if (song.kind === 'stems' && song.chordResult) {
      // ステム採譜: 全ステム合算ミックスのクロマ解析結果をそのまま使う
      key = song.chordResult.key;
      chords = song.chordResult.chords;
    } else {
      ({ key, chords } = MidiParser.analyzeChords(song));
      // 再生同期用に秒も持たせる
      for (const c of chords) {
        c.startSec = song.tickToSec(c.startBeat * song.ppq);
        c.endSec = song.tickToSec(c.endBeat * song.ppq);
      }
    }
    state.activeSource = 'midi';
    state.chords = chords;
    state.key = key;
  }

  /* ==================== デモデータ ==================== */
  function loadDemo() {
    stopAllPlayback();
    resetLyrics();
    state.title = 'デモ楽曲 (C-G-Am-F)';
    const ppq = 480, bpm = 92;
    const spb = 60 / bpm;
    const mk = (beat, durBeat, pitch, vel) => ({
      tick: Math.round(beat * ppq), durTick: Math.round(durBeat * ppq),
      pitch, vel: vel || 92, ch: 0, beat, durBeat,
    });
    const PROG = [
      [48, [48, 55, 60, 64]], [43, [43, 55, 59, 62]], [45, [45, 57, 60, 64]], [41, [41, 53, 57, 60]],
      [48, [48, 55, 60, 64]], [43, [43, 55, 59, 62]], [41, [41, 53, 57, 60]], [43, [43, 55, 59, 62]],
    ];
    const gtr = [], bass = [], piano = [], melody = [];
    const MELO = [64, 62, 60, 62, 64, 64, 64, null, 62, 62, 62, null, 64, 67, 67, null,
                  64, 62, 60, 62, 64, 64, 64, 64, 62, 62, 64, 62, 60, null, null, null];
    for (let bar = 0; bar < 8; bar++) {
      const [root, tones] = PROG[bar];
      // ギター: 8分ストローク(1・3拍目コード、2・4拍目アルペジオ風)
      for (let b = 0; b < 4; b++) {
        if (b % 2 === 0) {
          for (const t of tones) gtr.push(mk(bar * 4 + b, 0.9, t, 84));
        } else {
          gtr.push(mk(bar * 4 + b, 0.45, tones[1], 72));
          gtr.push(mk(bar * 4 + b + 0.5, 0.45, tones[2], 72));
        }
      }
      // ベース: ルート4分 + 5度
      bass.push(mk(bar * 4 + 0, 1.4, root - 12, 100));
      bass.push(mk(bar * 4 + 1.5, 0.4, root - 12, 78));
      bass.push(mk(bar * 4 + 2, 1.4, root - 5, 92));
      bass.push(mk(bar * 4 + 3, 0.9, root - 12, 88));
      // ピアノ: 白玉コード
      for (const t of tones.slice(1)) piano.push(mk(bar * 4, 3.8, t + 12, 66));
      // メロディ
      for (let i = 0; i < 4; i++) {
        const m = MELO[bar * 4 + i];
        if (m !== null && m !== undefined) melody.push(mk(bar * 4 + i, 0.9, m + 12, 96));
      }
    }
    const song = {
      source: 'midi', ppq, bpm,
      timeSig: { num: 4, den: 4 }, beatsPerBar: 4, totalBars: 8,
      tracks: [
        { name: 'アコースティックギター', notes: gtr, role: 'guitar', channels: [0] },
        { name: 'エレキベース', notes: bass, role: 'bass', channels: [1] },
        { name: 'ピアノ', notes: piano, role: 'keys', channels: [2] },
        { name: 'リードメロディ', notes: melody, role: 'melody', channels: [3] },
      ],
      tickToSec: t => (t / ppq) * spb,
    };
    state.song = song;
    reanalyzeMidi();
    renderResults();
  }

  /* ==================== プログレス ==================== */
  function showProgress(msg) {
    $('#progressSection').hidden = false;
    $('#progressMsg').textContent = msg;
    setProgress(0.02);
  }
  function setProgress(p) {
    $('#progressBar').style.width = Math.round(p * 100) + '%';
  }
  function hideProgress() {
    $('#progressSection').hidden = true;
  }

  function resetLyrics() {
    state.lyrics = { raw: '', lines: [], editing: true, startBar: 1, barsPerLine: 'auto' };
  }

  /* ==================== 拍→秒テーブル (再生カーソル用) ==================== */
  function buildBeatSecs() {
    const m = currentMeta();
    const total = Math.ceil(m.totalBars * m.beatsPerBar) + 2;
    const arr = new Float64Array(total);
    if (state.activeSource === 'midi' && state.song) {
      for (let i = 0; i < total; i++) arr[i] = state.song.tickToSec(i * state.song.ppq);
    } else if (state.audioResult && state.audioResult.beatTimes) {
      const bt = state.audioResult.beatTimes;
      const bd = 60 / (state.audioResult.bpm || 120);
      for (let i = 0; i < total; i++) {
        arr[i] = i < bt.length ? bt[i] : bt[bt.length - 1] + (i - bt.length + 1) * bd;
      }
    }
    state.beatSecs = arr;
  }

  function secToBeat(t) {
    const a = state.beatSecs;
    if (!a || a.length < 2) return 0;
    if (t <= a[0]) return 0;
    if (t >= a[a.length - 1]) return a.length - 1;
    let lo = 0, hi = a.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (a[mid] <= t) lo = mid; else hi = mid;
    }
    return lo + (t - a[lo]) / ((a[lo + 1] - a[lo]) || 1e-9);
  }

  /* ==================== 結果描画 ==================== */
  function renderResults() {
    $('#resultsSection').hidden = false;
    buildBeatSecs();
    renderSummary();
    renderPlayback();
    renderChordPanel();
    renderGuitarPanel();
    renderBassPanel();
    renderKeysPanel();
    renderTracksPanel();
    renderLyricsPanel();
    switchTab('chords');
    $('#resultsSection').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function currentMeta() {
    const src = state.activeSource;
    const bpm = src === 'midi' ? state.song.bpm : state.audioResult.bpm;
    const ts = src === 'midi' ? state.song.timeSig : state.audioResult.timeSig;
    const totalBars = src === 'midi' ? state.song.totalBars : state.audioResult.totalBars;
    const beatsPerBar = src === 'midi' ? state.song.beatsPerBar : state.audioResult.beatsPerBar;
    return {
      title: state.title,
      key: state.key ? Theory.keyLabel(state.key) : '不明',
      bpm, timeSig: `${ts.num}/${ts.den}`, totalBars, beatsPerBar,
      showDegree: state.showDegree,
    };
  }

  function renderSummary() {
    const m = currentMeta();
    const srcLabel = state.activeSource === 'midi'
      ? (state.song && state.song.kind === 'stems'
          ? '<span class="badge badge-audio">ステム自動採譜</span>'
          : '<span class="badge badge-midi">MIDI採譜(高精度)</span>')
      : '<span class="badge badge-audio">音源解析(参考精度)</span>';
    $('#summaryBar').innerHTML = `
      ${srcLabel}
      <span class="summary-title">${escapeHtml(state.title)}</span>
      <span class="summary-item">キー <strong>${m.key}</strong></span>
      <span class="summary-item">BPM <strong>${m.bpm}</strong></span>
      <span class="summary-item">拍子 <strong>${m.timeSig}</strong></span>
      <span class="summary-item">小節 <strong>${m.totalBars}</strong></span>`;
  }

  /* ==================== 再生 ==================== */
  // 優先順: ①読み込んだ楽曲ファイル ②ステム合成ミックス ③簡易シンセ
  // 実音源で再生すればコード・歌詞ハイライトが実時間に正確に同期する
  function renderPlayback() {
    const holder = $('#playbackArea');
    holder.innerHTML = '';
    const realUrl = state.audioUrl || (state.song && state.song.mixWavUrl) || null;
    if (realUrl) {
      const audio = document.createElement('audio');
      audio.controls = true;
      audio.src = realUrl;
      audio.id = 'audioPlayer';
      holder.appendChild(audio);
      if (!state.audioUrl && state.song && state.song.mixWavUrl) {
        const note = document.createElement('span');
        note.className = 'hint';
        note.textContent = ' ステムを合成した実音源で再生(表示と同期します)';
        holder.appendChild(note);
      }
      audio.addEventListener('play', () => {
        stopMidiPlayback();
        startHighlightLoop(() => audio.currentTime);
      });
      audio.addEventListener('pause', stopHighlightLoop);
      audio.addEventListener('ended', stopHighlightLoop);
    }
    if (state.activeSource === 'midi') {
      const btn = document.createElement('button');
      btn.className = 'btn btn-play';
      btn.id = 'btnMidiPlay';
      btn.textContent = '▶ 採譜結果を再生 (簡易シンセ)';
      btn.addEventListener('click', toggleMidiPlayback);
      holder.appendChild(btn);
      if (state.song && state.song.kind === 'stems') {
        const half = document.createElement('button');
        half.className = 'btn btn-small';
        half.textContent = 'テンポ÷2';
        half.addEventListener('click', () => scaleTempo(0.5));
        const dbl = document.createElement('button');
        dbl.className = 'btn btn-small';
        dbl.textContent = 'テンポ×2';
        dbl.addEventListener('click', () => scaleTempo(2));
        const note = document.createElement('span');
        note.className = 'hint';
        note.textContent = ' BPMや小節の数え方が倍/半分にズレているときに押してください';
        holder.appendChild(dbl);
        holder.appendChild(half);
        holder.appendChild(note);
      }
    }
    // 再生中に「今のコード + 歌詞」をどのタブでも見えるように
    const np = document.createElement('div');
    np.id = 'nowPlaying';
    np.hidden = true;
    holder.appendChild(np);

    // 手動タイミング補正: 自動テンポ検出が前奏などでズレた時にここで微調整する
    if (realUrl || state.activeSource === 'midi') {
      holder.appendChild(timingOffsetControls());
    }
  }

  function timingOffsetControls() {
    const bar = document.createElement('div');
    bar.className = 'offset-bar';
    const label = document.createElement('span');
    label.className = 'ctrl-label';
    label.textContent = 'タイミング調整(前奏などでズレる場合)';
    bar.appendChild(label);
    const valSpan = document.createElement('span');
    valSpan.className = 'offset-val';
    valSpan.id = 'offsetVal';
    const renderVal = () => { valSpan.textContent = (state.timeOffset >= 0 ? '+' : '') + state.timeOffset.toFixed(2) + '秒'; };
    renderVal();
    const step = (d) => { state.timeOffset = Math.round((state.timeOffset + d) * 100) / 100; renderVal(); };
    const mkBtn = (label, d) => {
      const b = document.createElement('button');
      b.className = 'btn btn-small';
      b.textContent = label;
      b.addEventListener('click', () => step(d));
      return b;
    };
    bar.appendChild(mkBtn('−0.5', -0.5));
    bar.appendChild(mkBtn('−0.1', -0.1));
    bar.appendChild(valSpan);
    bar.appendChild(mkBtn('+0.1', 0.1));
    bar.appendChild(mkBtn('+0.5', 0.5));
    const resetBtn = document.createElement('button');
    resetBtn.className = 'btn btn-small';
    resetBtn.textContent = 'リセット';
    resetBtn.addEventListener('click', () => { state.timeOffset = 0; renderVal(); });
    bar.appendChild(resetBtn);
    return bar;
  }

  // ステム採譜のテンポ倍/半分補正(ビート格子ごと掛け直す)
  function scaleTempo(factor) {
    const song = state.song;
    if (!song) return;
    stopAllPlayback();
    song.bpm = Math.round(song.bpm * factor * 10) / 10;
    const oldTickToSec = song.tickToSec;
    song.tickToSec = t => oldTickToSec(t / factor);
    for (const tr of song.tracks) {
      for (const n of tr.notes) {
        n.beat *= factor;
        n.durBeat *= factor;
        n.tick = Math.round(n.beat * song.ppq);
        n.durTick = Math.max(1, Math.round(n.durBeat * song.ppq));
      }
    }
    if (song.chordResult) {
      for (const c of song.chordResult.chords) {
        c.startBeat *= factor;
        c.endBeat *= factor;
      }
      song.chordResult.totalBars = Math.max(1, Math.ceil(song.chordResult.totalBars * factor));
    }
    song.totalBars = Math.max(1, Math.ceil(song.totalBars * factor));
    reanalyzeMidi();
    renderResults();
  }

  function toggleMidiPlayback() {
    if (state.synth) { stopMidiPlayback(); return; }
    const player = $('#audioPlayer');
    if (player) player.pause();
    const song = state.song;
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = new AC();
    if (ctx.state === 'suspended') ctx.resume();
    const master = ctx.createGain();
    master.gain.value = 0.25;
    const comp = ctx.createDynamicsCompressor();
    master.connect(comp).connect(ctx.destination);
    const t0 = ctx.currentTime + 0.1;
    let count = 0;
    const WAVE = { guitar: 'triangle', bass: 'sine', keys: 'triangle', melody: 'square' };
    for (const tr of song.tracks) {
      if (tr.role === 'drums' || tr.role === 'skip') continue;
      for (const n of tr.notes) {
        if (count++ > 4000) break;
        const start = t0 + song.tickToSec(n.tick);
        const dur = Math.max(0.08, song.tickToSec(n.tick + n.durTick) - song.tickToSec(n.tick));
        const osc = ctx.createOscillator();
        osc.type = WAVE[tr.role] || 'triangle';
        osc.frequency.value = 440 * Math.pow(2, (n.pitch - 69) / 12);
        const g = ctx.createGain();
        const vol = (n.vel / 127) * (tr.role === 'melody' ? 0.5 : 0.32);
        g.gain.setValueAtTime(0, start);
        g.gain.linearRampToValueAtTime(vol, start + 0.015);
        g.gain.exponentialRampToValueAtTime(0.001, start + dur);
        osc.connect(g).connect(master);
        osc.start(start);
        osc.stop(start + dur + 0.05);
      }
    }
    state.synth = { ctx, t0 };
    $('#btnMidiPlay').textContent = '■ 停止';
    $('#btnMidiPlay').classList.add('playing');
    const totalSec = song.tickToSec(song.totalBars * song.beatsPerBar * song.ppq);
    startHighlightLoop(() => ctx.currentTime - t0);
    state.synthTimer = setTimeout(stopMidiPlayback, (totalSec + 1) * 1000);
  }

  function stopMidiPlayback() {
    if (state.synth) {
      state.synth.ctx.close();
      state.synth = null;
      clearTimeout(state.synthTimer);
    }
    stopHighlightLoop();
    const btn = $('#btnMidiPlay');
    if (btn) { btn.textContent = '▶ 採譜結果を再生 (簡易シンセ)'; btn.classList.remove('playing'); }
  }

  function stopAllPlayback() {
    stopMidiPlayback();
    const a = $('#audioPlayer');
    if (a) a.pause();
  }

  function startHighlightLoop(getTime) {
    stopHighlightLoop();
    state.currentGetTime = getTime;
    const targets = [...$$('#panel-chords .chord-chip'), ...$$('#panel-lyrics .ly-line')];
    state.hlTimer = setInterval(() => {
      const t = getTime() + state.timeOffset;
      for (const el of targets) {
        const s = parseFloat(el.dataset.startSec);
        const e = parseFloat(el.dataset.endSec);
        el.classList.toggle('now', !isNaN(s) && !isNaN(e) && t >= s && t < e);
      }
      updatePlayCursors(t);
      updateNowPlaying(t);
    }, 100);
    const np = $('#nowPlaying');
    if (np) np.hidden = false;
  }
  function stopHighlightLoop() {
    if (state.hlTimer) clearInterval(state.hlTimer);
    state.hlTimer = null;
    state.currentGetTime = null;
    $$('.chord-chip.now, .ly-line.now').forEach(c => c.classList.remove('now'));
    $$('.play-cursor').forEach(c => { c.setAttribute('x1', -10); c.setAttribute('x2', -10); });
    const np = $('#nowPlaying');
    if (np) np.hidden = true;
  }

  // TAB譜・五線譜の上を動く再生カーソル
  function updatePlayCursors(t) {
    const beat = secToBeat(t);
    $$('.panel.active .score-svg').forEach(svg => {
      if (!svg.__beatPos || !svg.__cursor) return;
      const p = svg.__beatPos(beat);
      svg.__cursor.setAttribute('x1', p.x);
      svg.__cursor.setAttribute('x2', p.x);
      svg.__cursor.setAttribute('y1', p.y1);
      svg.__cursor.setAttribute('y2', p.y2);
    });
  }

  // どのタブにいても「今のコード + 歌詞の行」を表示
  function updateNowPlaying(t) {
    const np = $('#nowPlaying');
    if (!np) return;
    const chords = state._dispChords || state.chords;
    const c = chords.find(c => t >= c.startSec && t < c.endSec);
    const line = (state._lyricsLayout || []).find(l => !l.blank && t >= l.startSec && t < l.endSec);
    const chordTxt = c ? c.label : '—';
    np.innerHTML = '';
    const chordSpan = document.createElement('span');
    chordSpan.className = 'np-chord';
    chordSpan.textContent = chordTxt;
    np.appendChild(chordSpan);
    const lyricSpan = document.createElement('span');
    lyricSpan.className = 'np-lyric';
    lyricSpan.textContent = line ? line.text : '';
    np.appendChild(lyricSpan);
  }

  /* ==================== コード進行パネル ==================== */
  // 表示シフト = 移調 − カポ(カポ装着時は「押さえるフォーム」のコード名で表示)
  function displayShift() { return state.transpose - state.capo; }

  function displayedKey() {
    if (!state.key) return null;
    return { ...state.key, tonic: ((state.key.tonic + displayShift()) % 12 + 12) % 12 };
  }
  function transposedKey() {
    if (!state.key) return null;
    return { ...state.key, tonic: ((state.key.tonic + state.transpose) % 12 + 12) % 12 };
  }

  function displayedChords() {
    const shift = displayShift();
    if (shift === 0) return state.chords;
    const key = displayedKey();
    return state.chords.map(c => {
      const root = ((c.root + shift) % 12 + 12) % 12;
      return {
        ...c, root,
        label: Theory.chordLabel(root, c.suffix, key, null),
        degree: c.degree,
      };
    });
  }

  function renderShiftViews() {
    renderChordPanel();
    renderGuitarPanel();
    renderLyricsPanel();
  }

  // かんたんコード: オープンコードが最も多くなるカポ位置を自動提案
  function autoCapo() {
    if (!state.chords.length) return;
    const weight = new Map();
    let totalW = 0;
    for (const c of state.chords) {
      const root = ((c.root + state.transpose) % 12 + 12) % 12;
      const k = root + ':' + c.suffix;
      const w = (c.endBeat - c.startBeat) || 1;
      weight.set(k, (weight.get(k) || 0) + w);
      totalW += w;
    }
    let best = { capo: 0, score: -Infinity };
    for (let capo = 0; capo <= 7; capo++) {
      let s = 0;
      for (const [k, w] of weight) {
        const [rootStr, suffix] = k.split(':');
        if (Theory.hasOpenShape(+rootStr - capo, suffix)) s += w;
      }
      s -= capo * totalW * 0.015; // 僅差なら低いカポを優先
      if (s > best.score) best = { capo, score: s };
    }
    state.capo = best.capo;
    $('#capoSelect').value = String(best.capo);
    renderShiftViews();
  }

  function renderChordPanel() {
    const m = currentMeta();
    const holder = $('#chordGridHolder');
    const strip = $('#usedChordsHolder');
    holder.innerHTML = '';
    strip.innerHTML = '';
    $('#transposeVal').textContent = (state.transpose > 0 ? '+' : '') + state.transpose;
    const actualKey = transposedKey();
    let keyText = actualKey ? 'キー: ' + Theory.keyLabel(actualKey) : '';
    if (state.capo > 0 && actualKey) {
      keyText += ` | カポ${state.capo} → ${Theory.keyLabel(displayedKey())}フォームで表示中`;
    }
    $('#chordKeyLabel').textContent = keyText;
    const chords = displayedChords();
    if (chords.length === 0) {
      holder.innerHTML = '<p class="hint">コードが検出できませんでした。</p>';
      return;
    }
    strip.appendChild(Renderer.usedChordStrip(state.chords, state.key, displayShift()));
    holder.appendChild(Renderer.chordGrid(chords, {
      beatsPerBar: m.beatsPerBar, totalBars: m.totalBars, showDegree: state.showDegree,
    }));
    state._dispChords = chords; // 再生中の「今のコード」表示用キャッシュ
  }

  /* ==================== 歌詞パネル (自動割り付け) ==================== */
  // 歌詞を貼るだけで、行数と小節数からコード付き歌詞シートを自動生成する。
  // 音声認識による自動同期は端末内完結の方針(外部送信なし)と精度の面から行わない。

  function beatToSec(beat) {
    if (state.activeSource === 'midi' && state.song) {
      return state.song.tickToSec(beat * state.song.ppq);
    }
    const ar = state.audioResult;
    if (ar && ar.beatTimes && ar.beatTimes.length > 1) {
      const bt = ar.beatTimes;
      const i = Math.floor(beat);
      if (i >= bt.length - 1) return bt[bt.length - 1];
      return bt[Math.max(0, i)] + (bt[i + 1] - bt[i]) * (beat - i);
    }
    const m = currentMeta();
    return beat * 60 / (m.bpm || 120);
  }

  // 歌詞行 → 小節範囲 → コードの自動割り付け
  function computeLyricsLayout() {
    const L = state.lyrics;
    const m = currentMeta();
    const sungCount = L.lines.filter(l => !l.blank).length;
    if (sungCount === 0) return [];
    const startBar = Math.max(0, (L.startBar || 1) - 1);
    const avail = Math.max(1, m.totalBars - startBar);
    const stride = L.barsPerLine === 'auto'
      ? avail / sungCount
      : Number(L.barsPerLine);
    const chords = displayedChords();
    let cursor = startBar;
    const out = [];
    for (const line of L.lines) {
      if (line.blank) { out.push({ blank: true }); continue; }
      const b0 = cursor, b1 = cursor + stride;
      cursor = b1;
      const startBeat = b0 * m.beatsPerBar;
      const endBeat = b1 * m.beatsPerBar;
      const lineChords = chords
        .filter(c => c.startBeat < endBeat && c.endBeat > startBeat)
        .map(c => ({
          label: c.label,
          pos: Math.max(0, (c.startBeat - startBeat) / (endBeat - startBeat)),
        }));
      out.push({
        text: line.text,
        bar: Math.floor(b0) + 1,
        startBeat, endBeat,
        startSec: beatToSec(startBeat),
        endSec: beatToSec(endBeat),
        chords: lineChords,
      });
    }
    return out;
  }

  function renderLyricsPanel() {
    const holder = $('#lyricsHolder');
    if (!holder) return;
    holder.innerHTML = '';
    const L = state.lyrics;

    if (L.editing || L.lines.length === 0) {
      const wrap = document.createElement('div');
      wrap.className = 'lyrics-edit';
      const p = document.createElement('p');
      p.className = 'hint';
      p.textContent = '歌詞を貼り付けて「セット」を押すと、行数と小節数からコード付き歌詞シートを自動生成します。空行はセクション区切りになります。';
      const ta = document.createElement('textarea');
      ta.className = 'lyrics-textarea';
      ta.placeholder = '歌詞をここに貼り付け…\n(空行を入れるとAメロ/サビなどの区切りになります)';
      ta.value = L.raw;
      const btn = document.createElement('button');
      btn.className = 'btn btn-primary';
      btn.textContent = '📝 歌詞をセットしてシート生成';
      btn.addEventListener('click', () => {
        L.raw = ta.value;
        const lines = [];
        let prevBlank = true; // 先頭の空行は捨てる
        for (const s of ta.value.split('\n').map(s => s.trim())) {
          if (s.length === 0) {
            if (!prevBlank) lines.push({ blank: true });
            prevBlank = true;
          } else {
            lines.push({ text: s });
            prevBlank = false;
          }
        }
        while (lines.length && lines[lines.length - 1].blank) lines.pop();
        L.lines = lines;
        L.editing = false;
        renderLyricsPanel();
      });
      wrap.appendChild(p);
      wrap.appendChild(ta);
      wrap.appendChild(btn);
      holder.appendChild(wrap);
      return;
    }

    // 調整コントロール
    const m = currentMeta();
    const bar = document.createElement('div');
    bar.className = 'ly-controls';

    const startLabel = document.createElement('label');
    startLabel.className = 'ly-ctrl';
    startLabel.textContent = '歌い出しの小節 ';
    const startInput = document.createElement('input');
    startInput.type = 'number';
    startInput.min = 1;
    startInput.max = m.totalBars;
    startInput.value = L.startBar;
    startInput.addEventListener('change', () => {
      L.startBar = Math.max(1, Math.min(m.totalBars, Math.round(+startInput.value || 1)));
      renderLyricsPanel();
    });
    startLabel.appendChild(startInput);
    bar.appendChild(startLabel);

    const strideLabel = document.createElement('label');
    strideLabel.className = 'ly-ctrl';
    strideLabel.textContent = '1行あたりの小節数 ';
    const strideSel = document.createElement('select');
    for (const [v, t] of [['auto', '自動'], ['1', '1小節'], ['2', '2小節'], ['4', '4小節'], ['8', '8小節']]) {
      const opt = document.createElement('option');
      opt.value = v;
      opt.textContent = t;
      if (String(L.barsPerLine) === v) opt.selected = true;
      strideSel.appendChild(opt);
    }
    strideSel.addEventListener('change', () => {
      L.barsPerLine = strideSel.value === 'auto' ? 'auto' : +strideSel.value;
      renderLyricsPanel();
    });
    strideLabel.appendChild(strideSel);
    bar.appendChild(strideLabel);

    const editBtn = document.createElement('button');
    editBtn.className = 'btn btn-small';
    editBtn.textContent = '✏️ 歌詞を編集';
    editBtn.addEventListener('click', () => { L.editing = true; renderLyricsPanel(); });
    bar.appendChild(editBtn);

    const dlBtn = document.createElement('button');
    dlBtn.className = 'btn btn-small';
    dlBtn.textContent = '📄 コード付き歌詞をダウンロード (.txt)';
    dlBtn.addEventListener('click', () => {
      Exporter.download(
        Exporter.lyricsSheet(computeLyricsLayout(), currentMeta()),
        `${state.title}_コード付き歌詞.txt`);
    });
    bar.appendChild(dlBtn);
    holder.appendChild(bar);

    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent = '再生すると今歌っている行がハイライトされます。ズレるときは「歌い出しの小節」(イントロの長さぶん)と「1行あたりの小節数」を調整してください。';
    holder.appendChild(hint);

    // シート本体
    const sheet = document.createElement('div');
    sheet.className = 'ly-sheet';
    const layout = computeLyricsLayout();
    state._lyricsLayout = layout; // 再生中の「今の歌詞」表示用キャッシュ
    for (const line of layout) {
      if (line.blank) {
        const gap = document.createElement('div');
        gap.className = 'ly-gap';
        sheet.appendChild(gap);
        continue;
      }
      const row = document.createElement('div');
      row.className = 'ly-line';
      row.dataset.startSec = line.startSec;
      row.dataset.endSec = line.endSec;

      const num = document.createElement('span');
      num.className = 'ly-bar-num';
      num.textContent = line.bar;
      row.appendChild(num);

      const body = document.createElement('div');
      body.className = 'ly-body';
      const chordRow = document.createElement('div');
      chordRow.className = 'ly-chords';
      for (const c of line.chords) {
        const chip = document.createElement('span');
        chip.className = 'ly-chord';
        chip.style.left = (c.pos * 100).toFixed(1) + '%';
        chip.textContent = c.label;
        chordRow.appendChild(chip);
      }
      const text = document.createElement('div');
      text.className = 'ly-text';
      text.textContent = line.text;
      body.appendChild(chordRow);
      body.appendChild(text);
      row.appendChild(body);
      sheet.appendChild(row);
    }
    holder.appendChild(sheet);
  }

  /* ==================== 楽器イベント抽出 ==================== */
  function tracksByRole(role) {
    if (!state.song || state.activeSource !== 'midi') return [];
    return state.song.tracks.filter(t => t.role === role);
  }

  function notesToEvents(notes) {
    // 16分グリッドで同時発音をまとめる
    const byDiv = new Map();
    for (const n of notes) {
      const div = Math.round(n.beat * 4);
      if (!byDiv.has(div)) byDiv.set(div, []);
      byDiv.get(div).push(n);
    }
    const events = [];
    for (const [div, ns] of [...byDiv.entries()].sort((a, b) => a[0] - b[0])) {
      events.push({
        time: div / 4,
        dur: Math.max(...ns.map(n => n.durBeat)),
        pitches: ns.map(n => n.pitch),
        meta: ns, // グリス等の演奏情報を運指割当後に引き継ぐ
      });
    }
    return events;
  }

  // 運指割当の結果に元ノートのグリス情報(artic/toPitch)を付け直す
  function attachArtics(assigned, events) {
    for (let i = 0; i < assigned.length && i < events.length; i++) {
      const metas = [...(events[i].meta || [])];
      for (const note of assigned[i].notes) {
        const mi = metas.findIndex(m => m.pitch === note.pitch && (m.artic || m.toPitch));
        if (mi >= 0) {
          note.artic = metas[mi].artic;
          note.toPitch = metas[mi].toPitch;
          metas.splice(mi, 1);
        }
      }
    }
    return assigned;
  }

  function tabStringNames(base) {
    return state.tabFlip ? [...base].reverse() : base;
  }

  // TAB上下反転トグル + 凡例
  function tabControls() {
    const bar = document.createElement('div');
    bar.className = 'tab-controls';
    const legend = document.createElement('span');
    legend.className = 'hint';
    legend.textContent = state.tabFlip
      ? '上=6弦(低音側) / 下=1弦(高音側)。 / \\ はグリス・チョーキング気味の音程移動'
      : '上=1弦(高音側) / 下=6弦(低音側)。 / \\ はグリス・チョーキング気味の音程移動';
    const btn = document.createElement('button');
    btn.className = 'btn btn-small';
    btn.textContent = '↕ 弦の上下を反転';
    btn.addEventListener('click', () => {
      state.tabFlip = !state.tabFlip;
      renderGuitarPanel();
      renderBassPanel();
    });
    bar.appendChild(btn);
    bar.appendChild(legend);
    return bar;
  }

  /* ==================== ギターパネル ==================== */
  function renderGuitarPanel() {
    const holder = $('#guitarHolder');
    holder.innerHTML = '';
    const tracks = tracksByRole('guitar');
    if (state.activeSource !== 'midi') {
      holder.innerHTML = midiHintHtml('ギターのTAB譜');
      return;
    }
    if (tracks.length === 0) {
      holder.innerHTML = '<p class="hint">ギターに割り当てられたトラックがありません。「トラック割当」タブでロールを変更できます。</p>';
      return;
    }
    const m = currentMeta();
    for (const tr of tracks) {
      const sec = document.createElement('div');
      sec.className = 'inst-section';
      const capoNote = state.capo > 0
        ? ` <span class="badge badge-midi">カポ ${state.capo}(${state.capo}フレットに装着)</span>`
        : '';
      sec.innerHTML = `<h3 class="inst-title">🎸 ${escapeHtml(tr.name)}${capoNote}</h3>`;

      // 使用コードのダイアグラム(カポ適用後の押さえるフォーム)
      sec.appendChild(Renderer.usedChordStrip(state.chords, state.key, displayShift()));

      const events = notesToEvents(tr.notes);
      const assigned = attachArtics(Theory.assignFrets(events, Theory.GUITAR_TUNING), events);
      const names = tabStringNames(['e', 'B', 'G', 'D', 'A', 'E']);
      const svg = Renderer.tabSVG(assigned, {
        strings: 6, stringNames: names, flip: state.tabFlip, tuning: Theory.GUITAR_TUNING,
        beatsPerBar: m.beatsPerBar, totalBars: m.totalBars, chords: state.chords, showStrum: true,
      });
      sec.appendChild(tabControls());
      const strumNote = document.createElement('p');
      strumNote.className = 'hint';
      strumNote.textContent = '⊓ =ダウン / V =アップ。8分音符ベースの一般的な弾き方の目安です(音源から実際のピック方向を検出したものではありません)。';
      sec.appendChild(strumNote);
      const wrap = document.createElement('div');
      wrap.className = 'score-scroll';
      wrap.appendChild(svg);
      sec.appendChild(wrap);
      sec.appendChild(exportBar([
        ['📄 TAB譜をダウンロード (.txt)', () => Exporter.download(
          Exporter.textTab(assigned, {
            ...m, strings: 6, stringNames: names, flip: state.tabFlip, tuning: Theory.GUITAR_TUNING,
            chords: state.chords, instLabel: `ギター: ${tr.name}`,
          }), `${state.title}_ギターTAB_${tr.name}.txt`)],
        ['🖼 画像で保存 (.png)', () => Renderer.svgToPng(svg, `${state.title}_ギターTAB_${tr.name}.png`)],
      ]));
      holder.appendChild(sec);
    }
  }

  /* ==================== ベースパネル ==================== */
  function renderBassPanel() {
    const holder = $('#bassHolder');
    holder.innerHTML = '';
    const tracks = tracksByRole('bass');
    if (state.activeSource !== 'midi') {
      holder.innerHTML = midiHintHtml('ベースのTAB譜');
      return;
    }
    if (tracks.length === 0) {
      holder.innerHTML = '<p class="hint">ベースに割り当てられたトラックがありません。「トラック割当」タブでロールを変更できます。</p>';
      return;
    }
    const m = currentMeta();
    for (const tr of tracks) {
      const sec = document.createElement('div');
      sec.className = 'inst-section';
      sec.innerHTML = `<h3 class="inst-title">🎸 ${escapeHtml(tr.name)} (4弦ベース)</h3>`;
      const events = notesToEvents(tr.notes);
      const assigned = attachArtics(Theory.assignFrets(events, Theory.BASS_TUNING), events);
      const names = tabStringNames(['G', 'D', 'A', 'E']);
      const svg = Renderer.tabSVG(assigned, {
        strings: 4, stringNames: names, flip: state.tabFlip, tuning: Theory.BASS_TUNING,
        beatsPerBar: m.beatsPerBar, totalBars: m.totalBars, chords: state.chords,
      });
      sec.appendChild(tabControls());
      const wrap = document.createElement('div');
      wrap.className = 'score-scroll';
      wrap.appendChild(svg);
      sec.appendChild(wrap);
      sec.appendChild(exportBar([
        ['📄 TAB譜をダウンロード (.txt)', () => Exporter.download(
          Exporter.textTab(assigned, {
            ...m, strings: 4, stringNames: names, flip: state.tabFlip, tuning: Theory.BASS_TUNING,
            chords: state.chords, instLabel: `ベース: ${tr.name}`,
          }), `${state.title}_ベースTAB_${tr.name}.txt`)],
        ['🖼 画像で保存 (.png)', () => Renderer.svgToPng(svg, `${state.title}_ベースTAB_${tr.name}.png`)],
      ]));
      holder.appendChild(sec);
    }
  }

  /* ==================== 鍵盤パネル ==================== */
  function renderKeysPanel() {
    const holder = $('#keysHolder');
    holder.innerHTML = '';
    const tracks = [...tracksByRole('keys'), ...tracksByRole('melody')];
    if (state.activeSource !== 'midi') {
      holder.innerHTML = midiHintHtml('鍵盤・メロディの五線譜');
      return;
    }
    if (tracks.length === 0) {
      holder.innerHTML = '<p class="hint">鍵盤/メロディに割り当てられたトラックがありません。「トラック割当」タブでロールを変更できます。</p>';
      return;
    }
    const m = currentMeta();
    const useFlat = Theory.keyUsesFlat(state.key);
    for (const tr of tracks) {
      const isMelody = tr.role === 'melody';
      const sec = document.createElement('div');
      sec.className = 'inst-section';
      sec.innerHTML = `<h3 class="inst-title">${isMelody ? '🎤' : '🎹'} ${escapeHtml(tr.name)}</h3>`;
      const notes = tr.notes.map(n => ({ beat: n.beat, durBeat: n.durBeat, pitch: n.pitch }));
      const svg = Renderer.staffSVG(notes, {
        beatsPerBar: m.beatsPerBar, totalBars: m.totalBars, chords: state.chords,
        useFlat, grand: !isMelody || notes.some(n => n.pitch < 55),
      });
      const wrap = document.createElement('div');
      wrap.className = 'score-scroll';
      wrap.appendChild(svg);
      sec.appendChild(wrap);
      sec.appendChild(exportBar([
        ['📄 ドレミ譜をダウンロード (.txt)', () => Exporter.download(
          Exporter.doremiSheet(tr.notes, { ...m, useFlat, instLabel: tr.name }),
          `${state.title}_ドレミ譜_${tr.name}.txt`)],
        ['🖼 画像で保存 (.png)', () => Renderer.svgToPng(svg, `${state.title}_五線譜_${tr.name}.png`)],
      ]));
      holder.appendChild(sec);
    }
  }

  /* ==================== トラック割当パネル ==================== */
  function renderTracksPanel() {
    const holder = $('#tracksHolder');
    holder.innerHTML = '';
    if (state.activeSource !== 'midi' || !state.song) {
      holder.innerHTML = '<p class="hint">MIDIファイルを読み込むと、トラックごとに楽器の割当を変更できます。</p>';
      return;
    }
    const table = document.createElement('table');
    table.className = 'track-table';
    table.innerHTML = `<thead><tr>
      <th>トラック</th><th>音数</th><th>音域</th><th>割当</th>
    </tr></thead>`;
    const tbody = document.createElement('tbody');
    state.song.tracks.forEach((tr, i) => {
      const pitches = tr.notes.map(n => n.pitch);
      const range = pitches.length
        ? `${Theory.midiToName(Math.min(...pitches))} 〜 ${Theory.midiToName(Math.max(...pitches))}`
        : '—';
      const row = document.createElement('tr');
      const sel = document.createElement('select');
      for (const role in ROLE_LABELS) {
        const opt = document.createElement('option');
        opt.value = role;
        opt.textContent = ROLE_LABELS[role];
        if (role === tr.role) opt.selected = true;
        sel.appendChild(opt);
      }
      sel.addEventListener('change', () => {
        tr.role = sel.value;
        reanalyzeMidi();
        renderSummary();
        renderChordPanel();
        renderGuitarPanel();
        renderBassPanel();
        renderKeysPanel();
        renderLyricsPanel();
      });
      row.innerHTML = `<td>${escapeHtml(tr.name)}</td>
        <td>${tr.notes.length}</td>
        <td>${range}</td>`;
      const td = document.createElement('td');
      td.appendChild(sel);
      row.appendChild(td);
      tbody.appendChild(row);
    });
    table.appendChild(tbody);
    holder.appendChild(table);
    const note = document.createElement('p');
    note.className = 'hint';
    note.textContent = '割当を変えると、タブ譜・五線譜・コード解析が自動で更新されます(ドラム・「使わない」はコード解析から除外)。';
    holder.appendChild(note);
  }

  /* ==================== 書き出し ==================== */
  function exportBar(buttons) {
    const bar = document.createElement('div');
    bar.className = 'export-bar';
    for (const [label, fn] of buttons) {
      const btn = document.createElement('button');
      btn.className = 'btn btn-export';
      btn.textContent = label;
      btn.addEventListener('click', fn);
      bar.appendChild(btn);
    }
    return bar;
  }

  function exportAllText() {
    if (!state.chords.length && !state.song) return;
    const m = currentMeta();
    const parts = [];
    parts.push(Exporter.chordSheet(state.chords, m).split('\n').slice(7).join('\n'));
    if (state.lyrics.lines.length > 0) {
      parts.push(Exporter.lyricsSheet(computeLyricsLayout(), m).split('\n').slice(7).join('\n'));
    }
    if (state.activeSource === 'midi') {
      for (const tr of tracksByRole('guitar')) {
        const events = notesToEvents(tr.notes);
        const assigned = attachArtics(Theory.assignFrets(events, Theory.GUITAR_TUNING), events);
        parts.push(Exporter.textTab(assigned, {
          ...m, strings: 6, stringNames: tabStringNames(['e', 'B', 'G', 'D', 'A', 'E']),
          flip: state.tabFlip, tuning: Theory.GUITAR_TUNING,
          chords: state.chords, instLabel: `ギター: ${tr.name}`,
        }).split('\n').slice(7).join('\n'));
      }
      for (const tr of tracksByRole('bass')) {
        const events = notesToEvents(tr.notes);
        const assigned = attachArtics(Theory.assignFrets(events, Theory.BASS_TUNING), events);
        parts.push(Exporter.textTab(assigned, {
          ...m, strings: 4, stringNames: tabStringNames(['G', 'D', 'A', 'E']),
          flip: state.tabFlip, tuning: Theory.BASS_TUNING,
          chords: state.chords, instLabel: `ベース: ${tr.name}`,
        }).split('\n').slice(7).join('\n'));
      }
      const useFlat = Theory.keyUsesFlat(state.key);
      for (const tr of [...tracksByRole('keys'), ...tracksByRole('melody')]) {
        parts.push(Exporter.doremiSheet(tr.notes, { ...m, useFlat, instLabel: tr.name })
          .split('\n').slice(7).join('\n'));
      }
    }
    Exporter.download(Exporter.fullPack(parts, m), `${state.title}_参考採譜パック.txt`);
  }

  function printAll() {
    document.body.classList.add('print-all');
    window.print();
    setTimeout(() => document.body.classList.remove('print-all'), 500);
  }

  /* ==================== タブ切替 ==================== */
  function switchTab(tab) {
    $$('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    $$('.panel').forEach(p => p.classList.toggle('active', p.id === 'panel-' + tab));
  }

  function midiHintHtml(what) {
    return `<div class="hint hint-box">
      <p><strong>${what}は「ステム分離したMIDI」から生成します。</strong></p>
      <p>音源ファイルだけの場合は「コード進行」タブでコード解析結果をご覧いただけます。</p>
      <p>高精度な楽器別採譜の手順は、ページ下部の「高精度採譜ガイド」をご覧ください。</p>
    </div>`;
  }

  function escapeHtml(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

})();
