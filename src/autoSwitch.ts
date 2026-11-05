/**
 * Switching away from the active account before it runs out. When the active account's 5h
 * limit reaches a threshold, the extension proposes the next accounts on its own and counts
 * down to a switch to the best of them; the user can switch at once, stop the countdown, or
 * dismiss the proposal. Plain logic and timers, so it can be tested without VS Code.
 */

import { ProposeAccount, ProposeFor, rankAccounts } from "./propose";
import { UsageSnapshot } from "./types";

export interface AutoSwitchSettings {
  enabled: boolean;
  /** 5h usage (%) from which the next accounts are proposed with a countdown */
  thresholdPercent: number;
  countdownSeconds: number;
}

/** A proposal that a new usage reading of the active account calls for. */
export interface ProposalTrigger {
  /** the limit to propose accounts for */
  kind: ProposeFor;
  /** whether to count down to a switch to the best of them */
  countdown: boolean;
}

/**
 * Compares two usage readings of the active account. A limit that ran out calls for a
 * proposal; with automatic switching on, so does the 5h limit reaching the threshold, and a
 * 5h proposal then counts down. Each crossing triggers once: a stopped countdown does not
 * come back with the next reading, and nothing triggers without a previous reading.
 */
export function proposalTrigger(
  previous: UsageSnapshot | undefined,
  next: UsageSnapshot,
  settings: AutoSwitchSettings
): ProposalTrigger | undefined {
  if (!previous) {
    return undefined;
  }
  const before = (kind: string) => previous.windows.find((w) => w.kind === kind)?.percent ?? 0;
  const crossed = (kind: string, percent: number, at: number) => percent >= at && before(kind) < at;

  const session = next.windows.find((w) => w.kind === "session");
  if (
    session &&
    (crossed("session", session.percent, 100) ||
      (settings.enabled && crossed("session", session.percent, settings.thresholdPercent)))
  ) {
    return { kind: "session", countdown: settings.enabled };
  }
  // A weekly or model limit blocks less (a model limit only that model): propose, but let the user pick.
  const ranOut = next.windows.find((w) => w.kind !== "session" && crossed(w.kind, w.percent, 100));
  if (ranOut) {
    return { kind: ranOut.kind.startsWith("weekly_") ? (ranOut.kind as ProposeFor) : "session", countdown: false };
  }
  return undefined;
}

/**
 * Where an automatic switch can go, best first: the accounts for `kind` other than the active
 * one, below the threshold (one above it would soon need a switch itself), skipping accounts
 * in use in another window (the switch would be refused).
 */
export function autoSwitchTargets(
  accounts: ProposeAccount[],
  kind: ProposeFor,
  activeId: string,
  thresholdPercent: number,
  inUseElsewhere: (id: string) => boolean,
  now = Date.now()
): ProposeAccount[] {
  return rankAccounts(accounts, kind, now).filter(
    (a) =>
      a.id !== activeId &&
      a.windows.some((w) => w.kind === kind && w.percent < thresholdPercent) &&
      !inUseElsewhere(a.id)
  );
}

export interface Countdown {
  targetId: string;
  seconds: number;
  /** when the switch happens (epoch ms) */
  deadline: number;
}

/** A proposal the extension opened on its own, about the active account. */
export interface AutoProposal {
  /** new for every proposal, so the panel opens each one once */
  id: number;
  /** the active account it is about; it closes once another account is active */
  fromId: string;
  kind: ProposeFor;
  /** the switch it counts down to, while the countdown runs */
  countdown?: Countdown;
}

export interface PendingSwitch {
  fromId: string;
  kind: ProposeFor;
  targetId: string;
}

/**
 * The proposal the extension opens on its own and the countdown that may come with it. One
 * at a time: a new proposal replaces the old one. `onSwitch` runs when the countdown ends
 * (or on Switch now); `onChange` whenever the proposal or its countdown changes.
 */
export class AutoProposals {
  private current: AutoProposal | undefined;
  private timer: NodeJS.Timeout | undefined;
  private lastId = 0;

  constructor(
    private readonly onSwitch: (pending: PendingSwitch) => void,
    private readonly onChange: (proposal: AutoProposal | undefined) => void
  ) {}

  get(): AutoProposal | undefined {
    return this.current;
  }

  open(fromId: string, kind: ProposeFor, countdown?: { targetId: string; seconds: number }, now = Date.now()): void {
    this.clearTimer();
    this.current = {
      id: ++this.lastId,
      fromId,
      kind,
      countdown: countdown && { ...countdown, deadline: now + Math.max(0, countdown.seconds) * 1000 },
    };
    if (this.current.countdown) {
      this.timer = setTimeout(() => this.switchNow(), Math.max(0, this.current.countdown.deadline - now));
    }
    this.onChange(this.current);
  }

  /** Switches without waiting for the countdown to end. */
  switchNow(): void {
    const proposal = this.current;
    if (!proposal?.countdown) {
      return;
    }
    this.stopCountdown();
    this.onSwitch({ fromId: proposal.fromId, kind: proposal.kind, targetId: proposal.countdown.targetId });
  }

  /** Points the running countdown at another account (the target can no longer be used), keeping its deadline. */
  retarget(targetId: string): void {
    if (!this.current?.countdown) {
      return;
    }
    this.current = { ...this.current, countdown: { ...this.current.countdown, targetId } };
    this.onChange(this.current);
  }

  /** Stops the countdown; the proposal stays open for a choice by hand. */
  stopCountdown(): void {
    if (!this.current?.countdown) {
      return;
    }
    this.clearTimer();
    this.current = { ...this.current, countdown: undefined };
    this.onChange(this.current);
  }

  close(): void {
    if (!this.current) {
      return;
    }
    this.clearTimer();
    this.current = undefined;
    this.onChange(undefined);
  }

  /** Closes the proposal once another account is active: it was about leaving the previous one. */
  activeChanged(activeId: string | undefined): void {
    if (this.current && this.current.fromId !== activeId) {
      this.close();
    }
  }

  dispose(): void {
    this.clearTimer();
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }
}
