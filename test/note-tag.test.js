import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_REPORTED_FAILURES, installNoteTag, subscribe } from '../page/note-tag.js';

const isMoontide = (err) => err instanceof Error && err.message.startsWith('Moontide:');

/** A note of the fake Strudel: a value, a context, and the same setContext the real one has. */
class FakeHap {
  constructor(value, context = {}) {
    this.value = value;
    this.context = context;
  }

  setContext(context) {
    return new FakeHap(this.value, context);
  }
}

/**
 * A fake of the part of Strudel the tag touches, shaped like the pinned one: a pattern makes notes,
 * withHap maps them, and onTrigger puts a trigger on each note that runs after the trigger the note
 * already had, and keeps a dominant trigger dominant. The scheduler's rule is `fire`: the default
 * output plays unless the note carries a dominant trigger, then the note's trigger runs.
 */
function makeFakeStrudel() {
  class Pattern {
    constructor(notes) {
      this.notes = notes;
    }

    withHap(fn) {
      return new Pattern(this.notes.map((hap) => fn(hap)));
    }

    onTrigger(fn, dominant = true) {
      return this.withHap((hap) =>
        hap.setContext({
          ...hap.context,
          onTrigger: (...args) => {
            hap.context.onTrigger?.(...args);
            fn(...args);
          },
          dominantTrigger: hap.context.dominantTrigger || dominant,
        }),
      );
    }
  }
  const sound = [];
  const registered = {};
  let assignments = 0;
  // The repl assigns a new p at the start of every evaluation; a label that starts or ends with an
  // underscore is silenced, and a counter is appended to a label with a dollar sign.
  function assignRepl() {
    assignments += 1;
    let counter = 0;
    Pattern.prototype.p = function replP(id) {
      if (typeof id === 'string' && (id.startsWith('_') || id.endsWith('_'))) return null;
      if (id.includes('$')) id = `${id}${counter++}`;
      registered[id] = this;
      return this;
    };
  }
  function fire(hap, target = 1) {
    if (!hap.context.onTrigger || !hap.context.dominantTrigger) sound.push(hap.value);
    hap.context.onTrigger?.(hap, 0, 1, target);
  }
  return { Pattern, sound, registered, assignRepl, fire, assignments: () => assignments };
}

const noStamp = () => null;

/** Installs a tag on a fresh fake, starts an evaluation, and collects the events. */
function setup(stampOf = noStamp) {
  const fake = makeFakeStrudel();
  installNoteTag(fake.Pattern, { stampOf });
  fake.assignRepl();
  const events = [];
  const stop = subscribe((event) => events.push(event));
  return { ...fake, events, stop };
}

const notesOf = (...values) => values.map((value) => new FakeHap(value));

test('the tag refuses loudly without a Pattern, its withHap or onTrigger, or a stampOf, and a second time', () => {
  for (const bad of [undefined, {}, class NoMethods {}, class OnlyWithHap { withHap() {} }, class OnlyOnTrigger { onTrigger() {} }]) {
    assert.throws(() => installNoteTag(bad, { stampOf: noStamp }), isMoontide);
  }
  const fake = makeFakeStrudel();
  for (const bad of [undefined, {}, { stampOf: 5 }]) assert.throws(() => installNoteTag(fake.Pattern, bad), isMoontide);
  assert.equal(Object.getOwnPropertyDescriptor(fake.Pattern.prototype, 'p'), undefined, 'a refused install changes nothing');
  installNoteTag(fake.Pattern, { stampOf: noStamp });
  assert.throws(() => installNoteTag(fake.Pattern, { stampOf: noStamp }), (err) => isMoontide(err) && /already installed/.test(err.message));
});

