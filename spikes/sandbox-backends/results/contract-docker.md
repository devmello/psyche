# Contract check: docker, profile none (2026-10-19 02:01)

| check | result | detail |
|---|---|---|
| start (profile none) | PASS | 8033 ms to detached |
| runs as UID 1000 | PASS | uid=1000 gid=1000 |
| all capabilities dropped | PASS | CapEff=0000000000000000 |
| no setuid/setgid binaries | PASS | 0 found |
| 20 bounded commands | PASS | 20/20 exit 0; total 7385 ms, mean 369 ms, slowest 663 ms |
| 1 MiB stdout through exec | PASS | 1048576 bytes |
| timeout bound (3 s) | PASS | exit 124 after 3462 ms |
| interrupt: signal host exec client | INFO | SIGTERM: client exited, process KEEPS RUNNING; SIGKILL: client exited, process KEEPS RUNNING |
| interrupt: kill process group via exec | PASS | client exit 15, 320 ms to stop, 0 sleep processes left |
| files persist across restart | PASS | sha e33e0c3e11ed3cb4 -> e33e0c3e11ed3cb4; stop+start+exec 15599 ms |
| tmp is wiped on restart | INFO | 0 entries in /tmp after restart |
| network none | PASS | interfaces: lo ; curl and DNS fail |
| rootfs writes outside /workspace fail | PASS | checked  |
| tmp capped at 64 MB | PASS | an 80 MB write stopped at 64 MB |
| memory cap 512 MB | PASS | 700 MB allocation exit 137 (137 = OOM kill) |
| pids cap 128 | PASS | 99 of 200 background processes started |
| cpu cap 1 | INFO | 100000 100000 10 (cpu.max quota/period, nproc) |

Failures: 0
