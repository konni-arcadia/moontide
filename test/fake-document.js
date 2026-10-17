// A small fake document shared by the tests of the page's view code (the Song grid and the Mixer), so those tests run without
// a browser. It supports attributes, data attributes, children and their order, listeners, focus and the simple selectors the
// views use (a tag, classes, an id and attribute tests joined with no space, separated by commas). A node can hold a pointer
// (setPointerCapture) and dispatches pointer and key events with the fields a real one carries. It counts writes, on the
// document and on each node, so a test can prove that drawing the same model again writes nothing. The live pages in real
// Chrome are proved by `npm run probe:page`; these fakes pin structure, ARIA and what a rebuild keeps.

/** `dataFooBar` to `data-foo-bar`. */
function dataAttribute(name) {
  return `data-${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
}

/** The `[name]` and `[name="value"]` tests, classes, id and tag of one compound selector (no spaces, no combinators). */
function parseCompound(text) {
  const parts = { tag: null, id: null, classes: [], attributes: [] };
  const pattern = /^(?:([a-zA-Z][a-zA-Z0-9-]*)|#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:="([^"]*)")?\])/;
  let rest = text.trim();
  if (rest === '') throw new Error('Moontide fake document: an empty selector.');
  while (rest !== '') {
    const match = pattern.exec(rest);
    if (match === null) throw new Error(`Moontide fake document: the selector '${text}' is not supported.`);
    if (match[1] !== undefined) parts.tag = match[1].toLowerCase();
    else if (match[2] !== undefined) parts.id = match[2];
    else if (match[3] !== undefined) parts.classes.push(match[3]);
    else parts.attributes.push([match[4], match[5] ?? null]);
    rest = rest.slice(match[0].length);
  }
  return parts;
}

/** True when `node` matches one of the comma-separated compound selectors of `selector`. */
function matches(node, selector) {
  return selector.split(',').some((text) => {
    const parts = parseCompound(text);
    if (parts.tag !== null && node.tagName.toLowerCase() !== parts.tag) return false;
    if (parts.id !== null && node.id !== parts.id) return false;
    if (!parts.classes.every((name) => node.className.split(' ').includes(name))) return false;
    return parts.attributes.every(([name, value]) => {
      const own = node.getAttribute(name);
      return value === null ? own !== null : own === value;
    });
  });
}

export function fakeDocument() {
  const doc = { created: 0, activeElement: null, writes: 0, documentElement: { clientWidth: 1000, clientHeight: 800 }, listeners: new Map(), markup: [] };
  doc.createElement = (tagName) => {
    doc.created += 1;
    return fakeNode(tagName, doc);
  };
  doc.addEventListener = (type, fn) => doc.listeners.set(type, [...(doc.listeners.get(type) ?? []), fn]);
  // A press somewhere in the page, as the document hears it.
  doc.dispatch = (type, event) => (doc.listeners.get(type) ?? []).forEach((fn) => fn({ type, ...event }));
  // The element with this id among the trees in `markup` (the roots a test registers), in document order, else null.
  doc.getElementById = (id) => {
    const work = [...doc.markup].reverse();
    while (work.length > 0) {
      const node = work.pop();
      if (node.id === id) return node;
      for (let i = node.children.length - 1; i >= 0; i--) work.push(node.children[i]);
    }
    return null;
  };
  doc.defaultView = { getComputedStyle: () => ({ paddingLeft: '0px', paddingRight: '0px', paddingTop: '0px', paddingBottom: '0px' }) };
  return doc;
}

export function fakeNode(tagName, doc) {
  let own = '';
  const listeners = new Map();
  const node = {
    tagName,
    className: '',
    id: '',
    children: [],
    parentNode: null,
    attributes: new Map(),
    scrollLeft: 0,
    scrollTop: 0,
    clientLeft: 0,
    clientWidth: 0,
    scrolledIntoView: 0,
    rect: { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 },
    replaced: 0,
    focused: 0,
    // The pointer a node holds (setPointerCapture), or null; `captures` counts how many times one was taken.
    capturedPointer: null,
    captures: 0,
    // Writes to this node alone: text, attributes and what a test counts as a write.
    writes: 0,
    style: {
      props: new Map(),
      width: '',
      opacity: '',
      setProperty(name, value) {
        node.style.props.set(name, value);
      },
    },
    get hidden() {
      return node.attributes.has('hidden');
    },
    set hidden(value) {
      if (value) node.attributes.set('hidden', '');
      else node.attributes.delete('hidden');
    },
    get classList() {
      return { contains: (name) => node.className.split(' ').includes(name) };
    },
    // `dataset.fooBar` reads and writes the `data-foo-bar` attribute.
    dataset: new Proxy(
      {},
      {
        get: (_, name) => (typeof name === 'string' && node.attributes.has(dataAttribute(name)) ? node.attributes.get(dataAttribute(name)) : undefined),
        set: (_, name, value) => {
          node.setAttribute(dataAttribute(name), value);
          return true;
        },
        deleteProperty: (_, name) => {
          node.removeAttribute(dataAttribute(name));
          return true;
        },
        has: (_, name) => typeof name === 'string' && node.attributes.has(dataAttribute(name)),
      },
    ),
    get textContent() {
      return own + node.children.map((child) => child.textContent).join('');
    },
    set textContent(value) {
      doc.writes += 1;
      node.writes += 1;
      own = String(value);
      node.children.forEach((child) => (child.parentNode = null));
      node.children = [];
    },
    get firstChild() {
      return node.children[0] ?? null;
    },
    get nextSibling() {
      if (node.parentNode === null) return null;
      const siblings = node.parentNode.children;
      return siblings[siblings.indexOf(node) + 1] ?? null;
    },
    appendChild(child) {
      if (child.parentNode !== null) child.remove();
      child.parentNode = node;
      node.children.push(child);
      return child;
    },
    append(...nodes) {
      nodes.forEach((child) => node.appendChild(child));
    },
    // The real insertBefore moves a node that already has a parent; null puts it last.
    insertBefore(child, reference) {
      if (reference !== null && reference.parentNode !== node) throw new Error('Moontide fake document: insertBefore with a reference that is not a child.');
      if (child === reference) return child;
      if (child.parentNode !== null) child.remove();
      child.parentNode = node;
      if (reference === null) node.children.push(child);
      else node.children.splice(node.children.indexOf(reference), 0, child);
      return child;
    },
    remove() {
      if (node.parentNode === null) return;
      const siblings = node.parentNode.children;
      siblings.splice(siblings.indexOf(node), 1);
      node.parentNode = null;
    },
    contains(other) {
      for (let at = other; at !== null && at !== undefined; at = at.parentNode) if (at === node) return true;
      return false;
    },
    replaceChildren(...nodes) {
      node.replaced += 1;
      own = '';
      node.children.forEach((child) => (child.parentNode = null));
      node.children = [];
      nodes.forEach((child) => node.appendChild(child));
    },
    setAttribute(name, value) {
      doc.writes += 1;
      node.writes += 1;
      node.attributes.set(name, String(value));
    },
    getAttribute(name) {
      return node.attributes.has(name) ? node.attributes.get(name) : null;
    },
    hasAttribute(name) {
      return node.attributes.has(name);
    },
    removeAttribute(name) {
      doc.writes += 1;
      node.writes += 1;
      node.attributes.delete(name);
    },
    // Like the real one: with `force`, the attribute is there (or not); a call that changes nothing writes nothing.
    toggleAttribute(name, force) {
      const wanted = force === undefined ? !node.attributes.has(name) : Boolean(force);
      if (wanted !== node.attributes.has(name)) {
        doc.writes += 1;
        node.writes += 1;
        if (wanted) node.attributes.set(name, '');
        else node.attributes.delete(name);
      }
      return wanted;
    },
    addEventListener(type, fn) {
      listeners.set(type, [...(listeners.get(type) ?? []), fn]);
    },
    // An event as a listener gets it. Pointer and key events carry what a real one does (`pointerId`, `clientX`, `clientY`,
    // `button`, `ctrlKey`, `metaKey`, `altKey`, `shiftKey`, `repeat`, `key`); the ones a test leaves out are the plain
    // values of a primary press or a first key press.
    dispatch(type, event = {}) {
      const full = {
        type,
        target: node,
        defaultPrevented: false,
        stopped: false,
        button: 0,
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        shiftKey: false,
        repeat: false,
        preventDefault() {
          full.defaultPrevented = true;
        },
        stopPropagation() {
          full.stopped = true;
        },
        ...event,
      };
      for (const fn of listeners.get(type) ?? []) fn(full);
      return full;
    },
    setPointerCapture(pointerId) {
      node.capturedPointer = pointerId;
      node.captures += 1;
    },
    releasePointerCapture(pointerId) {
      if (node.capturedPointer === pointerId) node.capturedPointer = null;
    },
    hasPointerCapture(pointerId) {
      return node.capturedPointer === pointerId;
    },
    focus() {
      node.focused += 1;
      doc.activeElement = node;
      // A real focus event bubbles to the table as focusin.
      let top = node;
      while (top.parentNode) top = top.parentNode;
      const fire = (from) => {
        for (const fn of (from.listenersFor?.('focusin') ?? [])) fn({ type: 'focusin', target: node });
        from.children.forEach(fire);
      };
      fire(top);
    },
    listenersFor(type) {
      return listeners.get(type) ?? [];
    },
    scrollIntoView() {
      node.scrolledIntoView += 1;
    },
    getBoundingClientRect() {
      return node.rect;
    },
    // Every node below this one that matches the selector, in document order.
    querySelectorAll(selector) {
      const found = [];
      const work = [...node.children].reverse();
      while (work.length > 0) {
        const next = work.pop();
        if (matches(next, selector)) found.push(next);
        for (let i = next.children.length - 1; i >= 0; i--) work.push(next.children[i]);
      }
      return found;
    },
    querySelector(selector) {
      return node.querySelectorAll(selector)[0] ?? null;
    },
    // The nearest node, this one first, that matches the selector, else null.
    closest(selector) {
      for (let at = node; at !== null; at = at.parentNode) if (matches(at, selector)) return at;
      return null;
    },
  };
  return node;
}

/** Every node below `node` (and `node` itself) with this class, in document order. */
export function all(node, className) {
  const found = node.className.split(' ').includes(className) ? [node] : [];
  for (const child of node.children) found.push(...all(child, className));
  return found;
}
