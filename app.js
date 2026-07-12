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
    showDegree: true,
    audioUrl: null,
    synth: null,
    rafId: null,
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
    $('#btnTransposeDown').addEventListener('click', () => { state.transpose--; renderChordPanel(); });
    $('#btnTransposeUp').addEventListener('click', () => { state.transpose++; renderChordPanel(); });
    $('#btnTransposeReset').addEventListener('click', () => { state.transpose = 0; renderChordPanel(); });
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

  /* ==================== アップローダ ==================== */
  function setupUploaders() {
    const audioInput = $('#audioInput');
    const midiInput = $('#midiInput');
    audioInput.addEventListener('change', () => {
      if (audioInput.files.length) handleAudioFile(audioInput.files[0]);
    });
    midiInput.addEventListener('change', () => {
      if (midiInput.files.length) handleMidiFiles([...midiInput.files]);
    });
    setupDrop($('#audioCard'), files => {
      const f = files.find(f => /\.(mp3|wav|m4a|aac|ogg|flac|webm)$/i.test(f.name) || f.type.startsWith('audio/'));
      if (f) handleAudioFile(f);
    });
    setupDrop($('#midiCard'), files => {
      const mids = files.filter(f => /\.(midi?|MIDI?)$/i.test(f.name));
      if (mids.length) handleMidiFiles(mids);
    });
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

  /* ==================== 音源解析 ==================== */
  async function handleAudioFile(file) {
    stopAllPlayback();
    state.title = file.name.replace(/\.[^.]+$/, '');
    showProgress('音源を解析中… (端末内で処理・アップロードはしていません)');
    try {
      const buf = await file.arrayBuffer();
      const result = await AudioAnalyzer.analyze(buf, p => setProgress(p));
      state.audioResult = result;
      state.activeSource = 'audio';
      state.chords = result.chords;
      state.key = result.key;
      state.transpose = 0;
      if (state.audioUrl) URL.revokeObjectURL(state.audioUrl);
      state.audioUrl = URL.createObjectURL(file);
      hideProgress();
      renderResults();
    } catch (err) {
      hideProgress();
      alert('音源の解析に失敗しました: ' + err.message);
      console.error(err);
    }
  }

  /* ==================== MIDI解析 ==================== */
  async function handleMidiFiles(files) {
    stopAllPlayback();
    showProgress('MIDIを解析中…');
    try {
      const parsed = [];
      for (const f of files) {
        const buf = await f.arrayBuffer();
        parsed.push(MidiParser.parse(buf, f.name));
      }
      state.title = files.length === 1
        ? files[0].name.replace(/\.[^.]+$/, '')
        : files[0].name.replace(/\.[^.]+$/, '') + ' 他' + (files.length - 1) + 'ファイル';
      buildAndAnalyzeMidi(parsed);
      hideProgress();
      renderResults();
    } catch (err) {
      hideProgress();
      alert('MIDIの解析に失敗しました: ' + err.message);
      console.error(err);
    }
  }

  function buildAndAnalyzeMidi(parsedFiles) {
    const song = MidiParser.buildSong(parsedFiles);
    state.song = song;
    reanalyzeMidi();
  }

  function reanalyzeMidi() {
    const song = state.song;
    const { key, chords } = MidiParser.analyzeChords(song);
    // 再生同期用に秒も持たせる
    for (const c of chords) {
      c.startSec = song.tickToSec(c.startBeat * song.ppq);
      c.endSec = song.tickToSec(c.endBeat * song.ppq);
    }
    state.activeSource = 'midi';
    state.chords = chords;
    state.key = key;
  }

  /* ==================== デモデータ ==================== */
  function loadDemo() {
    stopAllPlayback();
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

  /* ==================== 結果描画 ==================== */
  function renderResults() {
    $('#resultsSection').hidden = false;
    renderSummary();
    renderPlayback();
    renderChordPanel();
    renderGuitarPanel();
    renderBassPanel();
    renderKeysPanel();
    renderTracksPanel();
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
      ? '<span class="badge badge-midi">MIDI採譜(高精度)</span>'
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
  function renderPlayback() {
    const holder = $('#playbackArea');
    holder.innerHTML = '';
    if (state.activeSource === 'audio' && state.audioUrl) {
      const audio = document.createElement('audio');
      audio.controls = true;
      audio.src = state.audioUrl;
      audio.id = 'audioPlayer';
      holder.appendChild(audio);
      audio.addEventListener('play', () => startHighlightLoop(() => audio.currentTime));
      audio.addEventListener('pause', stopHighlightLoop);
      audio.addEventListener('ended', stopHighlightLoop);
    } else if (state.activeSource === 'midi') {
      const btn = document.createElement('button');
      btn.className = 'btn btn-play';
      btn.id = 'btnMidiPlay';
      btn.textContent = '▶ 採譜結果を再生 (簡易シンセ)';
      btn.addEventListener('click', toggleMidiPlayback);
      holder.appendChild(btn);
    }
  }

  function toggleMidiPlayback() {
    if (state.synth) { stopMidiPlayback(); return; }
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
    const chips = $$('#panel-chords .chord-chip');
    state.hlTimer = setInterval(() => {
      const t = getTime();
      for (const chip of chips) {
        const s = parseFloat(chip.dataset.startSec);
        const e = parseFloat(chip.dataset.endSec);
        chip.classList.toggle('now', !isNaN(s) && !isNaN(e) && t >= s && t < e);
      }
    }, 100);
  }
  function stopHighlightLoop() {
    if (state.hlTimer) clearInterval(state.hlTimer);
    state.hlTimer = null;
    $$('.chord-chip.now').forEach(c => c.classList.remove('now'));
  }

  /* ==================== コード進行パネル ==================== */
  function transposedChords() {
    if (state.transpose === 0) return state.chords;
    const key = transposedKey();
    return state.chords.map(c => {
      const root = ((c.root + state.transpose) % 12 + 12) % 12;
      return {
        ...c, root,
        label: Theory.chordLabel(root, c.suffix, key, null),
        degree: c.degree,
      };
    });
  }
  function transposedKey() {
    if (!state.key) return null;
    return { ...state.key, tonic: ((state.key.tonic + state.transpose) % 12 + 12) % 12 };
  }

  function renderChordPanel() {
    const m = currentMeta();
    const holder = $('#chordGridHolder');
    const strip = $('#usedChordsHolder');
    holder.innerHTML = '';
    strip.innerHTML = '';
    $('#transposeVal').textContent = (state.transpose > 0 ? '+' : '') + state.transpose;
    const key = transposedKey();
    $('#chordKeyLabel').textContent = key ? 'キー: ' + Theory.keyLabel(key) : '';
    const chords = transposedChords();
    if (chords.length === 0) {
      holder.innerHTML = '<p class="hint">コードが検出できませんでした。</p>';
      return;
    }
    strip.appendChild(Renderer.usedChordStrip(state.chords, state.key, state.transpose));
    holder.appendChild(Renderer.chordGrid(chords, {
      beatsPerBar: m.beatsPerBar, totalBars: m.totalBars, showDegree: state.showDegree,
    }));
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
      });
    }
    return events;
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
      sec.innerHTML = `<h3 class="inst-title">🎸 ${escapeHtml(tr.name)}</h3>`;

      // 使用コードのダイアグラム
      sec.appendChild(Renderer.usedChordStrip(state.chords, state.key, 0));

      const events = notesToEvents(tr.notes);
      const assigned = Theory.assignFrets(events, Theory.GUITAR_TUNING);
      const svg = Renderer.tabSVG(assigned, {
        strings: 6, stringNames: ['e', 'B', 'G', 'D', 'A', 'E'],
        beatsPerBar: m.beatsPerBar, totalBars: m.totalBars, chords: state.chords,
      });
      const wrap = document.createElement('div');
      wrap.className = 'score-scroll';
      wrap.appendChild(svg);
      sec.appendChild(wrap);
      sec.appendChild(exportBar([
        ['📄 TAB譜をダウンロード (.txt)', () => Exporter.download(
          Exporter.textTab(assigned, {
            ...m, strings: 6, stringNames: ['e', 'B', 'G', 'D', 'A', 'E'],
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
      const assigned = Theory.assignFrets(events, Theory.BASS_TUNING);
      const svg = Renderer.tabSVG(assigned, {
        strings: 4, stringNames: ['G', 'D', 'A', 'E'],
        beatsPerBar: m.beatsPerBar, totalBars: m.totalBars, chords: state.chords,
      });
      const wrap = document.createElement('div');
      wrap.className = 'score-scroll';
      wrap.appendChild(svg);
      sec.appendChild(wrap);
      sec.appendChild(exportBar([
        ['📄 TAB譜をダウンロード (.txt)', () => Exporter.download(
          Exporter.textTab(assigned, {
            ...m, strings: 4, stringNames: ['G', 'D', 'A', 'E'],
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
      const lo = Math.min(...pitches), hi = Math.max(...pitches);
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
      });
      row.innerHTML = `<td>${escapeHtml(tr.name)}</td>
        <td>${tr.notes.length}</td>
        <td>${Theory.midiToName(lo)} 〜 ${Theory.midiToName(hi)}</td>`;
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
    if (state.activeSource === 'midi') {
      for (const tr of tracksByRole('guitar')) {
        const assigned = Theory.assignFrets(notesToEvents(tr.notes), Theory.GUITAR_TUNING);
        parts.push(Exporter.textTab(assigned, {
          ...m, strings: 6, stringNames: ['e', 'B', 'G', 'D', 'A', 'E'],
          chords: state.chords, instLabel: `ギター: ${tr.name}`,
        }).split('\n').slice(7).join('\n'));
      }
      for (const tr of tracksByRole('bass')) {
        const assigned = Theory.assignFrets(notesToEvents(tr.notes), Theory.BASS_TUNING);
        parts.push(Exporter.textTab(assigned, {
          ...m, strings: 4, stringNames: ['G', 'D', 'A', 'E'],
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