test('p becomes an accessor that always hands out the same wrapper, and a labeled statement before the repl set p throws', () => {
  const fake = makeFakeStrudel();
  installNoteTag(fake.Pattern, { stampOf: noStamp });
  const descriptor = Object.getOwnPropertyDescriptor(fake.Pattern.prototype, 'p');
  assert.equal(typeof descriptor.get, 'function');
  assert.equal(typeof descriptor.set, 'function');
  assert.equal(descriptor.configurable, true);
  assert.equal(fake.Pattern.prototype.p, fake.Pattern.prototype.p);
  assert.throws(() => new fake.Pattern([]).p('t1'), (err) => isMoontide(err) && /labeled/.test(err.message));
  assert.throws(() => new fake.Pattern([]).p('_t1'), isMoontide, 'also for a label the repl would silence');
});

test('a p that was already set before the install is kept and called', () => {
  const fake = makeFakeStrudel();
  fake.assignRepl();
  const first = fake.Pattern.prototype.p;
  installNoteTag(fake.Pattern, { stampOf: noStamp });
  const wrapper = fake.Pattern.prototype.p;
  assert.notEqual(wrapper, first);
  const events = [];
  const stop = subscribe((event) => events.push(event));
  const pattern = new fake.Pattern(notesOf('a'));
  assert.ok(wrapper.call(pattern, 't1'));
  assert.equal(fake.registered.t1.notes.length, 1);
  stop();
});

test('the newest p the repl assigns is the one called, after several evaluations', () => {
  const fake = makeFakeStrudel();
  installNoteTag(fake.Pattern, { stampOf: noStamp });
  const calls = [];
  for (let evaluation = 1; evaluation <= 3; evaluation++) {
    fake.Pattern.prototype.p = function newest(id) {
      calls.push([evaluation, id]);
      return this;
    };
    new fake.Pattern([]).p('t1');
  }
  assert.deepEqual(calls, [[1, 't1'], [2, 't1'], [3, 't1']]);
  assert.equal(typeof Object.getOwnPropertyDescriptor(fake.Pattern.prototype, 'p').get, 'function', 'still an accessor');
});

test('every note of a labeled track is reported once with its key, its target and no stamp', () => {
  const s = setup();
  const pattern = new s.Pattern(notesOf('a', 'b', 'c')).p('t1');
  assert.equal(pattern, s.registered.t1);
  s.registered.t1.notes.forEach((hap, index) => s.fire(hap, 10 + index));
  assert.deepEqual(s.events.map((event) => event.key), ['label:t1', 'label:t1', 'label:t1']);
  assert.deepEqual(s.events.map((event) => event.target), [10, 11, 12]);
  assert.deepEqual(s.events.map((event) => event.hap.value), ['a', 'b', 'c']);
  assert.ok(s.events.every((event) => event.stamp === null));
  s.stop();
});

test('the browser sound still plays: the tag changes no sound', () => {
  const s = setup();
  new s.Pattern(notesOf('a', 'b')).p('t1');
  for (const hap of s.registered.t1.notes) s.fire(hap);
  assert.deepEqual(s.sound, ['a', 'b']);
  s.stop();
});

test('a note that already carries a dominant trigger keeps it dominant: no browser sound, and still reported', () => {
  const s = setup();
  const sent = [];
  new s.Pattern(notesOf('a')).onTrigger((hap) => sent.push(hap.value)).p('midi');
  s.fire(s.registered.midi.notes[0]);
  assert.deepEqual(sent, ['a'], 'the trigger the note had ran');
  assert.deepEqual(s.sound, [], 'and stayed dominant, so there is no browser sound');
  assert.deepEqual(s.events.map((event) => event.key), ['label:midi']);
  s.stop();
});

test('the trigger the note already had runs before the observer, so a stamp it records is there to read', () => {
  const stamps = new WeakMap();
  const s = setup((hap) => stamps.get(hap) ?? null);
  new s.Pattern(notesOf('a')).onTrigger((hap) => stamps.set(hap, 1234.5)).p('midi');
  s.fire(s.registered.midi.notes[0]);
  assert.equal(s.events.length, 1);
  assert.equal(s.events[0].stamp, 1234.5);
  s.stop();
});

test('the stamp is a number or null: anything else is reported as null', () => {
  for (const [given, expected] of [[12.5, 12.5], [0, 0], [null, null], [undefined, null], ['5', null], [NaN, null], [Infinity, null]]) {
    const s = setup(() => given);
    new s.Pattern(notesOf('a')).p('t1');
    s.fire(s.registered.t1.notes[0]);
    assert.equal(s.events[0].stamp, expected, String(given));
    s.stop();
  }
});

