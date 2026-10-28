import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  getInProgressStatus,
  getOpenStatus,
  getPendingStatus,
  isActiveImplementationStatus,
} from '../taskStatus';
import { Config } from '../types';

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    provider: 'clickup',
    clickupPendingStatus: 'waiting',
    clickupOpenStatus: 'to do',
    ...overrides,
  } as Config;
}

describe('taskStatus', () => {
  it('resolves provider-specific open and pending statuses', () => {
    const config = makeConfig();
    assert.equal(getOpenStatus(config), 'to do');
    assert.equal(getPendingStatus(config), 'waiting');
    assert.equal(getInProgressStatus(config), 'in progress');
  });

  it('treats only open, pending, and in progress as active implementation statuses', () => {
    const config = makeConfig();
    assert.equal(isActiveImplementationStatus('to do', config), true);
    assert.equal(isActiveImplementationStatus('waiting', config), true);
    assert.equal(isActiveImplementationStatus('in progress', config), true);
    assert.equal(isActiveImplementationStatus('review', config), false);
  });
});

describe('taskStatus — agenda provider', () => {
  it('uses the AGenda pending / in-review statuses and "open" for open', () => {
    const config = makeConfig({
      provider: 'agenda',
      agendaPendingStatus: 'Pending',
      agendaInReviewStatus: 'In Review',
    });
    assert.equal(getOpenStatus(config), 'open');
    assert.equal(getPendingStatus(config), 'Pending');
    assert.equal(getInProgressStatus(config), 'in progress');
    assert.equal(isActiveImplementationStatus('Pending', config), true);
    assert.equal(isActiveImplementationStatus('needs input', config), false);
  });
});
