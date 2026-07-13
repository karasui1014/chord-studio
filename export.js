/* =========================================================
 * export.js — 参考採譜のダウンロード生成
 * テキストTAB / コード進行シート / 印刷(PDF)
 * ======================================================= */
'use strict';

const Exporter = (() => {

  function download(text, fileName) {
    const blob = new Blob(['﻿' + text], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = fileName;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  function header(meta) {
    const lines = [];
    lines.push('==========================================');
    lines.push(` ${meta.title || '無題'} — 参考採譜`);
    lines.push('==========================================');
    const info = [];
    if (meta.key) info.push(`キー: ${meta.key}`);
    if (meta.bpm) info.push(`BPM: ${meta.bpm}`);
    if (meta.timeSig) info.push(`拍子: ${meta.timeSig}`);
    lines.push(info.join(' / '));
    lines.push(`作成: コード採譜スタジオ (${new Date().toLocaleDateString('ja-JP')})`);
    lines.push('※ 自動解析による参考採譜です。細部はご自身の耳でご確認ください。');
    lines.push('');
    return lines.join('\n');
  }

  /* ---------- コード進行テキスト ---------- */
  function chordSheet(chords, opts) {
    const beatsPerBar = opts.beatsPerBar || 4;
    const totalBars = opts.totalBars;
    const lines = [header(opts)];
    lines.push('[コード進行]');
    lines.push('');

    const bars = [];
    for (let b = 0; b < totalBars; b++) bars.push([]);
    for (const c of chords) {
      const bar = Math.floor(c.startBeat / beatsPerBar);
      if (bar >= 0 && bar < totalBars) bars[bar].push(c.label);
    }
    const degBars = [];
    for (let b = 0; b < totalBars; b++) degBars.push([]);
    for (const c of chords) {
      const bar = Math.floor(c.startBeat / beatsPerBar);
      if (bar >= 0 && bar < totalBars && c.degree) degBars[bar].push(c.degree);
    }

    for (let row = 0; row < totalBars; row += 4) {
      let line = '|';
      let degLine = ' ';
      for (let b = row; b < Math.min(row + 4, totalBars); b++) {
        const cell = bars[b].length ? ' ' + bars[b].join('  ') + ' ' : ' %  ';
        const degCell = degBars[b].length ? ' ' + degBars[b].join('  ') + ' ' : '    ';
        const w = Math.max(cell.length, degCell.length, 8);
        line += cell.padEnd(w) + '|';
        degLine += degCell.padEnd(w) + ' ';
      }
      lines.push(`${String(row + 1).padStart(3)} ${line}`);
      if (opts.showDegree) lines.push(`    ${degLine}`);
      lines.push('');
    }
    return lines.join('\n');
  }

  /* ---------- テキストTAB ---------- */
  // events: [{time(beat), notes:[{string, fret}]}]  string 0 = 最低音弦
  function textTab(events, opts) {
    const nStrings = opts.strings;
    const stringNames = opts.stringNames; // 上(高音弦)から
    const beatsPerBar = opts.beatsPerBar || 4;
    const totalBars = opts.totalBars;
    const chords = opts.chords || [];
    const divPerBeat = 4;
    const divPerBar = beatsPerBar * divPerBeat;
    const CH = 2; // 1division = 2文字
    const barsPerLine = 2;

    const lines = [header(opts)];
    lines.push(`[${opts.instLabel || 'TAB'}]`);
    lines.push('');

    // グリッド構築
    const grid = new Map();
    for (const ev of events) {
      const div = Math.round(ev.time * divPerBeat);
      if (!grid.has(div)) grid.set(div, []);
      for (const n of ev.notes) grid.get(div).push(n);
    }
    const chordAt = new Map();
    for (const c of chords) {
      chordAt.set(Math.round(c.startBeat * divPerBeat), c.label);
    }

    const nameW = Math.max(...stringNames.map(s => s.length));

    for (let barStart = 0; barStart < totalBars; barStart += barsPerLine) {
      const nBars = Math.min(barsPerLine, totalBars - barStart);
      const width = nBars * (divPerBar * CH + 1);
      // コード行
      let chordLine = ' '.repeat(nameW + 1);
      for (let bi = 0; bi < nBars; bi++) {
        let seg = '|';
        for (let d = 0; d < divPerBar; d++) {
          const div = (barStart + bi) * divPerBar + d;
          const label = chordAt.get(div);
          if (label) {
            seg += label;
            d += Math.ceil(label.length / CH) - 1;
            const pad = Math.ceil(label.length / CH) * CH - label.length;
            seg += ' '.repeat(Math.max(0, pad));
          } else {
            seg += ' '.repeat(CH);
          }
        }
        chordLine += seg.slice(0, divPerBar * CH + 1).padEnd(divPerBar * CH + 1);
      }
      if (chordLine.trim()) lines.push(chordLine.replace(/\|/g, ' '));

      // 各弦の行
      for (let li = 0; li < nStrings; li++) {
        const stringIdx = opts.flip ? li : nStrings - 1 - li; // 標準は上段=高音弦
        let line = stringNames[li].padStart(nameW) + '|';
        for (let bi = 0; bi < nBars; bi++) {
          let seg = '';
          let d = 0;
          while (d < divPerBar) {
            const div = (barStart + bi) * divPerBar + d;
            const notes = grid.get(div) || [];
            const note = notes.find(n => n.string === stringIdx);
            if (note) {
              let s = String(note.fret);
              if (note.artic && opts.tuning && note.toPitch !== null && note.toPitch !== undefined) {
                const toFret = note.toPitch - opts.tuning[note.string];
                if (toFret >= 0 && toFret <= 22) s += (note.artic === 'up' ? '/' : '\\') + toFret;
              }
              seg += s + '-'.repeat(Math.max(0, CH - s.length));
              d += Math.max(1, Math.ceil(s.length / CH));
            } else {
              seg += '-'.repeat(CH);
              d += 1;
            }
          }
          line += seg.slice(0, divPerBar * CH) + '|';
        }
        lines.push(line);
      }
      lines.push('');
    }
    lines.push('(数字=フレット / 縦の並び=同時に弾く音 / 3/5=3から5へのグリス・チョーキング気味の移動)');
    return lines.join('\n');
  }

  /* ---------- 鍵盤: ドレミ譜テキスト ---------- */
  function doremiSheet(notes, opts) {
    const beatsPerBar = opts.beatsPerBar || 4;
    const totalBars = opts.totalBars;
    const useFlat = opts.useFlat || false;
    const lines = [header(opts)];
    lines.push(`[${opts.instLabel || '鍵盤'} — ドレミ譜]`);
    lines.push('');
    const byBar = [];
    for (let b = 0; b < totalBars; b++) byBar.push([]);
    for (const n of notes) {
      const bar = Math.floor(n.beat / beatsPerBar);
      if (bar >= 0 && bar < totalBars) byBar[bar].push(n);
    }
    for (let b = 0; b < totalBars; b++) {
      const items = byBar[b]
        .sort((a, x) => a.beat - x.beat || a.pitch - x.pitch)
        .map(n => {
          const oct = Math.floor(n.pitch / 12) - 1;
          return Theory.doremi(n.pitch % 12, useFlat) + oct;
        });
      lines.push(`${String(b + 1).padStart(3)}小節| ${items.join(' ')}`);
    }
    lines.push('');
    lines.push('(音名の後の数字=オクターブ。4=中央ド近辺)');
    return lines.join('\n');
  }

  /* ---------- コード付き歌詞シート ---------- */
  // layout: computeLyricsLayoutの出力 [{blank} | {text, bar, chords:[{label,pos}]}]
  // コードは歌詞の文字位置に合わせて上の行に配置する(等幅フォント想定)
  function lyricsSheet(layout, meta) {
    const out = [header(meta)];
    out.push('[コード付き歌詞]');
    out.push('');
    for (const line of layout) {
      if (line.blank) { out.push(''); continue; }
      // 日本語は等幅で2桁分として文字位置を計算
      const width = [...line.text].reduce((a, ch) => a + (ch.charCodeAt(0) > 0xff ? 2 : 1), 0);
      let chordLine = '';
      for (const c of line.chords) {
        const col = Math.round(c.pos * Math.max(width, 8));
        if (col > chordLine.length) chordLine += ' '.repeat(col - chordLine.length);
        else if (chordLine.length > 0) chordLine += ' ';
        chordLine += c.label;
      }
      out.push(`   ${chordLine}`);
      out.push(`${String(line.bar).padStart(3)}|${line.text}`);
    }
    out.push('');
    out.push('(行頭の数字=小節番号 / コードの位置はおおよその目安です)');
    return out.join('\n');
  }

  /* ---------- まとめパック ---------- */
  function fullPack(parts, meta) {
    const lines = [header(meta)];
    for (const p of parts) {
      lines.push('');
      lines.push('──────────────────────────────');
      lines.push(p);
    }
    return lines.join('\n');
  }

  function printPage() {
    window.print();
  }

  return { download, chordSheet, textTab, doremiSheet, lyricsSheet, fullPack, printPage, header };
})();
