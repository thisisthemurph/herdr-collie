# 0007 · The mod starts the controller

Status: accepted, 2026-11-09

## Decision

When the Collie mod loads and finds no live `controller.lock`, it starts the controller
with `hc run`, labelled `collie.role=controller`. There is no separate install step.

## Consequences

- Opening Herdr is enough to use Collie.
- The controller runs in an hc terminal, so agents it starts must use `--no-parent`
  (`docs/spike.md` 3b): by default a child dies with its parent, and agents must survive a
  controller restart. `--no-notify` keeps hc from typing notes into the controller's
  terminal.
- The lock (pid and start time) stops a second controller from starting.

## Alternative

A manual command or a login item: works without Herdr open, but needs setup.
