#!/bin/bash
for i in $(seq 1 ${1:-40}); do echo "tick $i"; sleep 1; done
echo SLOW-DONE
