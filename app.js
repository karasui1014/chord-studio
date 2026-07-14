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
    lyrics: { raw: '', lines: [], editing: true, startBar: 1, barsPerLine: 'auto', mode: 'auto' },
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
        await analyzeMidiFiles(st.stems, st.audio);
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
  // Basic Pitch等が書き出すMIDIは「秒」は正確でも小節・拍(テンポマップ)が
  // 当てにならないことが多い。楽曲ファイルが一緒にあれば、実音源から
  // ビートを検出してMIDIの音符をそのビート格子に貼り直す(=タイミングが合う)。
  async function analyzeMidiFiles(files, audioFile) {
    if (state.song && state.song.mixWavUrl) URL.revokeObjectURL(state.song.mixWavUrl);
    showProgress('MIDIを解析中…');
    const parsed = [];
    for (const f of files) {
      const buf = await f.arrayBuffer();
      parsed.push(MidiParser.parse(buf, f.name));
    }
    state.title = audioFile
      ? audioFile.name.replace(/\.[^.]+$/, '')
      : (files.length === 1
          ? files[0].name.replace(/\.[^.]+$/, '')
          : files[0].name.replace(/\.[^.]+$/, '') + ' 他' + (files.length - 1) + 'ファイル');
    const song = MidiParser.buildSong(parsed);

    if (audioFile) {
      $('#progressMsg').textContent = '実音源からビートとコードを解析中… — 端末内で処理中';
      const res = await AudioAnalyzer.analyze(await audioFile.arrayBuffer(), p => setProgress(0.3 + 0.6 * p));
      const grid = Transcriber.makeBeatGrid(res.beatTimes, res.bpm);
      const midiTickToSec = song.tickToSec; // MIDI自身のテンポマップ(秒は正確)
      for (const tr of song.tracks) {
        for (const nt of tr.notes) {
          const sec = midiTickToSec(nt.tick);
          const endSec = midiTickToSec(nt.tick + nt.durTick);
          const beat = Math.round(grid.secToBeat(sec) * 2) / 2; // 8分グリッドに整える
          const durBeat = Math.max(0.5, Math.round((grid.secToBeat(endSec) - beat) * 2) / 2);
          nt.beat = beat;
          nt.durBeat = durBeat;
          nt.tick = Math.round(beat * song.ppq);
          nt.durTick = Math.max(1, Math.round(durBeat * song.ppq));
        }
      }
      let maxBeat = 4;
      for (const tr of song.tracks) for (const nt of tr.notes) maxBeat = Math.max(maxBeat, nt.beat + nt.durBeat);
      song.bpm = res.bpm;
      song.totalBars = Math.max(res.totalBars, Math.ceil(maxBeat / song.beatsPerBar));
      song.tickToSec = t => grid.beatToSec(t / song.ppq);
      song.chordResult = res; // コード進行も実音源から(Basic PitchのノイズをかわすBest判断)
      song.synced = true;
    }

    state.song = song;
    reanalyzeMidi();
    hideProgress();
    renderResults();
  }

  function reanalyzeMidi() {
    const song = state.song;
    let key, chords;
    if (song.chordResult) {
      // ステム採譜・実音源同期MIDI: ミックスのクロマ解析結果をそのまま使う
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
    state.lyrics = { raw: '', lines: [], editing: true, startBar: 1, barsPerLine: 'auto', mode: 'auto' };
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
          : (state.song && state.song.synced
              ? '<span class="badge badge-midi">MIDI採譜+実音源同期</span>'
              : '<span class="badge badge-midi">MIDI採譜</span>'))
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
  // 再生は実音源のみ: ①読み込んだ楽曲ファイル ②ステム合成ミックス
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
        startHighlightLoop(() => audio.currentTime);
      });
      audio.addEventListener('pause', stopHighlightLoop);
      audio.addEventListener('ended', stopHighlightLoop);
    } else {
      const hint = document.createElement('p');
      hint.className = 'hint';
      hint.textContent = '▶ 再生して同期表示するには「①楽曲ファイル」もセットして解析してください。';
      holder.appendChild(hint);
    }
    if (state.song && (state.song.kind === 'stems' || state.song.synced)) {
      const half = document.createElement('button');
      half.className = 'btn btn-small';
      half.textContent = 'テンポ÷2';
      half.addEventListener('click', () => scaleTempo(0.5));
      const dbl = document.createElement('button');
      dbl.className = 'btn btn-small';
      dbl.textContent = 'テンポ×2';
      dbl.addEventListener('click', () => scaleTempo(2));
      const shiftL = document.createElement('button');
      shiftL.className = 'btn btn-small';
      shiftL.textContent = '小節頭←1拍';
      shiftL.addEventListener('click', () => shiftBeatGrid(-1));
      const shiftR = document.createElement('button');
      shiftR.className = 'btn btn-small';
      shiftR.textContent = '小節頭→1拍';
      shiftR.addEventListener('click', () => shiftBeatGrid(1));
      const note = document.createElement('span');
      note.className = 'hint';
      note.textContent = ' テンポ=BPMが倍/半分のとき、小節頭=コードの変わり目が小節の頭に来ないとき';
      holder.appendChild(dbl);
      holder.appendChild(half);
      holder.appendChild(shiftL);
      holder.appendChild(shiftR);
      holder.appendChild(note);
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

  // 小節頭の1拍補正: ビート格子の先頭を1拍分ずらす。
  // 全イベントの「秒」は保ったまま、小節の区切りだけが動く。
  function shiftBeatGrid(dir) {
    const song = state.song;
    if (!song || !song.chordResult) return;
    stopAllPlayback();
    const bt = song.chordResult.beatTimes;
    if (dir > 0) {
      if (bt.length <= 6) return;
      song.chordResult.beatTimes = bt.slice(1);
    } else {
      const p = Math.max(0.2, bt[1] - bt[0]);
      song.chordResult.beatTimes = [Math.max(0, bt[0] - p), ...bt];
    }
    const shift = dir > 0 ? -1 : 1;
    const clampChords = [];
    for (const c of song.chordResult.chords) {
      const s = c.startBeat + shift, e = c.endBeat + shift;
      if (e <= 0) continue;
      c.startBeat = Math.max(0, s);
      c.endBeat = e;
      clampChords.push(c);
    }
    song.chordResult.chords = clampChords;
    for (const tr of song.tracks) {
      for (const n of tr.notes) {
        n.beat = Math.max(0, n.beat + shift);
        n.tick = Math.round(n.beat * song.ppq);
      }
    }
    const grid = Transcriber.makeBeatGrid(song.chordResult.beatTimes, song.bpm);
    song.tickToSec = t => grid.beatToSec(t / song.ppq);
    song.chordResult.totalBars = Math.max(1, Math.ceil((song.chordResult.beatTimes.length - 1) / song.beatsPerBar));
    let maxBeat = 4;
    for (const tr of song.tracks) for (const n of tr.notes) maxBeat = Math.max(maxBeat, n.beat + n.durBeat);
    song.totalBars = Math.max(song.chordResult.totalBars, Math.ceil(maxBeat / song.beatsPerBar));
    reanalyzeMidi();
    renderResults();
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

  function stopAllPlayback() {
    stopHighlightLoop();
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
    renderBassPanel();
    renderKeysPanel();
  }

  function refreshScorePanels() {
    renderGuitarPanel();
    renderBassPanel();
    renderKeysPanel();
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
  /* ---------- ボーカルフレーズ検出 ----------
   * 採譜済みのボーカル(melodyロール)から「歌っている区間」を検出する。
   * 休符(1.2拍以上)でフレーズを区切る。 */
  function vocalPhrases() {
    if (!state.song) return null;
    const vocal = state.song.tracks.find(t => t.role === 'melody' && t.notes.length >= 8);
    if (!vocal) return null;
    const notes = [...vocal.notes].sort((a, b) => a.beat - b.beat);
    const phrases = [];
    let cur = null;
    for (const n of notes) {
      if (!cur || n.beat - cur.endBeat >= 1.2) {
        cur = { startBeat: n.beat, endBeat: n.beat + n.durBeat };
        phrases.push(cur);
      } else {
        cur.endBeat = Math.max(cur.endBeat, n.beat + n.durBeat);
      }
    }
    return phrases.filter(p => p.endBeat - p.startBeat >= 0.5);
  }

  /* 歌詞行をボーカルフレーズに割り付ける。
   * 行の頭は必ずいずれかのフレーズ頭に置く(歌い出しは必ずフレーズ頭のため)。
   * どのフレーズ頭にするかは「歌唱タイムライン」(フレーズ部分だけを繋いだ
   * 時間軸)上で行を等分した位置に最も近いものを、単調順序を保って選ぶ。 */
  function layoutFromVocals(nLines, phrases) {
    const nP = phrases.length;
    const durs = phrases.map(p => p.endBeat - p.startBeat);
    const total = durs.reduce((a, b) => a + b, 0);
    if (total <= 0) return null;
    const cumStart = [0];
    for (let i = 0; i < nP - 1; i++) cumStart.push(cumStart[i] + durs[i]);

    const spans = [];
    if (nP >= nLines) {
      // 行ごとに開始フレーズを単調に選ぶ(残り行数ぶんのフレーズは必ず残す)
      const startIdxs = [];
      let idx = 0;
      for (let li = 0; li < nLines; li++) {
        const target = li * total / nLines;
        const maxIdx = nP - (nLines - li);
        let best = Math.min(idx, maxIdx);
        for (let i = idx; i <= maxIdx; i++) {
          if (Math.abs(cumStart[i] - target) < Math.abs(cumStart[best] - target)) best = i;
        }
        startIdxs.push(best);
        idx = best + 1;
      }
      for (let li = 0; li < nLines; li++) {
        const s = phrases[startIdxs[li]].startBeat;
        const endIdx = li < nLines - 1 ? startIdxs[li + 1] - 1 : nP - 1;
        const e = Math.max(s + 1, phrases[endIdx].endBeat);
        spans.push({ startBeat: s, endBeat: e });
      }
    } else {
      // 行数の方が多い: フレーズ内をタイムライン等分で分割
      const pos = u => {
        let acc = 0;
        for (let i = 0; i < nP; i++) {
          if (u <= acc + durs[i] || i === nP - 1) {
            return phrases[i].startBeat + Math.min(durs[i], Math.max(0, u - acc));
          }
          acc += durs[i];
        }
        return phrases[nP - 1].endBeat;
      };
      for (let li = 0; li < nLines; li++) {
        const s = pos(li * total / nLines);
        const e = li === nLines - 1 ? phrases[nP - 1].endBeat : pos((li + 1) * total / nLines);
        spans.push({ startBeat: s, endBeat: Math.max(s + 1, e) });
      }
    }
    return spans;
  }

  function buildLyricLine(text, startBeat, endBeat, chords, m) {
    const lineChords = chords
      .filter(c => c.startBeat < endBeat && c.endBeat > startBeat)
      .map(c => ({
        label: c.label,
        pos: Math.max(0, (c.startBeat - startBeat) / (endBeat - startBeat)),
      }));
    return {
      text,
      bar: Math.floor(startBeat / m.beatsPerBar) + 1,
      startBeat, endBeat,
      startSec: beatToSec(startBeat),
      endSec: beatToSec(endBeat),
      chords: lineChords,
    };
  }

  function computeLyricsLayout() {
    const L = state.lyrics;
    const m = currentMeta();
    const sungCount = L.lines.filter(l => !l.blank).length;
    if (sungCount === 0) return [];
    const chords = displayedChords();
    const out = [];

    // 自動モード: ボーカルフレーズに合わせる(検出できた場合)
    if ((L.mode || 'auto') === 'auto') {
      const phrases = vocalPhrases();
      const spans = phrases && phrases.length >= 2 ? layoutFromVocals(sungCount, phrases) : null;
      if (spans) {
        let si = 0;
        for (const line of L.lines) {
          if (line.blank) { out.push({ blank: true }); continue; }
          const sp = spans[si++];
          out.push(buildLyricLine(line.text, sp.startBeat, sp.endBeat, chords, m));
        }
        out._autoAligned = true;
        return out;
      }
    }

    // 手動モード(またはボーカル未検出): 小節数で均等割付
    const startBar = Math.max(0, (L.startBar || 1) - 1);
    const avail = Math.max(1, m.totalBars - startBar);
    const stride = L.barsPerLine === 'auto'
      ? avail / sungCount
      : Number(L.barsPerLine);
    let cursor = startBar;
    for (const line of L.lines) {
      if (line.blank) { out.push({ blank: true }); continue; }
      const b0 = cursor, b1 = cursor + stride;
      cursor = b1;
      out.push(buildLyricLine(line.text, b0 * m.beatsPerBar, b1 * m.beatsPerBar, chords, m));
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
        refreshScorePanels(); // 譜面内の歌詞表示にも反映
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

    // 合わせ方: 自動(ボーカルフレーズに割付) / 手動(小節数で均等割付)
    const hasVocal = !!vocalPhrases();
    const modeLabel = document.createElement('label');
    modeLabel.className = 'ly-ctrl';
    modeLabel.textContent = '合わせ方 ';
    const modeSel = document.createElement('select');
    for (const [v, t] of [['auto', hasVocal ? '自動(ボーカルに合わせる)' : '自動(ボーカル未検出)'], ['manual', '手動(小節数で割付)']]) {
      const opt = document.createElement('option');
      opt.value = v;
      opt.textContent = t;
      if ((L.mode || 'auto') === v) opt.selected = true;
      modeSel.appendChild(opt);
    }
    modeSel.addEventListener('change', () => {
      L.mode = modeSel.value;
      renderLyricsPanel();
      refreshScorePanels();
    });
    modeLabel.appendChild(modeSel);
    bar.appendChild(modeLabel);

    const isAuto = (L.mode || 'auto') === 'auto' && hasVocal;
    if (!isAuto) {
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
        refreshScorePanels();
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
        refreshScorePanels();
      });
      strideLabel.appendChild(strideSel);
      bar.appendChild(strideLabel);
    }

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
    hint.textContent = isAuto
      ? '🎤 ボーカルの歌いフレーズを検出して、各行を実際の歌い出しに合わせています。行の区切りがズレる場合は「手動」に切り替えて調整できます。'
      : '再生すると今歌っている行がハイライトされます。ズレるときは「歌い出しの小節」(イントロの長さぶん)と「1行あたりの小節数」を調整してください。';
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

  // 譜面に埋め込む歌詞レイアウト(セットされていなければnull)
  function lyricsForScores() {
    if (!state.lyrics.lines.length) return null;
    const layout = computeLyricsLayout().filter(l => !l.blank);
    return layout.length ? layout : null;
  }

  // ステム採譜のギター用: コードの押さえ方(フレット)を小節頭・コード変化点に置くイベント列
  // (音源からの細かい単音採譜はノイズが多いため、コード弾き主体の見やすい譜面にする)
  function chordShapeEvents(m) {
    const shift = displayShift();
    const useFlat = Theory.keyUsesFlat(displayedKey() || state.key);
    const evs = [];
    for (const c of state.chords) {
      const root = ((c.root + shift) % 12 + 12) % 12;
      const shape = Theory.guitarShape(root, c.suffix, useFlat);
      if (!shape) continue;
      const positions = new Set([c.startBeat]);
      for (let b = Math.floor(c.startBeat / m.beatsPerBar) + 1; b * m.beatsPerBar < c.endBeat - 0.01; b++) {
        positions.add(b * m.beatsPerBar);
      }
      for (const beat of positions) {
        evs.push({
          time: beat,
          dur: Math.min(m.beatsPerBar, c.endBeat - beat),
          notes: shape.frets
            .map((f, i) => (f >= 0 ? { string: i, fret: f } : null))
            .filter(Boolean),
        });
      }
    }
    evs.sort((a, b) => a.time - b.time);
    return evs;
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

      // ステム採譜: 細かい単音採譜はノイズが多いので、コードの押さえ方+ストロークの
      // 「コード弾き譜」にする。MIDI読み込み時は正確なので実際の音をTAB化する。
      const isStems = state.song && state.song.kind === 'stems';
      const names = tabStringNames(['e', 'B', 'G', 'D', 'A', 'E']);
      let assigned;
      if (isStems) {
        assigned = chordShapeEvents(m);
      } else {
        const events = notesToEvents(tr.notes);
        assigned = attachArtics(Theory.assignFrets(events, Theory.GUITAR_TUNING), events);
      }
      const svg = Renderer.tabSVG(assigned, {
        strings: 6, stringNames: names, flip: state.tabFlip, tuning: Theory.GUITAR_TUNING,
        beatsPerBar: m.beatsPerBar, totalBars: m.totalBars, chords: displayedChords(),
        showStrum: true, strumFill: isStems, lyrics: lyricsForScores(),
      });
      sec.appendChild(tabControls());
      const strumNote = document.createElement('p');
      strumNote.className = 'hint';
      strumNote.textContent = isStems
        ? 'コードの押さえ方(フレット)を小節頭とコード変化点に表示しています。⊓=ダウン / V=アップは8分音符ベースの一般的なストローク目安です(実際のピック方向の検出ではありません)。'
        : '⊓=ダウン / V=アップ。8分音符ベースの一般的な弾き方の目安です(音源から実際のピック方向を検出したものではありません)。';
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
        beatsPerBar: m.beatsPerBar, totalBars: m.totalBars, chords: displayedChords(),
        rhythm: true, lyrics: lyricsForScores(),
      });
      sec.appendChild(tabControls());
      const rhythmNote = document.createElement('p');
      rhythmNote.className = 'hint';
      rhythmNote.textContent = '数字の下の棒=リズム(棒のみ=4分音符 / 旗1つ=8分音符 / 旗2つ=16分音符 / 棒なし=長い音)。';
      sec.appendChild(rhythmNote);
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
        beatsPerBar: m.beatsPerBar, totalBars: m.totalBars, chords: displayedChords(),
        useFlat, grand: !isMelody || notes.some(n => n.pitch < 55),
        lyrics: lyricsForScores(),
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
        let assigned;
        if (state.song && state.song.kind === 'stems') {
          assigned = chordShapeEvents(m);
        } else {
          const events = notesToEvents(tr.notes);
          assigned = attachArtics(Theory.assignFrets(events, Theory.GUITAR_TUNING), events);
        }
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
