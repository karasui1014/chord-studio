/* =========================================================
 * midi.js — Standard MIDI File パーサ & 楽曲モデル構築
 * SMF format 0/1 対応。テンポマップ・拍子・トラック名・音符抽出。
 * ======================================================= */
'use strict';

const MidiParser = (() => {

  function parse(arrayBuffer, fileName) {
    const data = new DataView(arrayBuffer);
    const bytes = new Uint8Array(arrayBuffer);
    let pos = 0;

    function readStr(n) {
      let s = '';
      for (let i = 0; i < n; i++) s += String.fromCharCode(bytes[pos + i]);
      pos += n;
      return s;
    }
    function readU32() { const v = data.getUint32(pos); pos += 4; return v; }
    function readU16() { const v = data.getUint16(pos); pos += 2; return v; }
    function readU8() { return bytes[pos++]; }
    function readVar() {
      let v = 0;
      for (;;) {
        const b = readU8();
        v = (v << 7) | (b & 0x7f);
        if (!(b & 0x80)) return v;
      }
    }

    if (readStr(4) !== 'MThd') throw new Error('MIDIファイルではありません');
    const hdrLen = readU32();
    const format = readU16();
    const nTracks = readU16();
    const division = readU16();
    pos += hdrLen - 6;
    if (division & 0x8000) throw new Error('SMPTEタイムコードのMIDIは未対応です');
    const ppq = division;

    const tracks = [];
    const tempoEvents = [];   // {tick, usPerBeat}
    const timeSigEvents = []; // {tick, num, den}

    for (let t = 0; t < nTracks; t++) {
      if (pos + 8 > bytes.length) break;
      const id = readStr(4);
      const len = readU32();
      if (id !== 'MTrk') { pos += len; continue; }
      const end = pos + len;
      let tick = 0;
      let runningStatus = 0;
      let trackName = '';
      const notes = [];
      const open = {}; // key: ch*128+pitch → {tick, vel}
      const programs = {}; // ch → program
      let firstProgram = null;
      const channels = new Set();

      while (pos < end) {
        tick += readVar();
        let status = bytes[pos];
        if (status & 0x80) { pos++; runningStatus = status; }
        else status = runningStatus;

        const type = status & 0xf0;
        const ch = status & 0x0f;

        if (type === 0x90 || type === 0x80) {
          const pitch = readU8();
          const vel = readU8();
          const key = ch * 128 + pitch;
          if (type === 0x90 && vel > 0) {
            if (open[key]) { // 連続ノートオン → 前を閉じる
              notes.push({ tick: open[key].tick, durTick: Math.max(1, tick - open[key].tick), pitch, vel: open[key].vel, ch });
            }
            open[key] = { tick, vel };
            channels.add(ch);
          } else {
            if (open[key]) {
              notes.push({ tick: open[key].tick, durTick: Math.max(1, tick - open[key].tick), pitch, vel: open[key].vel, ch });
              delete open[key];
            }
          }
        } else if (type === 0xc0) {
          const prog = readU8();
          programs[ch] = prog;
          if (firstProgram === null) firstProgram = prog;
        } else if (type === 0xd0) {
          pos += 1;
        } else if (type === 0xa0 || type === 0xb0 || type === 0xe0) {
          pos += 2;
        } else if (status === 0xff) {
          const metaType = readU8();
          const metaLen = readVar();
          if (metaType === 0x03 && !trackName) {
            trackName = decodeText(bytes.subarray(pos, pos + metaLen));
            pos += metaLen;
          } else if (metaType === 0x51 && metaLen === 3) {
            const usPerBeat = (bytes[pos] << 16) | (bytes[pos + 1] << 8) | bytes[pos + 2];
            tempoEvents.push({ tick, usPerBeat });
            pos += 3;
          } else if (metaType === 0x58 && metaLen >= 2) {
            timeSigEvents.push({ tick, num: bytes[pos], den: Math.pow(2, bytes[pos + 1]) });
            pos += metaLen;
          } else {
            pos += metaLen;
          }
        } else if (status === 0xf0 || status === 0xf7) {
          const sysLen = readVar();
          pos += sysLen;
        } else {
          pos++;
        }
      }
      // 閉じ忘れノート
      for (const key in open) {
        const pitch = key % 128, ch = Math.floor(key / 128);
        notes.push({ tick: open[key].tick, durTick: ppq, pitch, vel: open[key].vel, ch });
      }
      pos = end;
      if (notes.length > 0 || trackName) {
        notes.sort((a, b) => a.tick - b.tick || a.pitch - b.pitch);
        tracks.push({ name: trackName, notes, programs, firstProgram, channels: [...channels] });
      }
    }

    if (tempoEvents.length === 0) tempoEvents.push({ tick: 0, usPerBeat: 500000 });
    tempoEvents.sort((a, b) => a.tick - b.tick);
    if (timeSigEvents.length === 0) timeSigEvents.push({ tick: 0, num: 4, den: 4 });
    timeSigEvents.sort((a, b) => a.tick - b.tick);

    return { fileName, format, ppq, tracks, tempoEvents, timeSigEvents };
  }

  function decodeText(bytes) {
    try { return new TextDecoder('shift-jis').decode(bytes); }
    catch (e) {
      try { return new TextDecoder('utf-8').decode(bytes); }
      catch (e2) { return String.fromCharCode(...bytes); }
    }
  }

  /* tick → 秒 変換テーブル */
  function buildTempoMap(tempoEvents, ppq) {
    const map = [];
    let sec = 0, lastTick = 0, usPerBeat = 500000;
    for (const ev of tempoEvents) {
      sec += ((ev.tick - lastTick) / ppq) * (usPerBeat / 1e6);
      lastTick = ev.tick;
      usPerBeat = ev.usPerBeat;
      map.push({ tick: ev.tick, sec, usPerBeat });
    }
    return {
      tickToSec(tick) {
        let e = map[0];
        for (const m of map) { if (m.tick <= tick) e = m; else break; }
        return e.sec + ((tick - e.tick) / ppq) * (e.usPerBeat / 1e6);
      },
      bpmAt(tick) {
        let e = map[0];
        for (const m of map) { if (m.tick <= tick) e = m; else break; }
        return 60e6 / e.usPerBeat;
      }
    };
  }

  /* ---------- 楽器ロール自動推定 ---------- */
  function guessRole(track) {
    const name = (track.name || '').toLowerCase();
    const prog = track.firstProgram;
    const drumCh = track.channels.includes(9);
    if (drumCh || /drum|perc|ドラム|パーカス|kick|snare|beat/.test(name)) return 'drums';
    if (/bass|ベース/.test(name)) return 'bass';
    if (/guitar|gt\b|gtr|ギター|strum/.test(name)) return 'guitar';
    if (/piano|key|organ|ep|rhodes|synth|pad|ピアノ|キーボード|鍵盤|シンセ/.test(name)) return 'keys';
    if (/vocal|melody|lead|voice|vox|ボーカル|メロ|歌/.test(name)) return 'melody';
    if (prog !== null && prog !== undefined) {
      if (prog >= 32 && prog <= 39) return 'bass';
      if (prog >= 24 && prog <= 31) return 'guitar';
      if ((prog >= 0 && prog <= 23)) return 'keys';
      if (prog >= 80 && prog <= 95) return 'keys';
      if (prog >= 40 && prog <= 79) return 'melody';
      if (prog >= 112) return 'drums';
    }
    // 音域から推定
    const pitches = track.notes.map(n => n.pitch);
    if (pitches.length === 0) return 'skip';
    const avg = pitches.reduce((a, b) => a + b, 0) / pitches.length;
    const poly = polyphonyRatio(track.notes);
    if (avg < 48) return 'bass';
    if (poly > 0.5) return 'keys';
    return 'melody';
  }

  function polyphonyRatio(notes) {
    if (notes.length < 4) return 0;
    let overlap = 0;
    for (let i = 1; i < notes.length; i++) {
      if (notes[i].tick < notes[i - 1].tick + notes[i - 1].durTick &&
          notes[i].tick === notes[i - 1].tick) overlap++;
    }
    return overlap / notes.length;
  }

  /* ---------- 複数MIDIファイル → 統合ソングモデル ---------- */
  function buildSong(parsedFiles) {
    // 基準: 最初のファイルのテンポ・拍子・PPQ
    const base = parsedFiles[0];
    const ppq = base.ppq;
    const tempoMap = buildTempoMap(base.tempoEvents, ppq);
    const ts = base.timeSigEvents[0];
    const beatsPerBar = ts.num * (4 / ts.den);
    const bpm = Math.round(tempoMap.bpmAt(0) * 10) / 10;

    const tracks = [];
    for (const pf of parsedFiles) {
      const scale = ppq / pf.ppq; // PPQが違うファイルはtickスケール変換
      for (const tr of pf.tracks) {
        if (tr.notes.length === 0) continue;
        const notes = tr.notes.map(n => ({
          tick: Math.round(n.tick * scale),
          durTick: Math.max(1, Math.round(n.durTick * scale)),
          pitch: n.pitch, vel: n.vel, ch: n.ch,
          beat: (n.tick * scale) / ppq,
          durBeat: (n.durTick * scale) / ppq,
        }));
        const label = tr.name ||
          (parsedFiles.length > 1 ? pf.fileName.replace(/\.(midi?|MIDI?)$/, '') : `トラック${tracks.length + 1}`);
        tracks.push({
          name: label,
          fileName: pf.fileName,
          notes,
          role: guessRole(tr),
          firstProgram: tr.firstProgram,
          channels: tr.channels,
        });
      }
    }

    let maxBeat = 0;
    for (const tr of tracks) {
      for (const n of tr.notes) maxBeat = Math.max(maxBeat, n.beat + n.durBeat);
    }
    const totalBars = Math.max(1, Math.ceil(maxBeat / beatsPerBar));

    return {
      source: 'midi',
      ppq, bpm, timeSig: { num: ts.num, den: ts.den },
      beatsPerBar, totalBars, tempoMap,
      tracks,
      tickToSec: t => tempoMap.tickToSec(t),
    };
  }

  /* ---------- コード進行解析 (MIDI: 高精度) ---------- */
  function analyzeChords(song) {
    const useTracks = song.tracks.filter(t => t.role !== 'drums' && t.role !== 'skip');
    const allNotes = [];
    // メロディは装飾音が多くテンション誤検出のもとになるので重みを下げる
    for (const tr of useTracks) {
      const roleW = tr.role === 'melody' ? 0.15 : 1.0;
      for (const n of tr.notes) allNotes.push({ ...n, _w: roleW });
    }
    if (allNotes.length === 0) return { key: null, chords: [] };

    // キー判定: 全音符の時価重みヒストグラム
    const hist = new Array(12).fill(0);
    for (const n of allNotes) hist[n.pitch % 12] += n.durBeat * (n.vel / 127);
    const key = Theory.detectKey(hist);

    // 1拍ごとにピッチクラス重み集計 → コード判定 → 同一連結
    const totalBeats = Math.ceil(song.totalBars * song.beatsPerBar);
    const beatVecs = [];
    const bassAtBeat = [];
    for (let b = 0; b < totalBeats; b++) {
      beatVecs.push(new Array(12).fill(0));
      bassAtBeat.push(null);
    }
    for (const n of allNotes) {
      const start = n.beat, end = n.beat + n.durBeat;
      for (let b = Math.floor(start); b < Math.min(Math.ceil(end), totalBeats); b++) {
        const ov = Math.min(end, b + 1) - Math.max(start, b);
        if (ov <= 0.05) continue;
        const w = ov * (0.4 + 0.6 * n.vel / 127) * (n.pitch < 52 ? 1.6 : 1.0) * (n._w || 1);
        beatVecs[b][n.pitch % 12] += w;
        if (bassAtBeat[b] === null || n.pitch < bassAtBeat[b]) bassAtBeat[b] = n.pitch;
      }
    }

    // 半小節単位で判定(動きがあれば拍単位に分割)
    const half = Math.max(1, Math.round(song.beatsPerBar / 2));
    const segs = [];
    for (let b = 0; b < totalBeats; b += half) {
      const vec = new Array(12).fill(0);
      let bass = null;
      for (let i = b; i < Math.min(b + half, totalBeats); i++) {
        for (let pc = 0; pc < 12; pc++) vec[pc] += beatVecs[i][pc];
        if (bassAtBeat[i] !== null && (bass === null || bassAtBeat[i] < bass)) bass = bassAtBeat[i];
      }
      if (vec.every(v => v === 0)) { segs.push(null); continue; }
      const m = Theory.matchChord(vec, bass !== null ? bass % 12 : null);
      segs.push(m ? { ...m, bassPc: bass !== null ? bass % 12 : null, startBeat: b, endBeat: Math.min(b + half, totalBeats) } : null);
    }

    // 連結 & ラベル付け
    const chords = [];
    for (const s of segs) {
      if (!s) continue;
      const last = chords[chords.length - 1];
      if (last && last.root === s.root && last.suffix === s.suffix && last.endBeat === s.startBeat) {
        last.endBeat = s.endBeat;
      } else {
        chords.push({ ...s });
      }
    }
    for (const c of chords) {
      const slashBass = (c.bassPc !== null && c.bassPc !== c.root &&
        c.intervals.some(iv => (c.root + iv) % 12 === c.bassPc)) ? c.bassPc : null;
      c.label = Theory.chordLabel(c.root, c.suffix, key, slashBass);
      c.degree = Theory.degreeName(c.root, c.suffix, key);
    }
    return { key, chords };
  }

  return { parse, buildSong, analyzeChords, guessRole };
})();
