import assert from 'node:assert/strict';
import { test } from 'node:test';
import { load, orderedSaved, removeSaved, savedOfKind, upsertSaved } from './store.ts';

const mem = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
};

const P = (name: string, lat: number) => ({ name, address: `${name} St`, lat, lng: -122.4 });

test('v0.1 saved places migrate to kinds with ids', () => {
  mem.set('fareview:v1', JSON.stringify({ saved: [{ ...P('A', 1), label: 'home' }, { ...P('B', 2), label: 'Gym' }] }));
  const d = load();
  assert.equal(d.saved[0].kind, 'home');
  assert.equal(d.saved[1].kind, 'other');
  assert.ok(d.saved.every((s) => s.id));
});

test('only one Home: saving a new Home replaces the old one', () => {
  mem.clear();
  const d = load();
  upsertSaved(d, { ...P('Old', 1), id: 'a', kind: 'home', label: '' });
  upsertSaved(d, { ...P('Gym', 2), id: 'b', kind: 'other', label: '  Gym ' });
  upsertSaved(d, { ...P('New', 3), id: 'c', kind: 'home', label: 'ignored' });
  assert.equal(d.saved.length, 2);
  assert.equal(savedOfKind(d, 'home')?.name, 'New');
  assert.equal(savedOfKind(d, 'home')?.label, 'Home');
  assert.equal(d.saved.find((s) => s.id === 'b')?.label, 'Gym');
});

test('editing keeps position; Home and Work sort first', () => {
  mem.clear();
  const d = load();
  upsertSaved(d, { ...P('Gym', 1), id: 'g', kind: 'other', label: 'Gym' });
  upsertSaved(d, { ...P('Office', 2), id: 'w', kind: 'work', label: '' });
  upsertSaved(d, { ...P('Gym2', 3), id: 'g', kind: 'other', label: 'Climbing gym' });
  assert.deepEqual(orderedSaved(d).map((s) => s.label), ['Work', 'Climbing gym']);
  // Changing an "other" into Work replaces the existing Work.
  upsertSaved(d, { ...P('Gym2', 3), id: 'g', kind: 'work', label: '' });
  assert.deepEqual(d.saved.map((s) => s.id), ['g']);
  removeSaved(d, 'g');
  assert.equal(d.saved.length, 0);
});