test('a label that starts or ends with an underscore is never reported, a solo label and a plain one share a key', () => {
  const s = setup();
  for (const label of ['_t1', 't1_', '_t1_']) {
    const result = new s.Pattern(notesOf('a')).p(label);
    assert.equal(result, null, `${label} is silenced by the repl`);
  }
  new s.Pattern(notesOf('a')).p('t1');
  new s.Pattern(notesOf('b')).p('S_t1');
  for (const label of ['t1', 'S_t1']) s.fire(s.registered[label].notes[0]);
  assert.deepEqual(s.events.map((event) => event.key), ['label:t1', 'label:t1']);
  s.stop();
});

test('a label the Mixer cannot rewrite is reported under its raw text', () => {
  const s = setup();
  new s.Pattern(notesOf('a')).p('9lives');
  s.fire(s.registered['9lives'].notes[0]);
  assert.deepEqual(s.events.map((event) => event.key), ['label:9lives']);
  s.stop();
});

test('$ statements are reported as $0, $1 in code order; a muted one is not counted; the next evaluation counts from 0 again', () => {
  const s = setup();
  new s.Pattern(notesOf('a')).p('$');
  new s.Pattern(notesOf('b')).p('_$');
  new s.Pattern(notesOf('c')).p('$');
  s.fire(s.registered.$0.notes[0]);
  s.fire(s.registered.$1.notes[0]);
  assert.deepEqual(s.events.map((event) => event.key), ['$0', '$1']);
  s.events.length = 0;
  s.assignRepl();
  new s.Pattern(notesOf('d')).p('$');
  s.fire(s.registered.$0.notes[0]);
  assert.deepEqual(s.events.map((event) => event.key), ['$0'], 'restarted at the new evaluation');
  s.stop();
});

test('a pattern tagged twice is reported once, under the outer label', () => {
  const s = setup();
  const inner = new s.Pattern(notesOf('a')).p('inner');
  inner.p('outer');
  s.fire(s.registered.outer.notes[0]);
  assert.deepEqual(s.events.map((event) => event.key), ['label:outer']);
  // The same label twice is one report too.
  s.events.length = 0;
  new s.Pattern(notesOf('b')).p('same').p('same');
  s.fire(s.registered.same.notes[0]);
  assert.deepEqual(s.events.map((event) => event.key), ['label:same']);
  s.stop();
});

test('a note without a track key is not reported', () => {
  const s = setup();
  new s.Pattern(notesOf('a')).p('t1');
  const stranger = new FakeHap('x', { onTrigger: () => {}, dominantTrigger: false });
  const observer = s.registered.t1.notes[0].context.onTrigger;
  observer(stranger, 0, 1, 5);
  observer(null, 0, 1, 5);
  assert.deepEqual(s.events, []);
  s.stop();
});

test('a subscriber that throws never breaks a note: the next one runs, the sound plays, and the error is reported once', () => {
  const s = setup();
  s.stop();
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args);
  const received = [];
  const stopBad = subscribe(() => {
    throw new Error('boom');
  });
  const stopGood = subscribe((event) => received.push(event.key));
  try {
    new s.Pattern(notesOf('a', 'b')).p('t1');
    for (const hap of s.registered.t1.notes) assert.doesNotThrow(() => s.fire(hap));
  } finally {
    console.error = original;
    stopBad();
    stopGood();
  }
  assert.deepEqual(received, ['label:t1', 'label:t1']);
  assert.deepEqual(s.sound, ['a', 'b']);
  assert.equal(errors.length, 1, 'once for two failing notes');
  assert.match(String(errors[0][0]), /^Moontide:/);
});

/** Runs `body` with console.error collected, and gives the collected calls. */
function collectingErrors(body) {
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args);
  try {
    body();
  } finally {
    console.error = original;
  }
  return errors;
}

