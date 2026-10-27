# Measurements: docker (2026-10-19 01:31)

Host: 27.0.1 on Apple M5, 16 GB.
Backend: Docker 29.4.0 on OrbStack.

| metric | value |
|---|---|
| cold: backend start | median 487 ms (min 482, p90 708, n 3) |
| cold: backend start + first container + first command | median 928 ms (min 915, p90 1203, n 3) |
| warm: run -d + first exec (new container) | median 126 ms (min 113, p90 145, n 10) |
| warm: one-shot run --rm true | median 156 ms (min 105, p90 351, n 10) |
| stop (with --init) | median 46 ms (min 42, p90 48, n 5) |
| restart: start stopped container + first exec | median 93 ms (min 84, p90 104, n 5) |
| exec round trip (exec true) | median 34 ms (min 32, p90 41, n 20) |
| exec round trip via runner wrapper (timeout + bash -c) | median 37 ms (min 34, p90 44, n 20) |
| host -> workspace volume via `docker cp` | 421 MB/s (475 ms) |
| host -> workspace volume via `exec -i` stdin stream | 746 MB/s (268 ms) |
| host -> workspace via read-only bind mount (cp inside) | 408 MB/s (490 ms) |
| workspace -> host via rw bind mount (cp inside) | 1143 MB/s (175 ms) |
| owner on host of a file written by UID 1000 | devmello:staff |
| within workspace volume (cp inside, baseline) | 5000 MB/s (40 ms) |
| memory (RSS): backend VM, no container | 1240 MB (pid 30568) |
| memory (RSS): backend VM with one container, idle | 553 MB |
| memory (RSS): while the container holds 400 MB | 699 MB |
| memory (RSS): 20 s after the 400 MB was freed | 183 MB |
