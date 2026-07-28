import type { ConvInfo } from './types';

export type Activity = ConvInfo['activity'];

/**
 * How much a state wants the user's attention. Only used to fold a collapsed
 * task row down to one indicator; individual rows render their own state.
 */
const ATTENTION: Record<Activity, number> = {
  awaiting_input: 3,
  working: 2,
  idle: 1,
  unknown: 0,
};

/**
 * The state a collapsed group should show: the most attention-worthy one
 * among its members.
 *
 * "Blocked on you" has to win over "working" — a task with four agents where
 * one is stuck at a permission prompt is a task that needs you, and hiding
 * that behind three busy siblings is the whole reason the indicator exists.
 */
export function rollUpActivity(members: readonly ConvInfo[]): Activity {
  let winner: Activity = 'unknown';
  for (const m of members) {
    if (ATTENTION[m.activity] > ATTENTION[winner]) winner = m.activity;
  }
  return winner;
}

/**
 * Modifier class for a row or dot. Only `working` gets marked — it dims so the
 * agent recedes. Everything else (idle / awaiting_input / unknown) keeps the
 * resting appearance; awaiting_input earns attention by refusing to dim,
 * standing out against a row of dimmed working siblings.
 */
export function activityClass(activity: Activity): string {
  return activity === 'working' ? 'busy' : '';
}
