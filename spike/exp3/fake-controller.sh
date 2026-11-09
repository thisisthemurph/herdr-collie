#!/bin/bash
# Stands in for a controller running in an hc terminal: starts three child "agents" three ways, then idles.
hc run --bg --json --name spike-c-default  --label collie.spike=1 --label collie.execution=E-DEFAULT -- sleep 600
hc run --bg --json --name spike-c-outlive  --outlive-parent --label collie.spike=1 --label collie.execution=E-OUTLIVE -- sleep 600
hc run --bg --json --name spike-c-noparent --no-parent --label collie.spike=1 --label collie.execution=E-NOPARENT -- sleep 600
echo READY; sleep 600
