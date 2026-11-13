import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_REPORT_BLOCKS, trayStore, type TrayItem } from './tray';

const item = (n: number): TrayItem => ({ block_id: `b${n}`, title: `Answer ${n}`, dataset_id: 'd1', dataset_name: 'Card sales' });
const ids = (ws: string) => trayStore.get(ws).map((i) => i.block_id);

describe('report tray', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    trayStore.resetMemory();
  });
  afterEach(() => vi.restoreAllMocks());

  it('adds, ignores a duplicate, removes and reorders', () => {
    expect(trayStore.add('w1', item(1))).toBe(true);
    trayStore.add('w1', item(2));
    trayStore.add('w1', item(3));
    expect(trayStore.add('w1', item(2))).toBe(false);
    expect(ids('w1')).toEqual(['b1', 'b2', 'b3']);

    trayStore.move('w1', 'b3', -1);
    expect(ids('w1')).toEqual(['b1', 'b3', 'b2']);
    trayStore.move('w1', 'b1', -1); // already first: no change
    trayStore.move('w1', 'b2', 1); // already last: no change
    expect(ids('w1')).toEqual(['b1', 'b3', 'b2']);

    trayStore.remove('w1', 'b3');
    expect(ids('w1')).toEqual(['b1', 'b2']);
    trayStore.clear('w1');
    expect(ids('w1')).toEqual([]);
  });

  it(`holds at most ${MAX_REPORT_BLOCKS} answers`, () => {
    for (let n = 0; n < MAX_REPORT_BLOCKS; n++) expect(trayStore.add('w1', item(n))).toBe(true);
    expect(trayStore.add('w1', item(99))).toBe(false);
    expect(trayStore.get('w1')).toHaveLength(MAX_REPORT_BLOCKS);
  });

  it('keeps each workspace separate', () => {
    trayStore.add('w1', item(1));
    trayStore.add('w2', item(2));
    expect(ids('w1')).toEqual(['b1']);
    expect(ids('w2')).toEqual(['b2']);
  });

  it('survives a reload through sessionStorage', () => {
    trayStore.add('w1', item(1));
    trayStore.add('w1', item(2));
    trayStore.resetMemory(); // as after a reload
    expect(ids('w1')).toEqual(['b1', 'b2']);
  });

  it('works in memory when sessionStorage is unavailable', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(trayStore.add('w1', item(1))).toBe(true);
    trayStore.add('w1', item(2));
    trayStore.move('w1', 'b2', -1);
    expect(ids('w1')).toEqual(['b2', 'b1']);
  });

  it('notifies subscribers on every change', () => {
    const listener = vi.fn();
    const stop = trayStore.subscribe(listener);
    trayStore.add('w1', item(1));
    trayStore.remove('w1', 'b1');
    stop();
    trayStore.add('w1', item(2));
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
