// The Jam view's DOM: the message, the scale block with the line that says why a scale is proposed and the list of the scales that
// fit (buttons that switch while one can be chosen, plain text when none can), the seven degree chips, the
// status box, the coming-up rows and the piano, built with DOM methods only. Every text reaches
// the page through textContent, title or setAttribute, never as markup: a part name comes from
// the code and is not trusted. The view attaches no right-click listener: page/main.js owns the
// only one. No DOM access at import time: main.js calls createJamView() with its document, so
// this module can be loaded anywhere. The words and the model come from page/jam-model.js.

import { JAM_COPY, statusAnnounceKey, noteDescriptor, pianoKeys, keyLabel, keyTitle, fretCells, fretUnits, legendEntries, STRING_NAMES, FRET_NUMBERS } from './jam-model.js';

const DEGREE_COUNT = 7;

/**
 * Builds the Jam view's DOM once and returns `{ showMessage, render, setPreferences }`.
 * `onInstrumentChange(name)` is called with 'piano' or 'guitar' when the user picks the other
 * segment, `onChordTonesChange(checked)` when the user flips the Chord tones checkbox,
 * `onScaleChoice({ setKey, key })` when the user picks a scale that is not the one in use (a click, or Enter or Space on
 * the focused button); a handler that throws is caught and said once per set of candidates. The view never touches
 * browser storage and never chooses: main.js owns the preferences and the choice.
 */
