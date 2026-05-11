module RuntimeLifecycle {
  type Status = Idle | Running | Failed | Blocked
  type Event = Start | Complete | Fail | Reset | Block | Resume

  pure def terminal(s: Status): bool =
    s == Failed

  pure def step(s: Status, e: Event): Status =
    if (s == Idle and e == Start) Running
    else if (s == Running and e == Complete) Idle
    else if (s == Running and e == Fail) Failed
    else if (s == Running and e == Block) Blocked
    else if (s == Blocked and e == Resume) Running
    else if (e == Reset) Idle
    else s

  pure def errorRecorded(s: Status, e: Event): bool =
    e == Fail and step(s, e) == Failed

  pure def diffCaptured(s: Status, e: Event): bool =
    s == Running and e == Complete and step(s, e) == Idle

  pure def invariant_failed_turn_records_error(s: Status, e: Event): bool =
    step(s, e) == Failed implies errorRecorded(s, e)

  pure def invariant_successful_turn_captures_diff(s: Status, e: Event): bool =
    (s == Running and e == Complete) implies diffCaptured(s, e)

  pure def invariant_reset_clears_runtime_status(s: Status): bool =
    step(s, Reset) == Idle

  pure def invariant_blocked_can_resume(s: Status): bool =
    step(step(s, Block), Resume) != Blocked
}