test('each different listener or stamp failure is reported once, however many notes pass', () => {
  let stampFails = false;
  const s = setup(() => {
    if (stampFails) throw new Error('stamp failed');
    return null;
  });
  s.stop();
  let listenerMessage = 'a';
  const stopBad = subscribe(() => {
    throw new Error(listenerMessage);
  });
  const received = [];
  const stopGood = subscribe((event) => received.push(event.key));
  let errors;
  try {
    errors = collectingErrors(() => {
      new s.Pattern(notesOf('n1', 'n2', 'n3')).p('t1');
      for (const hap of s.registered.t1.notes) s.fire(hap);
      assert.equal(received.length, 3, 'the other listener still hears every note');
      listenerMessage = 'b';
      new s.Pattern(notesOf('n4', 'n5')).p('t2');
      for (const hap of s.registered.t2.notes) s.fire(hap);
      stampFails = true;
      new s.Pattern(notesOf('n6', 'n7')).p('t3');
      for (const hap of s.registered.t3.notes) s.fire(hap);
    });
  } finally {
    stopBad();
    stopGood();
  }
  assert.deepEqual(errors.map((call) => call[1].message), ['a', 'b', 'stamp failed']);
  assert.deepEqual(s.sound, ['n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7']);
});

test('after MAX_REPORTED_FAILURES different messages one last line says the rest are not reported, and then nothing is printed', () => {
  const s = setup();
  s.stop();
  let count = 0;
  const stopBad = subscribe(() => {
    throw new Error(`failure ${count}`);
  });
  let errors;
  try {
    errors = collectingErrors(() => {
      for (count = 0; count < MAX_REPORTED_FAILURES + 15; count++) {
        new s.Pattern(notesOf('x')).p(`t${count}`);
        s.fire(s.registered[`t${count}`].notes[0]);
      }
    });
  } finally {
    stopBad();
  }
  assert.equal(errors.length, MAX_REPORTED_FAILURES + 1);
  assert.equal(errors[MAX_REPORTED_FAILURES][0], 'Moontide: more note listener failures happened; they are not reported.');
  assert.equal(errors[MAX_REPORTED_FAILURES].length, 1);
});

test('a failure that is not an Error is reported once by its text', () => {
  const s = setup();
  s.stop();
  const stopBad = subscribe(() => {
    throw 'plain text';
  });
  let errors;
  try {
    errors = collectingErrors(() => {
      new s.Pattern(notesOf('a', 'b')).p('t1');
      for (const hap of s.registered.t1.notes) s.fire(hap);
    });
  } finally {
    stopBad();
  }
  assert.equal(errors.length, 1);
  assert.equal(errors[0][1], 'plain text');
});

test('a stampOf that throws never breaks a note: the event still arrives with a null stamp', () => {
  const s = setup(() => {
    throw new Error('no stamp');
  });
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args);
  try {
    new s.Pattern(notesOf('a')).p('t1');
    assert.doesNotThrow(() => s.fire(s.registered.t1.notes[0]));
  } finally {
    console.error = original;
  }
  assert.equal(s.events.length, 1);
  assert.equal(s.events[0].stamp, null);
  assert.equal(errors.length, 1);
  s.stop();
});

test('unsubscribe stops the events, also for a listener that unsubscribes while it runs', () => {
  const s = setup();
  new s.Pattern(notesOf('a', 'b', 'c', 'd')).p('t1');
  const [first, second, third, fourth] = s.registered.t1.notes;
  s.fire(first);
  s.stop();
  s.fire(second);
  assert.equal(s.events.length, 1);
  const seen = [];
  const stopSelf = subscribe(() => {
    seen.push('self');
    stopSelf();
  });
  const stopOther = subscribe(() => seen.push('other'));
  s.fire(third);
  s.fire(fourth);
  stopOther();
  assert.deepEqual(seen, ['self', 'other', 'other'], 'both ran for the first note; only the second for the next');
});

test('subscribe refuses a listener that is not a function', () => {
  for (const bad of [undefined, null, 5, 'a', {}]) assert.throws(() => subscribe(bad), isMoontide);
});