export function createJamView({ document, onInstrumentChange, onChordTonesChange, onScaleChoice }) {
  if (typeof onScaleChoice !== 'function') throw new Error('Moontide: createJamView needs onScaleChoice, a function that takes { setKey, key }.');
  const jamView = document.getElementById('jam-view');
  const jamMessage = document.getElementById('jam-message');
  const jamMessageText = document.getElementById('jam-message-text');
  const jamMessageSub = document.getElementById('jam-message-sub');
  const jamBody = document.getElementById('jam-body');
  const jamDeclared = document.getElementById('jam-declared');
  const jamDeclaredLabel = document.getElementById('jam-declared-label');
  const jamDeclaredValue = document.getElementById('jam-declared-value');
  const jamDeclaredSection = document.getElementById('jam-declared-section');
  const jamScale = document.getElementById('jam-scale');
  const jamScaleLabel = document.getElementById('jam-scale-label');
  const jamScaleName = document.getElementById('jam-scale-name');
  const jamScaleSub = document.getElementById('jam-scale-sub');
  const jamReason = document.getElementById('jam-reason');
  const jamReasonLead = document.getElementById('jam-reason-lead');
  const jamReasonRest = document.getElementById('jam-reason-rest');
  const jamCandidates = document.getElementById('jam-candidates');
  const jamCandidatesLabel = document.getElementById('jam-candidates-label');
  const jamCandidateList = document.getElementById('jam-candidate-list');
  const jamCandidatesMore = document.getElementById('jam-candidates-more');
  const jamDegrees = document.getElementById('jam-degrees');
  const jamStatus = document.getElementById('jam-status');
  const jamStatusLead = document.getElementById('jam-status-lead');
  const jamStatusRest = document.getElementById('jam-status-rest');
  const jamStatusTime = document.getElementById('jam-status-time');
  const jamStatusSpoken = document.getElementById('jam-status-spoken');
  const jamPaused = document.getElementById('jam-paused');
  const jamComingCaption = document.getElementById('jam-coming-caption');
  const jamRows = document.getElementById('jam-rows');
  const jamPiano = document.getElementById('jam-piano');
  const jamGuitar = document.getElementById('jam-guitar');
  const jamInstrumentSwitch = document.getElementById('jam-instrument-switch');
  const jamInstrumentPiano = document.getElementById('jam-instrument-piano');
  const jamInstrumentGuitar = document.getElementById('jam-instrument-guitar');
  const jamChordTones = document.getElementById('jam-chord-tones');
  const jamChordTonesText = document.getElementById('jam-chord-tones-text');
  const jamLegend = document.getElementById('jam-legend');
  const jamLegendChord = document.getElementById('jam-legend-chord');
  const jamChord = document.getElementById('jam-chord');

  // The fixed words are written once.
  jamDeclaredLabel.textContent = JAM_COPY.declaredLabel;
  jamScaleLabel.textContent = JAM_COPY.heardLabel;
  jamComingCaption.textContent = JAM_COPY.comingUp;
  jamPaused.textContent = JAM_COPY.paused;
  jamInstrumentSwitch.setAttribute('aria-label', JAM_COPY.instrumentGroup);
  jamInstrumentPiano.textContent = JAM_COPY.piano;
  jamInstrumentGuitar.textContent = JAM_COPY.guitar;
  jamChordTonesText.textContent = JAM_COPY.chordTones;

  // The legend is built once: the four marks that always show go before the chord entry, which
  // lives in the markup (hidden) so it can be shown or hidden with the overlay.
  const legendEntry = (entry, el) => {
    el.title = entry.title;
    const mark = document.createElement('span');
    mark.className = 'jam-legend-mark';
    mark.dataset.role = entry.role;
    const word = document.createElement('span');
    word.textContent = entry.word;
    el.append(mark, word);
    return el;
  };
  const legend = legendEntries(true);
  for (const entry of legend.slice(0, -1)) {
    const el = document.createElement('span');
    el.className = 'jam-legend-entry';
    jamLegend.insertBefore(legendEntry(entry, el), jamLegendChord);
  }
  legendEntry(legend[legend.length - 1], jamLegendChord);

  // The seven chips are built once; each render writes only what differs from what is shown.
  const chips = [];
  for (let i = 0; i < DEGREE_COUNT; i++) {
    const el = document.createElement('div');
    el.className = 'jam-degree';
    el.setAttribute('role', 'listitem');
    const noteEl = document.createElement('div');
    noteEl.className = 'jam-degree-note';
    const numEl = document.createElement('div');
    numEl.className = 'jam-degree-num';
    el.append(noteEl, numEl);
    jamDegrees.append(el);
    chips.push({ el, noteEl, numEl, shown: { note: null, role: null, chord: null, degree: null, label: null } });
  }

  // The 24 piano keys are built once from the fixed geometry; each render writes only the marks
  // that changed. Positions are percentages of the piano's width, computed numbers only.
  const keys = pianoKeys().map((key) => {
    const el = document.createElement('div');
    el.className = 'jam-key';
    el.dataset.black = String(key.black);
    el.style.left = `${key.left}%`;
    el.style.width = `${key.width}%`;
    const labelEl = document.createElement('span');
    labelEl.className = 'jam-key-label';
    el.append(labelEl);
    jamPiano.append(el);
    return { key, el, labelEl, shown: { note: null, role: null, root: null, chord: null, label: null, title: '' } };
  });
  let shownPianoLabel = null;

  // The fretboard is built once too: six string rows (top row the high e), each a name gutter and
  // 13 cells (the open column, then frets 1 to 12) whose flex share follows the real fret widths,
  // then the row of fret numbers. The note, role and ring sit on the cell itself, so a cell
  // without a dot is still a note target.
  const gutterOf = (text) => {
    const el = document.createElement('span');
    el.className = 'jam-string-name';
    el.textContent = text;
    return el;
  };
  const frets = fretCells().map((cells, string) => {
    const row = document.createElement('div');
    row.className = 'jam-string';
    row.dataset.string = String(string);
    row.append(gutterOf(STRING_NAMES[string]));
    const refs = cells.map((cell) => {
      const el = document.createElement('div');
      el.className = 'jam-fret';
      el.dataset.fret = String(cell.fret);
      el.style.flex = `${fretUnits(cell.fret)} 1 0`;
      const dotEl = document.createElement('span');
      dotEl.className = 'jam-dot';
      el.append(dotEl);
      row.append(el);
      return { cell, el, dotEl, shown: { note: null, role: null, root: null, chord: null, label: null } };
    });
    jamGuitar.append(row);
    return refs;
  });
  const numbersRow = document.createElement('div');
  numbersRow.className = 'jam-fret-numbers';
  numbersRow.append(gutterOf(''));
  for (let fret = 0; fret <= 12; fret++) {
    const el = document.createElement('span');
    el.className = 'jam-fret-number';
    el.style.flex = `${fretUnits(fret)} 1 0`;
    el.textContent = FRET_NUMBERS.includes(fret) ? String(fret) : '';
    numbersRow.append(el);
  }
  jamGuitar.append(numbersRow);
  let shownGuitarLabel = null;
  let shownInstrument = null;
  let shownChordTones = null;
  let shownChordLine = null;

  jamChordTones.addEventListener('change', () => onChordTonesChange(jamChordTones.checked));

  for (const [name, button] of [['piano', jamInstrumentPiano], ['guitar', jamInstrumentGuitar]]) {
    button.addEventListener('click', () => {
      if (name !== shownInstrument) onInstrumentChange(name);
    });
  }

  let shownDeclaredOn = false;
  let shownLabelOn = null;
  let shownSource = null;
  let shownReasonOn = null;
  let shownReasonLead = null;
  let shownReasonRest = null;
  let shownDeclaredKind = null;
  let shownDeclaredText = null;
  let shownDeclaredTitle = null;
  let shownDeclaredSection = null;
  let shownName = null;
  let shownKind = null;
  let shownSub = null;
  let shownSubTitle = null;
  let shownStatusKind = null;
  let shownStatusLead = null;
  let shownStatusRest = null;
  let shownStatusTime = null;
  let shownSpokenKey = null;
  let shownStatusWarning = null;
  let shownPaused = null;
  let shownRowKeys = null;
  let rowRefs = [];
  // The model drawn last: askTarget reads the descriptors it carries, so a right-click asks about
  // exactly what was on screen.
  let lastModel = null;

  function showMessage(text, sub = null) {
    jamMessageText.textContent = text;
    if (typeof sub === 'string') {
      jamMessageSub.textContent = sub;
      jamMessageSub.hidden = false;
    } else {
      jamMessageSub.textContent = '';
      jamMessageSub.hidden = true;
    }
    jamMessage.hidden = false;
    jamBody.hidden = true;
    jamView.dataset.state = 'message';
    lastModel = null;
  }

  // The Declared line: shown with a declaration, hidden without one. The text comes from the code, so it goes
  // in as text only, and only when it changed.
  function renderDeclared(declared) {
    if (declared === undefined) throw new Error('Moontide: a ready Jam model needs its declared field (null without a declaration).');
    const on = declared !== null;
    if (on !== shownDeclaredOn) {
      jamDeclared.hidden = !on;
      shownDeclaredOn = on;
    }
    if (!on) return;
    if (declared.kind !== shownDeclaredKind) {
      jamDeclared.dataset.kind = declared.kind;
      shownDeclaredKind = declared.kind;
    }
    if (declared.text !== shownDeclaredText) {
      jamDeclaredValue.textContent = declared.text;
      shownDeclaredText = declared.text;
    }
    if (declared.title !== shownDeclaredTitle) {
      jamDeclaredValue.title = declared.title;
      shownDeclaredTitle = declared.title;
    }
  }

  // Where the scale in use came from. The Heard label shows only with a declaration and only for a scale that was heard: it
  // would be false for a proposed one. The source rides on #jam-scale for tests and the probe.
  function renderSource(declared, scaleSource) {
    if (scaleSource !== 'heard' && scaleSource !== 'proposed' && scaleSource !== 'chosen') {
      throw new Error(`Moontide: a ready Jam model needs a scale source of heard, proposed or chosen, got '${String(scaleSource)}'.`);
    }
    const labelOn = declared !== null && scaleSource === 'heard';
    if (labelOn !== shownLabelOn) {
      jamScaleLabel.hidden = !labelOn;
      shownLabelOn = labelOn;
    }
    if (scaleSource !== shownSource) {
      jamScale.dataset.source = scaleSource;
      shownSource = scaleSource;
    }
  }

  // The line that says why the scale is proposed: a lead word and one sentence, written only when they changed so the
  // polite live region reads a proposal once and never per tick. Hiding it clears both texts, so a proposal that comes back
  // later is read again.
  function renderReason(reason) {
    if (reason === undefined) throw new Error('Moontide: a ready Jam model needs its reason field (null for a scale that was heard).');
    const on = reason !== null;
    const lead = on ? reason.lead : '';
    const rest = on ? reason.rest : '';
    if (lead !== shownReasonLead) {
      jamReasonLead.textContent = lead;
      shownReasonLead = lead;
    }
    if (rest !== shownReasonRest) {
      jamReasonRest.textContent = rest;
      shownReasonRest = rest;
    }
    if (on !== shownReasonOn) {
      jamReason.hidden = !on;
      shownReasonOn = on;
    }
  }

  // The scales that fit. Pick mode draws one button per scale and exactly one is pressed; list mode draws plain items in a
  // list. The items are rebuilt only when the mode, the set of candidates or the names drawn changed; a switch of the
  // pressed scale rewrites aria-pressed in place, so the button just clicked keeps focus (and a rebuild gives focus back to
  // the button of the same scale). Each button reads its own key
  // from its closure, never from the markup, and a click on the pressed one does nothing. A choice the page refuses is said
  // once per set of candidates, not once per click.
  let shownCandidatesOn = null;
  let shownCandidatesMode = null;
  let shownCandidatesCaption = null;
  let shownCandidatesMore = null;
  let shownCandidatesKey = null;
  let candidateRefs = [];
  const choiceReportedFor = new Set();

  function chooseCandidate(setKey, ref) {
    if (ref.pressed) return;
    try {
      onScaleChoice({ setKey, key: ref.key });
    } catch (err) {
      if (!choiceReportedFor.has(setKey)) {
        choiceReportedFor.add(setKey);
        console.error('Moontide: the Jam view could not switch the scale:', err);
      }
    }
  }

  function buildCandidates(candidates) {
    // The buttons are replaced, so a focused one would be lost: note its key now and give focus to the new button of the
    // same scale (a pick can change which scale sits in the last place drawn when more than eight fit).
    const focused = candidateRefs.find((ref) => ref.el === document.activeElement);
    candidateRefs = candidates.items.map((item) => {
      const pick = candidates.mode === 'pick';
      const el = document.createElement(pick ? 'button' : 'span');
      el.className = 'jam-candidate';
      el.textContent = item.name;
      const ref = { el, key: item.key, pressed: pick && item.pressed };
      if (pick) {
        el.type = 'button';
        el.setAttribute('aria-pressed', String(item.pressed));
        el.addEventListener('click', () => chooseCandidate(candidates.setKey, ref));
      } else {
        el.setAttribute('role', 'listitem');
      }
      return ref;
    });
    if (candidates.mode === 'list') jamCandidateList.setAttribute('role', 'list');
    else jamCandidateList.removeAttribute('role');
    jamCandidateList.replaceChildren(...candidateRefs.map((ref) => ref.el));
    if (focused !== undefined) candidateRefs.find((ref) => ref.key === focused.key)?.el.focus();
  }

  function renderCandidates(candidates) {
    if (candidates === undefined) throw new Error('Moontide: a ready Jam model needs its candidates field (null for a scale that was heard).');
    const on = candidates !== null;
    if (on !== shownCandidatesOn) {
      jamCandidates.hidden = !on;
      shownCandidatesOn = on;
    }
    if (!on) return;
    if (candidates.mode !== 'pick' && candidates.mode !== 'list') {
      throw new Error(`Moontide: the Jam view cannot draw scales that fit in the mode '${String(candidates.mode)}'.`);
    }
    if (candidates.mode !== shownCandidatesMode) {
      jamCandidates.dataset.mode = candidates.mode;
      shownCandidatesMode = candidates.mode;
    }
    if (candidates.caption !== shownCandidatesCaption) {
      jamCandidatesLabel.textContent = candidates.caption;
      shownCandidatesCaption = candidates.caption;
    }
    if (candidates.more !== shownCandidatesMore) {
      jamCandidatesMore.textContent = candidates.more ?? '';
      jamCandidatesMore.hidden = candidates.more === null;
      shownCandidatesMore = candidates.more;
    }
    const listKey = [candidates.mode, candidates.setKey, ...candidates.items.map((item) => item.key)].join('\n');
    if (listKey !== shownCandidatesKey) {
      buildCandidates(candidates);
      shownCandidatesKey = listKey;
      return;
    }
    if (candidates.mode !== 'pick') return;
    candidates.items.forEach((item, i) => {
      const ref = candidateRefs[i];
      if (ref.pressed !== item.pressed) {
        ref.el.setAttribute('aria-pressed', String(item.pressed));
        ref.pressed = item.pressed;
      }
    });
  }

  // The section the Declared line speaks for: its words after the value, hidden for a piece without sections.
  function renderDeclaredSection(section) {
    if (section === undefined) throw new Error('Moontide: a ready Jam model needs its section field (null without sections).');
    if (section === shownDeclaredSection) return;
    if (section === null) {
      jamDeclaredSection.textContent = '';
      jamDeclaredSection.hidden = true;
    } else {
      jamDeclaredSection.textContent = section;
      jamDeclaredSection.hidden = false;
    }
    shownDeclaredSection = section;
  }

  function renderScale(scale, degrees) {
    if (scale.text !== shownName) {
      jamScaleName.textContent = scale.text;
      jamScaleName.title = scale.title;
      shownName = scale.text;
    }
    if (scale.kind !== shownKind) {
      jamScaleName.dataset.kind = scale.kind;
      shownKind = scale.kind;
    }
    const subTitle = scale.subTitle ?? scale.sub;
    if (scale.sub !== shownSub || subTitle !== shownSubTitle) {
      jamScaleSub.textContent = scale.sub;
      jamScaleSub.title = subTitle;
      shownSub = scale.sub;
      shownSubTitle = subTitle;
    }
    jamDegrees.hidden = degrees.length === 0;
    degrees.slice(0, DEGREE_COUNT).forEach((degree, i) => {
      const chip = chips[i];
      if (chip.shown.note !== degree.note) {
        chip.noteEl.textContent = degree.note;
        chip.el.dataset.note = degree.note;
        chip.shown.note = degree.note;
      }
      if (chip.shown.degree !== degree.degree) {
        chip.numEl.textContent = degree.degree;
        chip.shown.degree = degree.degree;
      }
      if (chip.shown.role !== degree.role) {
        chip.el.dataset.role = degree.role;
        chip.shown.role = degree.role;
      }
      if (chip.shown.chord !== degree.chord) {
        if (degree.chord) chip.el.dataset.chord = 'true';
        else delete chip.el.dataset.chord;
        chip.shown.chord = degree.chord;
      }
      if (chip.shown.label !== degree.label) {
        chip.el.setAttribute('aria-label', degree.label);
        chip.el.title = degree.label;
        chip.shown.label = degree.label;
      }
    });
  }

  // The status box. The sentence (lead and rest) is written only when it changed, so the live
  // region speaks on a chord or scale change and not on every tick; the time part changes every
  // second, is aria-hidden and repeats its text in its title. A visually hidden copy of it inside
  // the live region is written only when a warning starts, ends or changes wording.
  function renderStatus(status) {
    const off = status.kind === 'off';
    if (status.kind !== shownStatusKind) {
      jamStatus.hidden = off;
      if (off) delete jamStatus.dataset.state;
      else jamStatus.dataset.state = status.kind;
      shownStatusKind = status.kind;
    }
    const warning = status.kind === 'warning' ? status.warningIndex : null;
    if (warning !== shownStatusWarning) {
      if (warning === null) {
        jamStatus.removeAttribute('data-warning');
        jamStatus.removeAttribute('tabindex');
      } else {
        jamStatus.setAttribute('data-warning', String(warning));
        jamStatus.setAttribute('tabindex', '0');
      }
      shownStatusWarning = warning;
    }
    if (status.lead !== shownStatusLead) {
      jamStatusLead.textContent = status.lead;
      shownStatusLead = status.lead;
    }
    if (status.rest !== shownStatusRest) {
      jamStatusRest.textContent = status.rest;
      shownStatusRest = status.rest;
    }
    if (status.time !== shownStatusTime) {
      jamStatusTime.hidden = status.time === null;
      jamStatusTime.textContent = status.time ?? '';
      jamStatusTime.title = status.time ?? '';
      shownStatusTime = status.time;
    }
    const spokenKey = statusAnnounceKey(status);
    if (spokenKey !== shownSpokenKey) {
      jamStatusSpoken.textContent = status.time ?? '';
      shownSpokenKey = spokenKey;
    }
  }

  // One .jam-row: the countdown, the kind word and the text. A row with a context (a warning or a
  // part change) is focusable so the keyboard context-menu key reaches it. Texts go through
  // textContent, title and setAttribute only: a part name comes from the code.
  function buildRow(row) {
    const el = document.createElement('div');
    el.className = 'jam-row';
    const timeEl = document.createElement('div');
    timeEl.className = 'jam-row-time';
    timeEl.textContent = row.time;
    const kindEl = document.createElement('div');
    kindEl.className = 'jam-row-kind';
    kindEl.dataset.kind = row.kind;
    kindEl.textContent = row.kindWord;
    const textEl = document.createElement('div');
    textEl.className = 'jam-row-text';
    textEl.textContent = row.text;
    textEl.title = row.title;
    el.append(timeEl, kindEl, textEl);
    if (row.kind === 'warning') {
      el.setAttribute('data-warning', String(row.warningIndex));
      el.setAttribute('tabindex', '0');
    } else if (row.kind === 'part') {
      el.setAttribute('data-part', row.part.name);
      if (typeof row.part.owner === 'string') el.setAttribute('data-owner', row.part.owner);
      el.setAttribute('tabindex', '0');
    }
    return { el, timeEl, shownTime: row.time };
  }

  // The rows are rebuilt only when the list of rows changed; otherwise only the countdown cells
  // whose text changed are written, so focus and a right-click in progress are never disturbed.
  function renderRows(rows) {
    const keys = rows.map((row) => row.key).join('\n');
    if (keys !== shownRowKeys) {
      rowRefs = rows.map(buildRow);
      jamRows.replaceChildren(...rowRefs.map((ref) => ref.el));
      shownRowKeys = keys;
      return;
    }
    rows.forEach((row, i) => {
      const ref = rowRefs[i];
      if (ref.shownTime !== row.time) {
        ref.timeEl.textContent = row.time;
        ref.shownTime = row.time;
      }
    });
  }

  // The piano: each key's note, role, avoided-root ring, label and hover title, written only when changed.
  function renderInstrument(instrument) {
    const { roles, names, rootPc, chordPcs } = instrument;
    for (const ref of keys) {
      const pc = ref.key.pc;
      const note = names[pc];
      const role = roles[pc];
      const root = role === 'avoid' && pc === rootPc;
      const chord = chordPcs[pc];
      const label = keyLabel(ref.key, roles, names, chordPcs);
      if (ref.shown.note !== note) {
        ref.el.dataset.note = note;
        ref.shown.note = note;
      }
      if (ref.shown.role !== role) {
        ref.el.dataset.role = role;
        ref.shown.role = role;
      }
      if (ref.shown.root !== root) {
        if (root) ref.el.dataset.root = 'true';
        else delete ref.el.dataset.root;
        ref.shown.root = root;
      }
      if (ref.shown.chord !== chord) {
        if (chord) ref.el.dataset.chord = 'true';
        else delete ref.el.dataset.chord;
        ref.shown.chord = chord;
      }
      if (ref.shown.label !== label) {
        ref.labelEl.textContent = label;
        ref.shown.label = label;
      }
      const title = keyTitle(ref.key, roles, names, chordPcs, rootPc);
      if (ref.shown.title !== title) {
        if (title === '') ref.el.removeAttribute('title');
        else ref.el.setAttribute('title', title);
        ref.shown.title = title;
      }
    }
    if (instrument.pianoLabel !== shownPianoLabel) {
      jamPiano.setAttribute('aria-label', instrument.pianoLabel);
      shownPianoLabel = instrument.pianoLabel;
    }
    for (const row of frets) {
      for (const ref of row) {
        const pc = ref.cell.pc;
        const note = names[pc];
        const role = roles[pc];
        const root = role === 'avoid' && pc === rootPc;
        const chord = chordPcs[pc];
        const label = role === 'off' && !chord ? '' : note;
        if (ref.shown.note !== note) {
          ref.el.dataset.note = note;
          ref.shown.note = note;
        }
        if (ref.shown.role !== role) {
          ref.el.dataset.role = role;
          ref.shown.role = role;
        }
        if (ref.shown.root !== root) {
          if (root) ref.el.dataset.root = 'true';
          else delete ref.el.dataset.root;
          ref.shown.root = root;
        }
        if (ref.shown.chord !== chord) {
          if (chord) ref.el.dataset.chord = 'true';
          else delete ref.el.dataset.chord;
          ref.shown.chord = chord;
        }
        if (ref.shown.label !== label) {
          ref.dotEl.textContent = label;
          ref.shown.label = label;
        }
      }
    }
    if (instrument.guitarLabel !== shownGuitarLabel) {
      jamGuitar.setAttribute('aria-label', instrument.guitarLabel);
      shownGuitarLabel = instrument.guitarLabel;
    }
  }

  // The remembered preferences: which instrument shows and which segment is pressed. Only the
  // piano and the guitar exist; anything else is a caller bug and is said loudly.
  function setPreferences({ instrument, chordTones }) {
    if (instrument !== 'piano' && instrument !== 'guitar') {
      throw new Error(`Moontide: the Jam view cannot show an instrument called '${String(instrument)}'`);
    }
    if (chordTones !== 'on' && chordTones !== 'off') {
      throw new Error(`Moontide: the Jam view cannot take a Chord tones value of '${String(chordTones)}'`);
    }
    if (chordTones !== shownChordTones) {
      jamChordTones.checked = chordTones === 'on';
      shownChordTones = chordTones;
    }
    if (instrument === shownInstrument) return;
    jamPiano.hidden = instrument !== 'piano';
    jamGuitar.hidden = instrument !== 'guitar';
    jamInstrumentPiano.setAttribute('aria-pressed', String(instrument === 'piano'));
    jamInstrumentGuitar.setAttribute('aria-pressed', String(instrument === 'guitar'));
    shownInstrument = instrument;
  }

  // The chord line and the legend's chord entry follow the overlay: both show while the model has
  // a chord line, which it has only while Chord tones is on.
  function renderChord(chordLine) {
    const off = chordLine === null;
    if (off !== (shownChordLine === null)) {
      jamChord.hidden = off;
      jamLegendChord.hidden = off;
    }
    if (chordLine !== shownChordLine) {
      jamChord.textContent = chordLine ?? '';
      shownChordLine = chordLine;
    }
  }

  function render(model) {
    if (model.state === 'message') {
      showMessage(model.text, model.sub);
      return;
    }
    lastModel = model;
    renderDeclared(model.declared);
    renderDeclaredSection(model.section);
    renderSource(model.declared, model.scaleSource);
    renderReason(model.reason);
    renderCandidates(model.candidates);
    renderScale(model.scale, model.degrees);
    renderStatus(model.status);
    if (model.paused !== shownPaused) {
      jamPaused.hidden = !model.paused;
      shownPaused = model.paused;
    }
    renderRows(model.rows);
    renderChord(model.chordLine);
    renderInstrument(model.instrument);
    jamBody.hidden = false;
    jamMessage.hidden = true;
    jamView.dataset.state = 'ready';
  }

  /**
   * What a right-click on `element` landed on, as the descriptor page/ask.js describes, or null when it
   * landed on nothing this view answers for (the caller then uses the whole session). It reads the
   * model shown last and attaches no handler: page/main.js owns the only right-click listener and
   * decides which view answers first.
   */
  function askTarget(element) {
    if (lastModel === null || element.closest('#jam-view') === null) return null;
    // A key, a fretboard cell (its dot or its empty cell) or a degree chip: the pitch class with the role
    // and the scale shown now. The marks sit on the element itself.
    const noteEl = element.closest('.jam-key[data-note][data-role], .jam-fret[data-note][data-role], .jam-degree[data-note][data-role]');
    if (noteEl !== null) {
      return noteDescriptor({ note: noteEl.dataset.note, role: noteEl.dataset.role, scaleName: lastModel.noteScaleName });
    }
    if (element.closest('#jam-status[data-warning]') !== null) return lastModel.status.descriptor ?? null;
    // A row is found by its place in the list, which the model's rows share: a row's data-warning is the
    // warning's index in the reading, which can change under a row that keeps its key.
    const row = element.closest('.jam-row[data-warning]');
    if (row === null) return null;
    const place = Array.prototype.indexOf.call(jamRows.children, row);
    return lastModel.rows[place]?.descriptor ?? null;
  }

  return { showMessage, render, setPreferences, askTarget };
}
